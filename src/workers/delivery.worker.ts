import type { Logger } from 'pino';
import { calculateBackoffMs } from '../domain/backoff.js';
import { BridgeError, TransientDeliveryError } from '../domain/errors.js';
import { formatOutboundMessage } from '../domain/formatter.js';
import type { Channel, DeliveryJobWithMessage } from '../domain/types.js';
import type { DeliveryJobRepository } from '../persistence/repositories/delivery-job.repo.js';
import type { WhatsAppAdapter } from '../adapters/whatsapp/interface.js';
import type { EmailAdapter, EmailAttachment } from '../adapters/email/interface.js';
import type { MetricsRegistry } from '../observability/metrics.js';
import { prepareAudioAttachment } from '../domain/audio-processor.js';

export interface DeliveryWorkerConfig {
  pollIntervalMs: number;
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  maxEmailLength?: number;
  whatsappEnabled: boolean;
}

export interface DeliveryWorkerDeps {
  config: DeliveryWorkerConfig;
  deliveryJobs: DeliveryJobRepository;
  whatsappAdapter: WhatsAppAdapter;
  emailAdapter: EmailAdapter;
  metrics: MetricsRegistry;
  logger: Logger;
  randomFn?: () => number;
  nowFn?: () => Date;
}

export class DeliveryWorker {
  private readonly config: DeliveryWorkerConfig;
  private readonly deliveryJobs: DeliveryJobRepository;
  private readonly whatsappAdapter: WhatsAppAdapter;
  private readonly emailAdapter: EmailAdapter;
  private readonly metrics: MetricsRegistry;
  private readonly logger: Logger;
  private readonly randomFn: () => number;
  private readonly nowFn: () => Date;

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private processingTick = false;

  constructor(deps: DeliveryWorkerDeps) {
    this.config = deps.config;
    this.deliveryJobs = deps.deliveryJobs;
    this.whatsappAdapter = deps.whatsappAdapter;
    this.emailAdapter = deps.emailAdapter;
    this.metrics = deps.metrics;
    this.logger = deps.logger.child({ component: 'delivery-worker' });
    this.randomFn = deps.randomFn ?? Math.random;
    this.nowFn = deps.nowFn ?? (() => new Date());
  }

  public start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.scheduleNextTick(10);
    this.logger.info(
      { pollIntervalMs: this.config.pollIntervalMs, maxAttempts: this.config.maxAttempts },
      'Delivery worker started'
    );
  }

  public async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Wait briefly if a job is currently mid-execution
    const deadline = Date.now() + 5000;
    while (this.processingTick && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    this.logger.info('Delivery worker stopped');
  }

  public triggerNow(): void {
    if (!this.running) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.scheduleNextTick(0);
  }

  private scheduleNextTick(delayMs: number): void {
    if (!this.running) {
      return;
    }
    this.timer = setTimeout(() => {
      void this.runTick();
    }, delayMs);
  }

  private getEligibleChannels(): Channel[] {
    const channels: Channel[] = [];
    if (this.emailAdapter.isHealthy()) {
      channels.push('email');
    }
    if (this.config.whatsappEnabled && this.whatsappAdapter.isReadyForSend()) {
      channels.push('whatsapp');
    }
    return channels;
  }

  public async runTick(): Promise<number> {
    if (this.processingTick) {
      return 0;
    }
    this.processingTick = true;
    let processedCount = 0;

    try {
      const eligibleChannels = this.getEligibleChannels();
      while (this.running || processedCount === 0) {
        const now = this.nowFn();
        const job = this.deliveryJobs.claimNextReadyJob(now.toISOString(), eligibleChannels);
        if (!job) {
          break;
        }
        await this.processJob(job);
        processedCount += 1;
        if (!this.running) {
          break;
        }
      }
    } catch (err) {
      this.logger.error(
        { err: (err as Error).message },
        'Unexpected error in delivery worker tick'
      );
    } finally {
      this.processingTick = false;
      if (this.running) {
        this.scheduleNextTick(this.config.pollIntervalMs);
      }
    }

    return processedCount;
  }

  private async processJob(job: DeliveryJobWithMessage): Promise<void> {
    const startTime = this.nowFn();
    const attempt = this.deliveryJobs.startAttempt(
      job.id,
      job.attemptCount,
      startTime.toISOString()
    );

    try {
      const formattedText = formatOutboundMessage(job.message, job.destinationChannel, {
        maxEmailLength: this.config.maxEmailLength,
      });

      let attachments: EmailAttachment[] | undefined;
      if (job.destinationChannel === 'email' && job.message.mediaPath) {
        attachments = await prepareAudioAttachment(job.message.mediaPath, this.logger);
      }

      const sendResult =
        job.destinationChannel === 'email'
          ? await this.emailAdapter.sendEmail({
              to: job.destinationId,
              chatId: job.message.conversationId,
              senderName: job.message.senderName,
              subject: `WhatsApp: ${job.message.senderName || job.message.conversationId}`,
              text: formattedText,
              conversationId: job.message.conversationId,
              attachments,
            })
          : await this.whatsappAdapter.sendTextMessage(job.destinationId, formattedText);

      const finishTime = this.nowFn();
      this.deliveryJobs.completeAttempt({
        attemptId: attempt.id,
        outcome: sendResult.status,
        providerMessageId: sendResult.providerMessageId,
        finishedAtIso: finishTime.toISOString(),
      });

      this.deliveryJobs.transitionJobStatus({
        jobId: job.id,
        targetStatus: sendResult.status,
        providerMessageId: sendResult.providerMessageId,
        errorCode: null,
        nowIso: finishTime.toISOString(),
      });

      this.metrics.incrementDeliveriesSubmitted();
      if (sendResult.status === 'delivered') {
        this.metrics.incrementDeliveriesCompleted();
      }
      const latencyMs = finishTime.getTime() - new Date(job.createdAt).getTime();
      this.metrics.recordDeliveryLatency(latencyMs);

      this.logger.info(
        {
          jobId: job.id,
          messageId: job.messageId,
          destinationChannel: job.destinationChannel,
          status: sendResult.status,
          providerMessageId: sendResult.providerMessageId,
          attemptCount: job.attemptCount,
          latencyMs: Math.max(0, latencyMs),
        },
        'Outbound message submitted to transport'
      );
    } catch (rawErr) {
      const finishTime = this.nowFn();
      const err =
        rawErr instanceof BridgeError
          ? rawErr
          : new TransientDeliveryError(
              (rawErr as Error)?.message ?? 'Unknown worker error',
              'WORKER_DISPATCH_ERROR',
              { cause: rawErr }
            );

      if (job.destinationChannel === 'email') {
        this.metrics.incrementEmailRequestFailures();
      } else {
        this.metrics.incrementWhatsappSendFailures();
      }

      if (err.category === 'ambiguous') {
        this.deliveryJobs.completeAttempt({
          attemptId: attempt.id,
          outcome: 'ambiguous_error',
          errorCode: err.code,
          finishedAtIso: finishTime.toISOString(),
        });

        this.deliveryJobs.transitionJobStatus({
          jobId: job.id,
          targetStatus: 'unknown',
          errorCode: err.code,
          nowIso: finishTime.toISOString(),
        });

        this.logger.error(
          {
            jobId: job.id,
            messageId: job.messageId,
            destinationChannel: job.destinationChannel,
            errorCode: err.code,
            attemptCount: job.attemptCount,
          },
          'Delivery outcome is ambiguous; job moved to unknown state to prevent duplicate send'
        );
        return;
      }

      if (err.category === 'permanent') {
        this.deliveryJobs.completeAttempt({
          attemptId: attempt.id,
          outcome: 'permanent_error',
          errorCode: err.code,
          finishedAtIso: finishTime.toISOString(),
        });

        this.deliveryJobs.transitionJobStatus({
          jobId: job.id,
          targetStatus: 'dead_letter',
          errorCode: err.code,
          nowIso: finishTime.toISOString(),
        });

        this.logger.error(
          {
            jobId: job.id,
            messageId: job.messageId,
            destinationChannel: job.destinationChannel,
            errorCode: err.code,
            attemptCount: job.attemptCount,
          },
          'Permanent delivery error; job moved to dead_letter'
        );
        return;
      }

      const attemptOutcome = err.category === 'auth' ? 'auth_error' : 'transient_error';
      this.deliveryJobs.completeAttempt({
        attemptId: attempt.id,
        outcome: attemptOutcome,
        errorCode: err.code,
        finishedAtIso: finishTime.toISOString(),
      });

      if (job.attemptCount >= this.config.maxAttempts) {
        this.deliveryJobs.transitionJobStatus({
          jobId: job.id,
          targetStatus: 'dead_letter',
          errorCode: err.code,
          nowIso: finishTime.toISOString(),
        });

        this.logger.error(
          {
            jobId: job.id,
            messageId: job.messageId,
            destinationChannel: job.destinationChannel,
            errorCode: err.code,
            attemptCount: job.attemptCount,
            maxAttempts: this.config.maxAttempts,
          },
          'Job exceeded maximum delivery attempts; moved to dead_letter'
        );
        return;
      }

      const backoffMs = calculateBackoffMs({
        attempt: job.attemptCount,
        baseBackoffMs: this.config.baseBackoffMs,
        maxBackoffMs: this.config.maxBackoffMs,
        randomFn: this.randomFn,
      });

      const nextAttemptAt = new Date(finishTime.getTime() + backoffMs).toISOString();
      this.metrics.incrementDeliveryRetries();

      this.deliveryJobs.transitionJobStatus({
        jobId: job.id,
        targetStatus: 'failed',
        errorCode: err.code,
        nextAttemptAt,
        nowIso: finishTime.toISOString(),
      });

      this.logger.warn(
        {
          jobId: job.id,
          messageId: job.messageId,
          destinationChannel: job.destinationChannel,
          errorCode: err.code,
          attemptCount: job.attemptCount,
          backoffMs,
          nextAttemptAt,
        },
        'Transient delivery failure; scheduled retry with backoff'
      );
    }
  }
}
