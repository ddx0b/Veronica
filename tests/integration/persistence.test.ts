import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteDatabase } from '../../src/persistence/db.js';
import { InboundEventRepository } from '../../src/persistence/repositories/inbound-event.repo.js';
import { MessageRepository } from '../../src/persistence/repositories/message.repo.js';
import { DeliveryJobRepository } from '../../src/persistence/repositories/delivery-job.repo.js';

describe('SQLite Persistence & Transaction Atomicity', () => {
  it('runs migrations idempotently', () => {
    const db = new SqliteDatabase({ dbPath: ':memory:' });
    try {
      const firstRun = db.runMigrations();
      assert.deepEqual(firstRun, ['001_initial.sql']);

      const secondRun = db.runMigrations();
      assert.deepEqual(secondRun, []);
    } finally {
      db.close();
    }
  });

  it('rolls back entire transaction when an error occurs mid-transaction', () => {
    const db = new SqliteDatabase({ dbPath: ':memory:' });
    db.runMigrations();

    const inboundRepo = new InboundEventRepository(db);
    const messageRepo = new MessageRepository(db);

    try {
      assert.throws(() => {
        db.transaction(() => {
          inboundRepo.insertOrDetectDuplicate({
            sourceChannel: 'whatsapp',
            sourceEventId: 'atomic-evt-1',
            payloadMetadata: {},
            processingStatus: 'accepted',
          });

          messageRepo.insert({
            id: 'atomic-msg-1',
            sourceChannel: 'whatsapp',
            sourceMessageId: 'atomic-evt-1',
            senderId: '15551234567@s.whatsapp.net',
            senderName: 'Alice',
            conversationId: '15551234567@s.whatsapp.net',
            text: 'Should be rolled back',
            messageType: 'text',
            createdAt: new Date().toISOString(),
          });

          throw new Error('Simulated mid-transaction failure');
        });
      }, /Simulated mid-transaction failure/);

      // Neither inbound_events nor messages should have been persisted
      assert.equal(inboundRepo.findBySourceEvent('whatsapp', 'atomic-evt-1'), undefined);
      assert.equal(messageRepo.findById('atomic-msg-1'), undefined);
    } finally {
      db.close();
    }
  });

  it('redacts expired delivered message bodies per data minimization policy', () => {
    const db = new SqliteDatabase({ dbPath: ':memory:' });
    db.runMigrations();

    const messageRepo = new MessageRepository(db);
    const jobRepo = new DeliveryJobRepository(db);

    try {
      const oldDate = '2020-01-01T00:00:00.000Z';
      messageRepo.insert({
        id: 'old-msg-1',
        sourceChannel: 'whatsapp',
        sourceMessageId: 'wa-old-1',
        senderId: '15551234567@s.whatsapp.net',
        conversationId: '15551234567@s.whatsapp.net',
        text: 'Sensitive historical body',
        messageType: 'text',
        createdAt: oldDate,
      });

      const job = jobRepo.createJob({
        messageId: 'old-msg-1',
        destinationChannel: 'email',
        destinationId: 'user@example.com',
        nowIso: oldDate,
      });
      jobRepo.claimNextReadyJob(oldDate);
      jobRepo.transitionJobStatus({
        jobId: job.id,
        targetStatus: 'submitted',
        providerMessageId: 'email-msg-999',
      });
      jobRepo.transitionJobStatus({
        jobId: job.id,
        targetStatus: 'delivered',
      });

      const redactedCount = messageRepo.redactDeliveredMessageBodiesOlderThan(
        '2025-01-01T00:00:00.000Z'
      );
      assert.equal(redactedCount, 1);

      const loaded = messageRepo.findById('old-msg-1');
      assert.equal(loaded?.text, '[REDACTED_BY_RETENTION_POLICY]');
    } finally {
      db.close();
    }
  });
});
