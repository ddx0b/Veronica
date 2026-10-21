import crypto from 'node:crypto';
import type { SqliteDatabase } from '../db.js';
import { assertValidStatusTransition } from '../../domain/state-machine.js';
import type {
  Channel,
  DeliveryAttempt,
  DeliveryAttemptOutcome,
  DeliveryJob,
  DeliveryJobStatus,
  DeliveryJobWithMessage,
  MessageType,
} from '../../domain/types.js';

interface DeliveryJobRow {
  id: string;
  message_id: string;
  destination_channel: Channel;
  destination_id: string;
  status: DeliveryJobStatus;
  attempt_count: number;
  next_attempt_at: string;
  provider_message_id: string | null;
  last_error_code: string | null;
  last_error_at: string | null;
  created_at: string;
  updated_at: string;
}

interface DeliveryJobWithMessageRow extends DeliveryJobRow {
  msg_source_channel: Channel;
  msg_source_message_id: string;
  msg_sender_id: string;
  msg_sender_name: string | null;
  msg_conversation_id: string;
  msg_text: string;
  msg_message_type: MessageType;
  msg_created_at: string;
}

interface DeliveryAttemptRow {
  id: string;
  delivery_job_id: string;
  attempt_number: number;
  started_at: string;
  finished_at: string | null;
  outcome: DeliveryAttemptOutcome;
  error_code: string | null;
  provider_message_id: string | null;
}

function mapJobRow(row: DeliveryJobRow): DeliveryJob {
  return {
    id: row.id,
    messageId: row.message_id,
    destinationChannel: row.destination_channel,
    destinationId: row.destination_id,
    status: row.status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    providerMessageId: row.provider_message_id,
    lastErrorCode: row.last_error_code,
    lastErrorAt: row.last_error_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapJobWithMessageRow(row: DeliveryJobWithMessageRow): DeliveryJobWithMessage {
  return {
    ...mapJobRow(row),
    message: {
      id: row.message_id,
      sourceChannel: row.msg_source_channel,
      sourceMessageId: row.msg_source_message_id,
      senderId: row.msg_sender_id,
      senderName: row.msg_sender_name,
      conversationId: row.msg_conversation_id,
      text: row.msg_text,
      messageType: row.msg_message_type,
      createdAt: row.msg_created_at,
    },
  };
}

function mapAttemptRow(row: DeliveryAttemptRow): DeliveryAttempt {
  return {
    id: row.id,
    deliveryJobId: row.delivery_job_id,
    attemptNumber: row.attempt_number,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    outcome: row.outcome,
    errorCode: row.error_code,
    providerMessageId: row.provider_message_id,
  };
}

export interface CreateDeliveryJobInput {
  id?: string;
  messageId: string;
  destinationChannel: Channel;
  destinationId: string;
  nowIso?: string;
}

export interface RecoverySummary {
  resetToPending: number;
  markedUnknown: number;
}

export type JobStatusCounts = Record<DeliveryJobStatus, number>;

export class DeliveryJobRepository {
  private readonly db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  public createJob(input: CreateDeliveryJobInput): DeliveryJob {
    const id = input.id ?? crypto.randomUUID();
    const nowIso = input.nowIso ?? new Date().toISOString();

    const stmt = this.db.raw.prepare(`
      INSERT INTO delivery_jobs (
        id, message_id, destination_channel, destination_id,
        status, attempt_count, next_attempt_at,
        provider_message_id, last_error_code, last_error_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, ?, ?)
    `);

    stmt.run(
      id,
      input.messageId,
      input.destinationChannel,
      input.destinationId,
      nowIso,
      nowIso,
      nowIso
    );

    return {
      id,
      messageId: input.messageId,
      destinationChannel: input.destinationChannel,
      destinationId: input.destinationId,
      status: 'pending',
      attemptCount: 0,
      nextAttemptAt: nowIso,
      providerMessageId: null,
      lastErrorCode: null,
      lastErrorAt: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
  }

  public findById(id: string): DeliveryJob | undefined {
    const stmt = this.db.raw.prepare(`
      SELECT * FROM delivery_jobs WHERE id = ?
    `);
    const row = stmt.get(id) as DeliveryJobRow | undefined;
    return row ? mapJobRow(row) : undefined;
  }

  public findByProviderMessageId(providerMessageId: string): DeliveryJob | undefined {
    const stmt = this.db.raw.prepare(`
      SELECT * FROM delivery_jobs WHERE provider_message_id = ?
    `);
    const row = stmt.get(providerMessageId) as DeliveryJobRow | undefined;
    return row ? mapJobRow(row) : undefined;
  }

  public listAll(): DeliveryJob[] {
    const stmt = this.db.raw.prepare(`
      SELECT * FROM delivery_jobs ORDER BY created_at ASC
    `);
    const rows = stmt.all() as unknown as DeliveryJobRow[];
    return rows.map(mapJobRow);
  }

  public listAttemptsForJob(jobId: string): DeliveryAttempt[] {
    const stmt = this.db.raw.prepare(`
      SELECT * FROM delivery_attempts
      WHERE delivery_job_id = ?
      ORDER BY attempt_number ASC
    `);
    const rows = stmt.all(jobId) as unknown as DeliveryAttemptRow[];
    return rows.map(mapAttemptRow);
  }

  public claimNextReadyJob(
    nowIso: string = new Date().toISOString(),
    eligibleChannels: readonly Channel[] = ['whatsapp', 'email']
  ): DeliveryJobWithMessage | undefined {
    if (eligibleChannels.length === 0) {
      return undefined;
    }

    return this.db.transaction(() => {
      const placeholders = eligibleChannels.map(() => '?').join(', ');
      const findStmt = this.db.raw.prepare(`
        SELECT
          j.*,
          m.source_channel AS msg_source_channel,
          m.source_message_id AS msg_source_message_id,
          m.sender_id AS msg_sender_id,
          m.sender_name AS msg_sender_name,
          m.conversation_id AS msg_conversation_id,
          m.text AS msg_text,
          m.message_type AS msg_message_type,
          m.created_at AS msg_created_at
        FROM delivery_jobs j
        INNER JOIN messages m ON m.id = j.message_id
        WHERE j.status IN ('pending', 'failed')
          AND j.next_attempt_at <= ?
          AND j.destination_channel IN (${placeholders})
        ORDER BY j.next_attempt_at ASC, j.created_at ASC
        LIMIT 1
      `);

      const row = findStmt.get(nowIso, ...eligibleChannels) as
        | DeliveryJobWithMessageRow
        | undefined;

      if (!row) {
        return undefined;
      }

      assertValidStatusTransition(row.status, 'processing');

      const newAttemptCount = row.attempt_count + 1;
      const updateStmt = this.db.raw.prepare(`
        UPDATE delivery_jobs
        SET status = 'processing',
            attempt_count = ?,
            updated_at = ?
        WHERE id = ? AND status = ?
      `);

      const res = updateStmt.run(newAttemptCount, nowIso, row.id, row.status);
      if (Number(res.changes) === 0) {
        return undefined;
      }

      return mapJobWithMessageRow({
        ...row,
        status: 'processing',
        attempt_count: newAttemptCount,
        updated_at: nowIso,
      });
    });
  }

  public startAttempt(
    jobId: string,
    attemptNumber: number,
    startedAtIso: string = new Date().toISOString()
  ): DeliveryAttempt {
    const id = crypto.randomUUID();
    const stmt = this.db.raw.prepare(`
      INSERT INTO delivery_attempts (
        id, delivery_job_id, attempt_number, started_at, finished_at,
        outcome, error_code, provider_message_id
      ) VALUES (?, ?, ?, ?, NULL, 'in_progress', NULL, NULL)
    `);
    stmt.run(id, jobId, attemptNumber, startedAtIso);
    return {
      id,
      deliveryJobId: jobId,
      attemptNumber,
      startedAt: startedAtIso,
      finishedAt: null,
      outcome: 'in_progress',
      errorCode: null,
      providerMessageId: null,
    };
  }

  public completeAttempt(params: {
    attemptId: string;
    outcome: Exclude<DeliveryAttemptOutcome, 'in_progress'>;
    errorCode?: string | null;
    providerMessageId?: string | null;
    finishedAtIso?: string;
  }): void {
    const finishedAt = params.finishedAtIso ?? new Date().toISOString();
    const stmt = this.db.raw.prepare(`
      UPDATE delivery_attempts
      SET finished_at = ?,
          outcome = ?,
          error_code = ?,
          provider_message_id = ?
      WHERE id = ?
    `);
    stmt.run(
      finishedAt,
      params.outcome,
      params.errorCode ?? null,
      params.providerMessageId ?? null,
      params.attemptId
    );
  }

  public transitionJobStatus(params: {
    jobId: string;
    targetStatus: DeliveryJobStatus;
    providerMessageId?: string | null;
    errorCode?: string | null;
    nextAttemptAt?: string;
    nowIso?: string;
  }): DeliveryJob {
    return this.db.transaction(() => {
      const current = this.findById(params.jobId);
      if (!current) {
        throw new Error(`Delivery job not found: ${params.jobId}`);
      }

      assertValidStatusTransition(current.status, params.targetStatus);

      const nowIso = params.nowIso ?? new Date().toISOString();
      const nextAttemptAt = params.nextAttemptAt ?? current.nextAttemptAt;
      const providerMessageId =
        params.providerMessageId !== undefined
          ? params.providerMessageId
          : current.providerMessageId;
      const lastErrorCode =
        params.errorCode !== undefined ? params.errorCode : current.lastErrorCode;
      const lastErrorAt =
        params.errorCode !== undefined && params.errorCode !== null
          ? nowIso
          : current.lastErrorAt;

      const stmt = this.db.raw.prepare(`
        UPDATE delivery_jobs
        SET status = ?,
            next_attempt_at = ?,
            provider_message_id = ?,
            last_error_code = ?,
            last_error_at = ?,
            updated_at = ?
        WHERE id = ?
      `);

      stmt.run(
        params.targetStatus,
        nextAttemptAt,
        providerMessageId,
        lastErrorCode,
        lastErrorAt,
        nowIso,
        params.jobId
      );

      return {
        ...current,
        status: params.targetStatus,
        nextAttemptAt,
        providerMessageId,
        lastErrorCode,
        lastErrorAt,
        updatedAt: nowIso,
      };
    });
  }

  public updateStatusByProviderMessageId(params: {
    providerMessageId: string;
    targetStatus: 'delivered' | 'dead_letter' | 'failed';
    errorCode?: string | null;
    nowIso?: string;
  }): DeliveryJob | undefined {
    return this.db.transaction(() => {
      const current = this.findByProviderMessageId(params.providerMessageId);
      if (!current) {
        return undefined;
      }

      // Ignore out-of-order callbacks if already delivered or dead-lettered
      if (current.status === 'delivered' || current.status === 'dead_letter') {
        return current;
      }

      return this.transitionJobStatus({
        jobId: current.id,
        targetStatus: params.targetStatus,
        errorCode: params.errorCode,
        nowIso: params.nowIso,
      });
    });
  }

  /**
   * Startup recovery:
   * - Jobs in 'processing' that have an 'in_progress' delivery_attempt were interrupted mid-dispatch.
   *   Their external outcome is ambiguous, so move them to 'unknown' (FR-08).
   * - Jobs in 'processing' with no 'in_progress' delivery_attempt were claimed before dispatch started.
   *   Decrement attempt_count and return them to 'pending'.
   */
  public recoverInFlightJobs(nowIso: string = new Date().toISOString()): RecoverySummary {
    return this.db.transaction(() => {
      const processingJobs = this.db.raw
        .prepare(`SELECT * FROM delivery_jobs WHERE status = 'processing'`)
        .all() as unknown as DeliveryJobRow[];

      let resetToPending = 0;
      let markedUnknown = 0;

      const findInProgressAttempt = this.db.raw.prepare(`
        SELECT * FROM delivery_attempts
        WHERE delivery_job_id = ? AND outcome = 'in_progress'
        LIMIT 1
      `);

      const markAttemptAmbiguous = this.db.raw.prepare(`
        UPDATE delivery_attempts
        SET finished_at = ?,
            outcome = 'ambiguous_error',
            error_code = 'PROCESS_RESTART_MID_FLIGHT'
        WHERE id = ?
      `);

      const markJobUnknown = this.db.raw.prepare(`
        UPDATE delivery_jobs
        SET status = 'unknown',
            last_error_code = 'PROCESS_RESTART_MID_FLIGHT',
            last_error_at = ?,
            updated_at = ?
        WHERE id = ?
      `);

      const resetJobPending = this.db.raw.prepare(`
        UPDATE delivery_jobs
        SET status = 'pending',
            attempt_count = MAX(0, attempt_count - 1),
            updated_at = ?
        WHERE id = ?
      `);

      for (const job of processingJobs) {
        const inProgress = findInProgressAttempt.get(job.id) as DeliveryAttemptRow | undefined;
        if (inProgress) {
          markAttemptAmbiguous.run(nowIso, inProgress.id);
          markJobUnknown.run(nowIso, nowIso, job.id);
          markedUnknown += 1;
        } else {
          resetJobPending.run(nowIso, job.id);
          resetToPending += 1;
        }
      }

      return { resetToPending, markedUnknown };
    });
  }

  public getCountsByStatus(): JobStatusCounts {
    const counts: JobStatusCounts = {
      pending: 0,
      processing: 0,
      submitted: 0,
      delivered: 0,
      failed: 0,
      dead_letter: 0,
      unknown: 0,
    };

    const rows = this.db.raw
      .prepare(`SELECT status, COUNT(*) as count FROM delivery_jobs GROUP BY status`)
      .all() as unknown as Array<{ status: DeliveryJobStatus; count: number }>;

    for (const row of rows) {
      if (row.status in counts) {
        counts[row.status] = Number(row.count);
      }
    }

    return counts;
  }
}
