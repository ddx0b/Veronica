import type { SqliteDatabase } from '../db.js';
import type { InboundEventRepository } from './inbound-event.repo.js';
import type { MessageRepository } from './message.repo.js';
import type { DeliveryJobRepository } from './delivery-job.repo.js';
import type { Router } from '../../domain/router.js';
import type {
  Channel,
  DeliveryJob,
  InboundEvent,
  NormalizedMessage,
} from '../../domain/types.js';

export interface IngestInboundMessageParams {
  sourceChannel: Channel;
  sourceEventId: string;
  payloadMetadata: Record<string, unknown>;
  normalizedMessage: NormalizedMessage;
  targetChatId?: string;
  recipientNumber?: string;
  nowIso?: string;
}

export type IngestResult =
  | {
      status: 'accepted';
      inboundEvent: InboundEvent;
      message: NormalizedMessage;
      deliveryJob: DeliveryJob;
    }
  | {
      status: 'duplicate';
      existingEvent: InboundEvent;
    }
  | {
      status: 'rejected';
      reason: string;
      inboundEvent: InboundEvent;
    };

export class BridgePersistenceService {
  private readonly db: SqliteDatabase;
  private readonly inboundEvents: InboundEventRepository;
  private readonly messages: MessageRepository;
  private readonly deliveryJobs: DeliveryJobRepository;
  private readonly router: Router;

  constructor(deps: {
    db: SqliteDatabase;
    inboundEvents: InboundEventRepository;
    messages: MessageRepository;
    deliveryJobs: DeliveryJobRepository;
    router: Router;
  }) {
    this.db = deps.db;
    this.inboundEvents = deps.inboundEvents;
    this.messages = deps.messages;
    this.deliveryJobs = deps.deliveryJobs;
    this.router = deps.router;
  }

  /**
   * Transactionally deduplicates the inbound event, evaluates routing rules,
   * and persists the normalized message and outbound delivery job.
   */
  public ingestInboundMessage(params: IngestInboundMessageParams): IngestResult {
    return this.db.transaction(() => {
      const routeDecision = this.router.evaluate(
        params.normalizedMessage,
        params.targetChatId ?? params.recipientNumber
      );

      const initialProcessingStatus = routeDecision.allowed ? 'accepted' : 'rejected';

      const eventResult = this.inboundEvents.insertOrDetectDuplicate({
        sourceChannel: params.sourceChannel,
        sourceEventId: params.sourceEventId,
        receivedAt: params.nowIso,
        payloadMetadata: {
          ...params.payloadMetadata,
          ...(routeDecision.allowed ? { routeId: routeDecision.routeId } : { rejectionReason: routeDecision.reason }),
        },
        processingStatus: initialProcessingStatus,
      });

      if (eventResult.duplicate) {
        return {
          status: 'duplicate',
          existingEvent: eventResult.existingEvent,
        };
      }

      if (!routeDecision.allowed) {
        return {
          status: 'rejected',
          reason: routeDecision.reason,
          inboundEvent: eventResult.event,
        };
      }

      const persistedMessage = this.messages.insert(params.normalizedMessage);
      const deliveryJob = this.deliveryJobs.createJob({
        messageId: persistedMessage.id,
        destinationChannel: routeDecision.destinationChannel,
        destinationId: routeDecision.destinationId,
        nowIso: params.nowIso,
      });

      return {
        status: 'accepted',
        inboundEvent: eventResult.event,
        message: persistedMessage,
        deliveryJob,
      };
    });
  }
}
