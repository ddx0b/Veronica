import type { SqliteDatabase } from '../db.js';
import type { Channel, MessageType, NormalizedMessage } from '../../domain/types.js';

interface MessageRow {
  id: string;
  source_channel: Channel;
  source_message_id: string;
  sender_id: string;
  sender_name: string | null;
  conversation_id: string;
  text: string;
  message_type: MessageType;
  created_at: string;
  media_path: string | null;
}

function mapRow(row: MessageRow): NormalizedMessage {
  return {
    id: row.id,
    sourceChannel: row.source_channel,
    sourceMessageId: row.source_message_id,
    senderId: row.sender_id,
    senderName: row.sender_name,
    conversationId: row.conversation_id,
    text: row.text,
    messageType: row.message_type,
    createdAt: row.created_at,
    mediaPath: row.media_path,
  };
}

export class MessageRepository {
  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  public insert(message: NormalizedMessage): NormalizedMessage {
    const stmt = this.db.raw.prepare(`
      INSERT INTO messages (
        id, source_channel, source_message_id, sender_id, sender_name,
        conversation_id, text, message_type, created_at, media_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      message.id,
      message.sourceChannel,
      message.sourceMessageId,
      message.senderId,
      message.senderName ?? null,
      message.conversationId,
      message.text,
      message.messageType,
      message.createdAt,
      message.mediaPath ?? null
    );

    return message;
  }

  public findById(id: string): NormalizedMessage | undefined {
    const stmt = this.db.raw.prepare(`
      SELECT id, source_channel, source_message_id, sender_id, sender_name,
             conversation_id, text, message_type, created_at, media_path
      FROM messages
      WHERE id = ?
    `);
    const row = stmt.get(id) as MessageRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  /**
   * Data minimization: scrubs message body text for terminal jobs older than cutoffIso.
   */
  public redactDeliveredMessageBodiesOlderThan(cutoffIso: string): number {
    const stmt = this.db.raw.prepare(`
      UPDATE messages
      SET text = '[REDACTED_BY_RETENTION_POLICY]'
      WHERE created_at < ?
        AND text != '[REDACTED_BY_RETENTION_POLICY]'
        AND id IN (
          SELECT message_id FROM delivery_jobs
          WHERE status IN ('delivered', 'submitted')
        )
    `);
    const res = stmt.run(cutoffIso);
    return Number(res.changes);
  }
}
