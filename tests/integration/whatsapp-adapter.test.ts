import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DisconnectReason } from '@whiskeysockets/baileys';
import { BaileysWhatsAppAdapter, type BaileysSocketLike } from '../../src/adapters/whatsapp/baileys.adapter.js';
import { createLogger } from '../../src/observability/logger.js';
import type { RawWhatsAppInboundEvent } from '../../src/domain/normalizer.js';

function createMockSocket() {
  const emitter = new EventEmitter();
  const sentMessages: Array<{ jid: string; content: { text: string } }> = [];
  let msgCounter = 0;

  const socket: BaileysSocketLike = {
    ev: {
      on(event, listener) {
        emitter.on(event, listener);
      },
    },
    sendMessage: (async (jid: string, content: { text: string }) => {
      sentMessages.push({ jid, content });
      return {
        key: {
          id: `wa-out-${++msgCounter}`,
          remoteJid: jid,
          fromMe: true,
        },
      };
    }) as BaileysSocketLike['sendMessage'],
    end() {
      // no-op
    },
  };

  return { socket, emitter, sentMessages };
}

describe('WhatsApp Adapter (Baileys Integration with Mock Socket)', () => {
  it('manages connection state, ignores self-messages, and never logs QR strings', async () => {
    const tmpAuthDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-auth-test-'));
    const logLines: string[] = [];
    const logger = createLogger({
      level: 'info',
      destination: {
        write(chunk: string) {
          logLines.push(chunk);
        },
      },
    });

    const { socket, emitter } = createMockSocket();
    const receivedEvents: RawWhatsAppInboundEvent[] = [];

    const adapter = new BaileysWhatsAppAdapter({
      authDirectory: tmpAuthDir,
      targetChatId: '15551234567@s.whatsapp.net',
      logger,
      socketFactory: async () => socket,
    });

    adapter.onInboundMessage((evt) => {
      receivedEvents.push(evt);
    });

    try {
      await adapter.start();
      assert.equal(adapter.getConnectionState(), 'connecting');

      // Emit a QR challenge and verify the QR string does not appear in logs
      const sampleQrChallenge = `qr-challenge-${Date.now()}`;
      emitter.emit('connection.update', { qr: sampleQrChallenge });
      assert.equal(
        logLines.some((line) => line.includes(sampleQrChallenge)),
        false,
        'QR code payload must never be written to logs'
      );

      // Open connection
      emitter.emit('connection.update', { connection: 'open' });
      assert.equal(adapter.getConnectionState(), 'connected');
      assert.equal(adapter.isReadyForSend(), true);

      // Send outbound message and verify loop prevention if echoed back
      const sendRes = await adapter.sendTextMessage(
        '15551234567@s.whatsapp.net',
        '[SMS] +19999999999: Hello'
      );
      assert.equal(sendRes.providerMessageId, 'wa-out-1');
      assert.equal(sendRes.status, 'submitted');

      // Echo outbound message back via messages.upsert -> must be ignored
      emitter.emit('messages.upsert', {
        type: 'notify',
        messages: [
          {
            key: {
              id: 'wa-out-1',
              remoteJid: '15551234567@s.whatsapp.net',
              fromMe: false,
            },
            message: { conversation: '[SMS] +19999999999: Hello' },
          },
          {
            key: {
              id: 'wa-self-2',
              remoteJid: '15551234567@s.whatsapp.net',
              fromMe: true,
            },
            message: { conversation: 'From my own phone' },
          },
          {
            key: {
              id: 'wa-in-3',
              remoteJid: '15551234567@s.whatsapp.net',
              fromMe: false,
            },
            pushName: 'Alice',
            messageTimestamp: 1700000000,
            message: { conversation: 'Genuine inbound message' },
          },
        ],
      });

      assert.equal(receivedEvents.length, 1);
      assert.equal(receivedEvents[0]?.eventId, 'wa-in-3');

      // Simulate loggedOut disconnect -> must transition to auth_failed
      emitter.emit('connection.update', {
        connection: 'close',
        lastDisconnect: {
          error: Object.assign(new Error('Logged Out'), {
            output: { statusCode: DisconnectReason.loggedOut },
          }),
        },
      });
      assert.equal(adapter.getConnectionState(), 'auth_failed');
      assert.equal(adapter.isReadyForSend(), false);
    } finally {
      await adapter.stop();
      fs.rmSync(tmpAuthDir, { recursive: true, force: true });
    }
  });

  it('dispatches notifications for missed audio and video calls, but ignores answered calls', async () => {
    const tmpAuthDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-auth-call-test-'));
    const logger = createLogger({
      level: 'silent',
    });

    const { socket, emitter } = createMockSocket();
    const receivedEvents: RawWhatsAppInboundEvent[] = [];

    const adapter = new BaileysWhatsAppAdapter({
      authDirectory: tmpAuthDir,
      targetChatId: '*',
      logger,
      socketFactory: async () => socket,
    });

    adapter.onInboundMessage((evt) => {
      receivedEvents.push(evt);
    });

    try {
      await adapter.start();

      // 1. Missed voice call (offer -> timeout)
      emitter.emit('call', [
        {
          id: 'call-1',
          from: '15551234567@s.whatsapp.net',
          chatId: '15551234567@s.whatsapp.net',
          isVideo: false,
          status: 'offer',
          date: new Date(),
          offline: false,
        },
      ]);
      assert.equal(receivedEvents.length, 0);

      emitter.emit('call', [
        {
          id: 'call-1',
          from: '15551234567@s.whatsapp.net',
          chatId: '15551234567@s.whatsapp.net',
          isVideo: false,
          status: 'timeout',
          date: new Date(),
          offline: false,
        },
      ]);
      assert.equal(receivedEvents.length, 1);
      assert.equal(receivedEvents[0]?.chatId, '15551234567@s.whatsapp.net');
      assert.equal(receivedEvents[0]?.messageContent?.conversation, '[Missed Voice Call]');

      // 2. Missed video call (offer -> terminate)
      emitter.emit('call', [
        {
          id: 'call-2',
          from: '19998887777@s.whatsapp.net',
          chatId: '19998887777@s.whatsapp.net',
          isVideo: true,
          status: 'offer',
          date: new Date(),
          offline: false,
        },
      ]);
      emitter.emit('call', [
        {
          id: 'call-2',
          from: '19998887777@s.whatsapp.net',
          chatId: '19998887777@s.whatsapp.net',
          isVideo: true,
          status: 'terminate',
          date: new Date(),
          offline: false,
        },
      ]);
      assert.equal(receivedEvents.length, 2);
      assert.equal(receivedEvents[1]?.chatId, '19998887777@s.whatsapp.net');
      assert.equal(receivedEvents[1]?.messageContent?.conversation, '[Missed Video Call]');

      // 3. Duplicate event for call-2 (e.g. timeout following terminate) is ignored
      emitter.emit('call', [
        {
          id: 'call-2',
          from: '19998887777@s.whatsapp.net',
          chatId: '19998887777@s.whatsapp.net',
          isVideo: true,
          status: 'timeout',
          date: new Date(),
          offline: false,
        },
      ]);
      assert.equal(receivedEvents.length, 2);

      // 4. Answered call (offer -> accept -> terminate) -> NO missed call notification
      emitter.emit('call', [
        {
          id: 'call-3',
          from: '15551234567@s.whatsapp.net',
          chatId: '15551234567@s.whatsapp.net',
          isVideo: false,
          status: 'offer',
          date: new Date(),
          offline: false,
        },
      ]);
      emitter.emit('call', [
        {
          id: 'call-3',
          from: '15551234567@s.whatsapp.net',
          chatId: '15551234567@s.whatsapp.net',
          isVideo: false,
          status: 'accept',
          date: new Date(),
          offline: false,
        },
      ]);
      emitter.emit('call', [
        {
          id: 'call-3',
          from: '15551234567@s.whatsapp.net',
          chatId: '15551234567@s.whatsapp.net',
          isVideo: false,
          status: 'terminate',
          date: new Date(),
          offline: false,
        },
      ]);
      assert.equal(receivedEvents.length, 2);
    } finally {
      await adapter.stop();
      fs.rmSync(tmpAuthDir, { recursive: true, force: true });
    }
  });
});
