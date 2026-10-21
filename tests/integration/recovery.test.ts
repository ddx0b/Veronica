import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteDatabase } from '../../src/persistence/db.js';
import { MessageRepository } from '../../src/persistence/repositories/message.repo.js';
import { DeliveryJobRepository } from '../../src/persistence/repositories/delivery-job.repo.js';

describe('Process Restart & In-Flight Job Recovery', () => {
  it('recovers pending jobs and distinguishes pre-dispatch vs mid-dispatch processing jobs across SQLite restarts', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-sms-recovery-'));
    const dbFile = path.join(tmpDir, 'bridge.sqlite');

    let pendingJobId = '';
    let preDispatchJobId = '';
    let midDispatchJobId = '';

    try {
      // Process instance #1
      {
        const db1 = new SqliteDatabase({ dbPath: dbFile });
        db1.runMigrations();
        const messages = new MessageRepository(db1);
        const jobs = new DeliveryJobRepository(db1);

        const now = '2026-10-21T10:00:00.000Z';

        for (const idx of [1, 2, 3]) {
          messages.insert({
            id: `msg-${idx}`,
            sourceChannel: 'whatsapp',
            sourceMessageId: `wa-${idx}`,
            senderId: '15551234567@s.whatsapp.net',
            conversationId: '15551234567@s.whatsapp.net',
            text: `Message ${idx}`,
            messageType: 'text',
            createdAt: now,
          });
        }

        // Job 1: stays pending
        pendingJobId = jobs.createJob({
          messageId: 'msg-1',
          destinationChannel: 'email',
          destinationId: 'user@example.com',
          nowIso: now,
        }).id;

        // Job 2: claimed into 'processing', but crashes BEFORE startAttempt() is recorded
        preDispatchJobId = jobs.createJob({
          messageId: 'msg-2',
          destinationChannel: 'email',
          destinationId: 'user@example.com',
          nowIso: '2026-10-21T09:58:00.000Z',
        }).id;

        // Job 3: claimed into 'processing' AND startAttempt() recorded ('in_progress'), then crashes mid-network call
        midDispatchJobId = jobs.createJob({
          messageId: 'msg-3',
          destinationChannel: 'email',
          destinationId: 'user@example.com',
          nowIso: '2026-10-21T09:59:00.000Z',
        }).id;

        // Claim Job 2 (oldest next_attempt_at)
        const claimed2 = jobs.claimNextReadyJob(now);
        assert.equal(claimed2?.id, preDispatchJobId);

        // Claim Job 3 and start attempt
        const claimed3 = jobs.claimNextReadyJob(now);
        assert.equal(claimed3?.id, midDispatchJobId);
        jobs.startAttempt(midDispatchJobId, claimed3.attemptCount, now);

        db1.close();
      }

      // Process instance #2 starts up on the same SQLite file
      {
        const db2 = new SqliteDatabase({ dbPath: dbFile });
        db2.runMigrations();
        const jobs2 = new DeliveryJobRepository(db2);

        const summary = jobs2.recoverInFlightJobs('2026-10-21T10:01:00.000Z');
        assert.deepEqual(summary, {
          resetToPending: 1,
          markedUnknown: 1,
        });

        const job1 = jobs2.findById(pendingJobId);
        const job2 = jobs2.findById(preDispatchJobId);
        const job3 = jobs2.findById(midDispatchJobId);

        assert.equal(job1?.status, 'pending');
        assert.equal(job2?.status, 'pending');
        assert.equal(job2?.attemptCount, 0);
        assert.equal(job3?.status, 'unknown');
        assert.equal(job3?.lastErrorCode, 'PROCESS_RESTART_MID_FLIGHT');

        db2.close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
