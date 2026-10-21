import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteDatabase } from '../../src/persistence/db.js';
import { InboundEventRepository } from '../../src/persistence/repositories/inbound-event.repo.js';
import { MessageRepository } from '../../src/persistence/repositories/message.repo.js';
import { DeliveryJobRepository } from '../../src/persistence/repositories/delivery-job.repo.js';
import { RouteRepository } from '../../src/persistence/repositories/route.repo.js';
import { BridgePersistenceService } from '../../src/persistence/repositories/bridge.service.js';
import { Router } from '../../src/domain/router.js';

describe('Source-Event Deduplication', () => {
  it('enforces uniqueness per (source_channel, source_event_id) and creates only one job', () => {
    const db = new SqliteDatabase({ dbPath: ':memory:' });
    db.runMigrations();

    const inboundEvents = new InboundEventRepository(db);
    const messages = new MessageRepository(db);
    const deliveryJobs = new DeliveryJobRepository(db);
    const routes = new RouteRepository(db);

    routes.syncConfiguredRoutes([
      {
        sourceChannel: 'email',
        sourceIdentity: 'user@example.com',
        destinationChannel: 'whatsapp',
        destinationIdentity: '15551234567@s.whatsapp.net',
        enabled: true,
      },
    ]);

    const router = new Router(
      {
        whatsappToEmail: true,
        emailToWhatsapp: true,
        allowedEmailSenders: ['user@example.com'],
      },
      (ch, id) => routes.findEnabledRoutes(ch, id)
    );

    const bridgeService = new BridgePersistenceService({
      db,
      inboundEvents,
      messages,
      deliveryJobs,
      router,
    });

    try {
      const first = bridgeService.ingestInboundMessage({
        sourceChannel: 'email',
        sourceEventId: '<email-msg-001@client.com>',
        payloadMetadata: {},
        normalizedMessage: {
          id: 'msg-1',
          sourceChannel: 'email',
          sourceMessageId: '<email-msg-001@client.com>',
          senderId: 'user@example.com',
          conversationId: 'user@example.com',
          text: 'Hello once',
          messageType: 'text',
          createdAt: new Date().toISOString(),
          targetChatId: '15551234567@s.whatsapp.net',
        },
        targetChatId: '15551234567@s.whatsapp.net',
      });

      assert.equal(first.status, 'accepted');

      const second = bridgeService.ingestInboundMessage({
        sourceChannel: 'email',
        sourceEventId: '<email-msg-001@client.com>',
        payloadMetadata: {},
        normalizedMessage: {
          id: 'msg-2',
          sourceChannel: 'email',
          sourceMessageId: '<email-msg-001@client.com>',
          senderId: 'user@example.com',
          conversationId: 'user@example.com',
          text: 'Hello twice',
          messageType: 'text',
          createdAt: new Date().toISOString(),
          targetChatId: '15551234567@s.whatsapp.net',
        },
        targetChatId: '15551234567@s.whatsapp.net',
      });

      assert.equal(second.status, 'duplicate');
      assert.equal(deliveryJobs.listAll().length, 1);
    } finally {
      db.close();
    }
  });
});
