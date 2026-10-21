import type { Logger } from 'pino';
import type { AppConfig } from './config/schema.js';
import { createLogger } from './observability/logger.js';
import { MetricsRegistry } from './observability/metrics.js';
import { SqliteDatabase } from './persistence/db.js';
import { InboundEventRepository } from './persistence/repositories/inbound-event.repo.js';
import { MessageRepository } from './persistence/repositories/message.repo.js';
import { DeliveryJobRepository } from './persistence/repositories/delivery-job.repo.js';
import { RouteRepository, type UpsertRouteInput } from './persistence/repositories/route.repo.js';
import { BridgePersistenceService } from './persistence/repositories/bridge.service.js';
import { Router } from './domain/router.js';
import {
  normalizeWhatsAppEvent,
  normalizeEmailEvent,
  type RawWhatsAppInboundEvent,
  type RawEmailInboundEvent,
} from './domain/normalizer.js';
import type { WhatsAppAdapter } from './adapters/whatsapp/interface.js';
import { BaileysWhatsAppAdapter } from './adapters/whatsapp/baileys.adapter.js';
import type { EmailAdapter } from './adapters/email/interface.js';
import { NodemailerEmailAdapter } from './adapters/email/index.js';
import { DeliveryWorker } from './workers/delivery.worker.js';
import { HealthHandlers } from './http/handlers/health.js';
import { BridgeHttpServer } from './http/server.js';

export interface BridgeAppOverrides {
  logger?: Logger;
  whatsappAdapter?: WhatsAppAdapter;
  emailAdapter?: EmailAdapter;
  migrationsDir?: string;
}

export class BridgeApplication {
  public readonly config: AppConfig;
  public readonly logger: Logger;
  public readonly metrics: MetricsRegistry;
  public readonly db: SqliteDatabase;
  public readonly inboundEvents: InboundEventRepository;
  public readonly messages: MessageRepository;
  public readonly deliveryJobs: DeliveryJobRepository;
  public readonly routes: RouteRepository;
  public readonly router: Router;
  public readonly bridgeService: BridgePersistenceService;
  public readonly whatsappAdapter: WhatsAppAdapter;
  public readonly emailAdapter: EmailAdapter;
  public readonly worker: DeliveryWorker;
  public readonly httpServer: BridgeHttpServer;

  private retentionTimer: NodeJS.Timeout | null = null;

  constructor(config: AppConfig, overrides: BridgeAppOverrides = {}) {
    this.config = config;
    this.logger = overrides.logger ?? createLogger({ level: config.logLevel });
    this.metrics = new MetricsRegistry();

    this.db = new SqliteDatabase({
      dbPath: config.database.path,
      migrationsDir: overrides.migrationsDir,
    });
    this.db.runMigrations(overrides.migrationsDir);

    this.inboundEvents = new InboundEventRepository(this.db);
    this.messages = new MessageRepository(this.db);
    this.deliveryJobs = new DeliveryJobRepository(this.db);
    this.routes = new RouteRepository(this.db);

    this.syncRoutesFromConfig();

    this.router = new Router(
      {
        whatsappToEmail: config.routing.whatsappToEmail,
        emailToWhatsapp: config.routing.emailToWhatsapp,
        allowedEmailSenders: config.routing.allowedEmailSenders,
      },
      (sourceChannel, sourceIdentity) =>
        this.routes.findEnabledRoutes(sourceChannel, sourceIdentity)
    );

    this.bridgeService = new BridgePersistenceService({
      db: this.db,
      inboundEvents: this.inboundEvents,
      messages: this.messages,
      deliveryJobs: this.deliveryJobs,
      router: this.router,
    });

    this.whatsappAdapter =
      overrides.whatsappAdapter ??
      new BaileysWhatsAppAdapter({
        authDirectory: config.whatsapp.authDirectory,
        targetChatId: config.whatsapp.targetChatId,
        pairingMode: config.whatsappPairingMode,
        logger: this.logger,
      });

    this.emailAdapter =
      overrides.emailAdapter ??
      new NodemailerEmailAdapter({
        smtp: {
          host: config.email.smtp.host,
          port: config.email.smtp.port,
          secure: config.email.smtp.secure,
          auth: {
            user: config.email.smtp.user,
            pass: config.secrets.emailPassword,
          },
          fromAddress: config.email.smtp.fromAddress,
          domain: config.email.replyDomain,
        },
        imap: {
          host: config.email.imap.host,
          port: config.email.imap.port,
          secure: config.email.imap.secure,
          auth: {
            user: config.email.imap.user,
            pass: config.secrets.emailPassword,
          },
          enabled: config.email.imap.enabled,
        },
        logger: this.logger,
      });

    this.worker = new DeliveryWorker({
      config: {
        pollIntervalMs: config.worker.pollIntervalMs,
        maxAttempts: config.worker.maxAttempts,
        baseBackoffMs: config.worker.baseBackoffMs,
        maxBackoffMs: config.worker.maxBackoffMs,
        whatsappEnabled: config.whatsapp.enabled,
      },
      deliveryJobs: this.deliveryJobs,
      whatsappAdapter: this.whatsappAdapter,
      emailAdapter: this.emailAdapter,
      metrics: this.metrics,
      logger: this.logger,
    });

    this.wireWhatsAppEvents();
    this.wireEmailEvents();

    const healthHandlers = new HealthHandlers({
      db: this.db,
      deliveryJobs: this.deliveryJobs,
      whatsappAdapter: this.whatsappAdapter,
      emailAdapter: this.emailAdapter,
      metrics: this.metrics,
      whatsappEnabled: config.whatsapp.enabled,
    });

    this.httpServer = new BridgeHttpServer({
      host: config.http.host,
      port: config.http.port,
      healthHandlers,
      logger: this.logger,
    });
  }

  private syncRoutesFromConfig(): void {
    const routeInputs: UpsertRouteInput[] = [
      {
        sourceChannel: 'whatsapp',
        sourceIdentity: this.config.whatsapp.targetChatId,
        destinationChannel: 'email',
        destinationIdentity: this.config.email.userEmail,
        enabled: this.config.routing.whatsappToEmail,
      },
    ];

    for (const allowedSender of this.config.routing.allowedEmailSenders) {
      routeInputs.push({
        sourceChannel: 'email',
        sourceIdentity: allowedSender,
        destinationChannel: 'whatsapp',
        destinationIdentity: this.config.whatsapp.targetChatId,
        enabled: this.config.routing.emailToWhatsapp,
      });
    }

    this.routes.syncConfiguredRoutes(routeInputs);
  }

  private wireWhatsAppEvents(): void {
    this.whatsappAdapter.onInboundMessage((rawEvent) => {
      this.handleInboundWhatsAppEvent(rawEvent);
    });

    if (this.whatsappAdapter.onReceiptUpdate) {
      this.whatsappAdapter.onReceiptUpdate(({ providerMessageId, status }) => {
        const updated = this.deliveryJobs.updateStatusByProviderMessageId({
          providerMessageId,
          targetStatus: status,
        });
        if (updated) {
          this.metrics.incrementDeliveriesCompleted();
          this.logger.info(
            { providerMessageId, status, jobId: updated.id },
            'Updated WhatsApp delivery status from receipt'
          );
        }
      });
    }
  }

  private wireEmailEvents(): void {
    this.emailAdapter.onInboundEmail((rawEvent) => {
      this.handleInboundEmailEvent(rawEvent);
    });
  }

  public handleInboundWhatsAppEvent(rawEvent: RawWhatsAppInboundEvent): void {
    this.metrics.incrementInboundEvents();

    const normalized = normalizeWhatsAppEvent(rawEvent);
    if (normalized.kind === 'ignored') {
      const insertRes = this.inboundEvents.insertOrDetectDuplicate({
        sourceChannel: 'whatsapp',
        sourceEventId: rawEvent.eventId,
        payloadMetadata: { reason: normalized.reason },
        processingStatus: 'ignored',
      });
      if (insertRes.duplicate) {
        this.metrics.incrementInboundDuplicates();
      }
      this.logger.debug(
        { sourceEventId: rawEvent.eventId, reason: normalized.reason },
        'Ignored inbound WhatsApp event'
      );
      return;
    }

    const result = this.bridgeService.ingestInboundMessage({
      sourceChannel: 'whatsapp',
      sourceEventId: rawEvent.eventId,
      payloadMetadata: {
        messageType: normalized.message.messageType,
      },
      normalizedMessage: normalized.message,
    });

    if (result.status === 'duplicate') {
      this.metrics.incrementInboundDuplicates();
      this.logger.info(
        { sourceEventId: rawEvent.eventId },
        'Duplicate inbound WhatsApp event ignored'
      );
      return;
    }

    if (result.status === 'rejected') {
      this.metrics.incrementInboundRejected();
      this.logger.info(
        { sourceEventId: rawEvent.eventId, reason: result.reason },
        'Rejected inbound WhatsApp event due to routing policy'
      );
      return;
    }

    this.logger.info(
      {
        sourceEventId: rawEvent.eventId,
        messageId: result.message.id,
        jobId: result.deliveryJob.id,
        messageType: result.message.messageType,
      },
      'Accepted and persisted inbound WhatsApp message'
    );

    this.worker.triggerNow();
  }

  public handleInboundEmailEvent(rawEvent: RawEmailInboundEvent): void {
    this.metrics.incrementInboundEvents();

    const normalized = normalizeEmailEvent(rawEvent);
    if (normalized.kind === 'ignored') {
      const insertRes = this.inboundEvents.insertOrDetectDuplicate({
        sourceChannel: 'email',
        sourceEventId: rawEvent.messageId,
        payloadMetadata: { reason: normalized.reason, subject: rawEvent.subject },
        processingStatus: 'ignored',
      });
      if (insertRes.duplicate) {
        this.metrics.incrementInboundDuplicates();
      }
      this.logger.debug(
        { sourceEventId: rawEvent.messageId, reason: normalized.reason },
        'Ignored inbound Email event'
      );
      return;
    }

    const result = this.bridgeService.ingestInboundMessage({
      sourceChannel: 'email',
      sourceEventId: rawEvent.messageId,
      payloadMetadata: {
        subject: rawEvent.subject,
        targetChatId: rawEvent.targetChatId,
      },
      normalizedMessage: normalized.message,
      targetChatId: rawEvent.targetChatId,
    });

    if (result.status === 'duplicate') {
      this.metrics.incrementInboundDuplicates();
      this.logger.info(
        { sourceEventId: rawEvent.messageId },
        'Duplicate inbound Email event ignored'
      );
      return;
    }

    if (result.status === 'rejected') {
      this.metrics.incrementInboundRejected();
      this.logger.info(
        { sourceEventId: rawEvent.messageId, reason: result.reason },
        'Rejected inbound Email event due to routing policy'
      );
      return;
    }

    this.logger.info(
      {
        sourceEventId: rawEvent.messageId,
        messageId: result.message.id,
        jobId: result.deliveryJob.id,
      },
      'Accepted and persisted inbound Email reply'
    );

    this.worker.triggerNow();
  }

  public runDataRetentionCleanup(): number {
    const retentionMs = this.config.database.retentionDays * 24 * 60 * 60 * 1000;
    const cutoffIso = new Date(Date.now() - retentionMs).toISOString();
    const redactedCount = this.messages.redactDeliveredMessageBodiesOlderThan(cutoffIso);
    if (redactedCount > 0) {
      this.logger.info({ redactedCount }, 'Scrubbed expired message bodies per retention policy');
    }
    return redactedCount;
  }

  public async start(): Promise<void> {
    const recovery = this.deliveryJobs.recoverInFlightJobs();
    if (recovery.resetToPending > 0 || recovery.markedUnknown > 0) {
      this.logger.warn(
        recovery,
        'Recovered in-flight delivery jobs from previous process execution'
      );
    }

    this.runDataRetentionCleanup();
    this.retentionTimer = setInterval(() => {
      try {
        this.runDataRetentionCleanup();
      } catch (err) {
        this.logger.error({ err: (err as Error).message }, 'Retention cleanup error');
      }
    }, 6 * 60 * 60 * 1000);
    this.retentionTimer.unref?.();

    if (this.config.whatsapp.enabled) {
      await this.whatsappAdapter.start();
    }

    await this.emailAdapter.start();

    this.worker.start();
    await this.httpServer.start();
  }

  public async stop(): Promise<void> {
    if (this.retentionTimer) {
      clearInterval(this.retentionTimer);
      this.retentionTimer = null;
    }
    await this.httpServer.stop();
    await this.worker.stop();
    await this.emailAdapter.stop();
    if (this.config.whatsapp.enabled) {
      await this.whatsappAdapter.stop();
    }
    this.db.close();
  }
}
