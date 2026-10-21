import crypto from 'node:crypto';
import type { SqliteDatabase } from '../db.js';
import type {
  Channel,
  InboundEvent,
  InboundEventProcessingStatus,
} from '../../domain/types.js';

export interface InsertInboundEventInput {
  id?: string;
  sourceChannel: Channel;
  sourceEventId: string;
  receivedAt?: string;
  payloadMetadata: Record<string, unknown>;
  processingStatus: InboundEventProcessingStatus;
}

export type InsertInboundEventResult =
  | { duplicate: false; event: InboundEvent }
  | { duplicate: true; existingEvent: InboundEvent };

interface InboundEventRow {
  id: string;
  source_channel: Channel;
  source_event_id: string;
  received_at: string;
  payload_metadata: string;
  processing_status: InboundEventProcessingStatus;
}

function mapRow(row: InboundEventRow): InboundEvent {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(row.payload_metadata) as Record<string, unknown>;
  } catch {
    metadata = {};
  }
  return {
    id: row.id,
    sourceChannel: row.source_channel,
    sourceEventId: row.source_event_id,
    receivedAt: row.received_at,
    payloadMetadata: metadata,
    processingStatus: row.processing_status,
  };
}

export class InboundEventRepository {
  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  public findBySourceEvent(
    sourceChannel: Channel,
    sourceEventId: string
  ): InboundEvent | undefined {
    const stmt = this.db.raw.prepare(`
      SELECT id, source_channel, source_event_id, received_at, payload_metadata, processing_status
      FROM inbound_events
      WHERE source_channel = ? AND source_event_id = ?
    `);
    const row = stmt.get(sourceChannel, sourceEventId) as InboundEventRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  public insertOrDetectDuplicate(input: InsertInboundEventInput): InsertInboundEventResult {
    const id = input.id ?? crypto.randomUUID();
    const receivedAt = input.receivedAt ?? new Date().toISOString();
    const metadataJson = JSON.stringify(input.payloadMetadata);

    const insertStmt = this.db.raw.prepare(`
      INSERT INTO inbound_events (
        id, source_channel, source_event_id, received_at, payload_metadata, processing_status
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (source_channel, source_event_id) DO NOTHING
    `);

    const result = insertStmt.run(
      id,
      input.sourceChannel,
      input.sourceEventId,
      receivedAt,
      metadataJson,
      input.processingStatus
    );

    if (Number(result.changes) === 0) {
      const existing = this.findBySourceEvent(input.sourceChannel, input.sourceEventId);
      if (!existing) {
        throw new Error('Failed to load existing inbound event after conflict');
      }
      return { duplicate: true, existingEvent: existing };
    }

    return {
      duplicate: false,
      event: {
        id,
        sourceChannel: input.sourceChannel,
        sourceEventId: input.sourceEventId,
        receivedAt,
        payloadMetadata: input.payloadMetadata,
        processingStatus: input.processingStatus,
      },
    };
  }

  public updateProcessingStatus(
    id: string,
    status: InboundEventProcessingStatus
  ): void {
    const stmt = this.db.raw.prepare(`
      UPDATE inbound_events
      SET processing_status = ?
      WHERE id = ?
    `);
    stmt.run(status, id);
  }
}
