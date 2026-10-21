import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatOutboundMessage } from '../../src/domain/formatter.js';
import { PermanentDeliveryError } from '../../src/domain/errors.js';

describe('Outbound Message Formatter', () => {
  it('formats Email -> WhatsApp with [Email] prefix and sender', () => {
    const formattedWithSenderName = formatOutboundMessage(
      {
        id: '1',
        sourceChannel: 'email',
        sourceMessageId: 'em-1',
        senderId: 'user@example.com',
        senderName: 'Alice',
        conversationId: '15551234567@s.whatsapp.net',
        text: 'Are we meeting at 19:00?',
        messageType: 'text',
        createdAt: new Date().toISOString(),
      },
      'whatsapp'
    );

    assert.equal(formattedWithSenderName, '[Email] Alice: Are we meeting at 19:00?');

    const formattedWithSenderId = formatOutboundMessage(
      {
        id: '2',
        sourceChannel: 'email',
        sourceMessageId: 'em-2',
        senderId: 'user@example.com',
        senderName: null,
        conversationId: '15551234567@s.whatsapp.net',
        text: 'Yes, see you there!',
        messageType: 'text',
        createdAt: new Date().toISOString(),
      },
      'whatsapp'
    );

    assert.equal(formattedWithSenderId, '[Email] user@example.com: Yes, see you there!');
  });

  it('formats WhatsApp -> Email as plain text body', () => {
    const formatted = formatOutboundMessage(
      {
        id: '3',
        sourceChannel: 'whatsapp',
        sourceMessageId: 'wa-1',
        senderId: '15551234567@s.whatsapp.net',
        senderName: 'Alice',
        conversationId: '15551234567@s.whatsapp.net',
        text: 'Hello from WhatsApp!',
        messageType: 'text',
        createdAt: new Date().toISOString(),
      },
      'email'
    );

    assert.equal(formatted, 'Hello from WhatsApp!');
  });

  it('rejects messages exceeding maximum allowed length with PermanentDeliveryError', () => {
    assert.throws(
      () =>
        formatOutboundMessage(
          {
            id: '4',
            sourceChannel: 'whatsapp',
            sourceMessageId: 'wa-4',
            senderId: '15551234567@s.whatsapp.net',
            senderName: 'Alice',
            conversationId: '15551234567@s.whatsapp.net',
            text: 'x'.repeat(200),
            messageType: 'text',
            createdAt: new Date().toISOString(),
          },
          'email',
          { maxEmailLength: 100 }
        ),
      (err: unknown) =>
        err instanceof PermanentDeliveryError && err.code === 'MESSAGE_TOO_LONG'
    );
  });
});
