import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWhatsAppEvent, normalizeEmailEvent, stripEmailQuotes } from '../../src/domain/normalizer.js';

describe('Message Normalizer', () => {
  it('normalizes plain WhatsApp conversation text', () => {
    const result = normalizeWhatsAppEvent(
      {
        eventId: 'evt-1',
        messageId: 'msg-1',
        chatId: '15551234567@s.whatsapp.net',
        senderId: '15551234567@s.whatsapp.net',
        senderName: 'Alice',
        fromMe: false,
        timestampMs: 1700000000000,
        messageContent: {
          conversation: 'Are we meeting at 19:00?',
        },
      },
      () => 'fixed-uuid-1'
    );

    assert.equal(result.kind, 'normalized');
    assert.deepEqual(result.message, {
      id: 'fixed-uuid-1',
      sourceChannel: 'whatsapp',
      sourceMessageId: 'msg-1',
      senderId: '15551234567@s.whatsapp.net',
      senderName: 'Alice',
      conversationId: '15551234567@s.whatsapp.net',
      text: 'Are we meeting at 19:00?',
      messageType: 'text',
      createdAt: new Date(1700000000000).toISOString(),
    });
  });

  it('normalizes WhatsApp extendedTextMessage', () => {
    const result = normalizeWhatsAppEvent({
      eventId: 'evt-2',
      messageId: 'msg-2',
      chatId: '15551234567@s.whatsapp.net',
      senderId: '15551234567@s.whatsapp.net',
      senderName: 'Alice',
      fromMe: false,
      timestampMs: 1700000000000,
      messageContent: {
        extendedTextMessage: {
          text: 'Check out this link',
        },
      },
    });

    assert.equal(result.kind, 'normalized');
    assert.equal(result.message.text, 'Check out this link');
    assert.equal(result.message.messageType, 'text');
  });

  it('produces [Image attached] placeholder for WhatsApp image without caption', () => {
    const result = normalizeWhatsAppEvent({
      eventId: 'evt-3',
      messageId: 'msg-3',
      chatId: '15551234567@s.whatsapp.net',
      senderId: '15551234567@s.whatsapp.net',
      senderName: 'Alice',
      fromMe: false,
      timestampMs: 1700000000000,
      messageContent: {
        imageMessage: {},
      },
    });

    assert.equal(result.kind, 'normalized');
    assert.equal(result.message.text, '[Image attached]');
    assert.equal(result.message.messageType, 'image');
  });

  it('preserves caption and appends placeholder for WhatsApp image with caption', () => {
    const result = normalizeWhatsAppEvent({
      eventId: 'evt-4',
      messageId: 'msg-4',
      chatId: '15551234567@s.whatsapp.net',
      senderId: '15551234567@s.whatsapp.net',
      senderName: 'Alice',
      fromMe: false,
      timestampMs: 1700000000000,
      messageContent: {
        imageMessage: { caption: 'Receipt from lunch' },
      },
    });

    assert.equal(result.kind, 'normalized');
    assert.equal(result.message.text, 'Receipt from lunch [Image attached]');
    assert.equal(result.message.messageType, 'image');
  });

  it('generates appropriate placeholders for video, audio, document, and sticker messages', () => {
    const videoRes = normalizeWhatsAppEvent({
      eventId: 'evt-v',
      messageId: 'msg-v',
      chatId: '15551234567@s.whatsapp.net',
      senderId: '15551234567@s.whatsapp.net',
      fromMe: false,
      timestampMs: 1700000000000,
      messageContent: { videoMessage: { caption: 'Clip' } },
    });
    assert.equal(videoRes.kind, 'normalized');
    assert.equal(videoRes.message.text, 'Clip [Video attached]');

    const audioRes = normalizeWhatsAppEvent({
      eventId: 'evt-a',
      messageId: 'msg-a',
      chatId: '15551234567@s.whatsapp.net',
      senderId: '15551234567@s.whatsapp.net',
      fromMe: false,
      timestampMs: 1700000000000,
      messageContent: { audioMessage: { seconds: 5 } },
    });
    assert.equal(audioRes.kind, 'normalized');
    assert.equal(audioRes.message.text, '[Audio attached]');

    const docRes = normalizeWhatsAppEvent({
      eventId: 'evt-d',
      messageId: 'msg-d',
      chatId: '15551234567@s.whatsapp.net',
      senderId: '15551234567@s.whatsapp.net',
      fromMe: false,
      timestampMs: 1700000000000,
      messageContent: { documentMessage: {} },
    });
    assert.equal(docRes.kind, 'normalized');
    assert.equal(docRes.message.text, '[Document attached]');

    const stickerRes = normalizeWhatsAppEvent({
      eventId: 'evt-s',
      messageId: 'msg-s',
      chatId: '15551234567@s.whatsapp.net',
      senderId: '15551234567@s.whatsapp.net',
      fromMe: false,
      timestampMs: 1700000000000,
      messageContent: { stickerMessage: {} },
    });
    assert.equal(stickerRes.kind, 'normalized');
    assert.equal(stickerRes.message.text, '[Sticker attached]');
  });

  it('ignores self-originated WhatsApp messages (fromMe = true)', () => {
    const result = normalizeWhatsAppEvent({
      eventId: 'evt-self',
      messageId: 'msg-self',
      chatId: '15551234567@s.whatsapp.net',
      senderId: '15551234567@s.whatsapp.net',
      fromMe: true,
      timestampMs: 1700000000000,
      messageContent: { conversation: 'Echo test' },
    });

    assert.equal(result.kind, 'ignored');
    assert.equal(result.reason, 'self_originated');
  });

  it('safely ignores protocol or unsupported WhatsApp messages without throwing', () => {
    const protoRes = normalizeWhatsAppEvent({
      eventId: 'evt-proto',
      messageId: 'msg-proto',
      chatId: '15551234567@s.whatsapp.net',
      senderId: '15551234567@s.whatsapp.net',
      fromMe: false,
      timestampMs: 1700000000000,
      messageContent: { reactionMessage: { text: '👍' } },
    });
    assert.equal(protoRes.kind, 'ignored');
    assert.equal(protoRes.reason, 'protocol_or_metadata_event');

    const unsupportedRes = normalizeWhatsAppEvent({
      eventId: 'evt-loc',
      messageId: 'msg-loc',
      chatId: '15551234567@s.whatsapp.net',
      senderId: '15551234567@s.whatsapp.net',
      fromMe: false,
      timestampMs: 1700000000000,
      messageContent: { locationMessage: { degreesLatitude: 0 } },
    });
    assert.equal(unsupportedRes.kind, 'ignored');
    assert.match(unsupportedRes.reason, /^unsupported_message_type/);
  });

  it('strips email quotes and signatures correctly with stripEmailQuotes', () => {
    const rawReply = `Thanks for the reply! We can meet at 3pm.

On Mon, Oct 21, 2026 at 10:00 AM Alice wrote:
> Are you available tomorrow?
> Please let me know.

-- 
John Doe
Software Engineer`;

    assert.equal(stripEmailQuotes(rawReply), 'Thanks for the reply! We can meet at 3pm.');

    const outlookReply = `Sounds good.

From: Alice <alice@example.com>
Sent: Monday, October 21, 2026
To: John <john@example.com>
Subject: Meeting

Original message`;

    assert.equal(stripEmailQuotes(outlookReply), 'Sounds good.');

    const originalMsgDivider = `Confirmed.

--- Original Message ---
From: Alice
Subject: Meeting`;

    assert.equal(stripEmailQuotes(originalMsgDivider), 'Confirmed.');

    const mobileSig = `Will do.

Sent from my iPhone`;

    assert.equal(stripEmailQuotes(mobileSig), 'Will do.');

    const spanishWrappedReply = `Lo sé. Si, acá yo estoy bien. Un beso

El mié, 21 oct 2026 a las 17:21, Anné Betancourt López (<
veronicabridgerp@gmail.com>) escribió:
> Hola, cómo estás?`;

    assert.equal(stripEmailQuotes(spanishWrappedReply), 'Lo sé. Si, acá yo estoy bien. Un beso');

    const spanishSig = `Nos vemos mañana.

Enviado desde mi iPhone`;

    assert.equal(stripEmailQuotes(spanishSig), 'Nos vemos mañana.');
  });

  it('normalizes inbound email event and preserves sender and targetChatId', () => {
    const emailResult = normalizeEmailEvent(
      {
        messageId: 'email-msg-1',
        sender: 'user@example.com',
        targetChatId: '15551234567@s.whatsapp.net',
        body: `Yes, let's do it.\n\nOn Mon, Oct 21, 2026 Alice wrote:\n> Want to grab lunch?`,
        receivedAt: '2026-10-21T12:00:00.000Z',
      },
      () => 'fixed-uuid-email'
    );

    assert.equal(emailResult.kind, 'normalized');
    assert.deepEqual(emailResult.message, {
      id: 'fixed-uuid-email',
      sourceChannel: 'email',
      sourceMessageId: 'email-msg-1',
      senderId: 'user@example.com',
      senderName: null,
      conversationId: '15551234567@s.whatsapp.net',
      targetChatId: '15551234567@s.whatsapp.net',
      text: "Yes, let's do it.",
      messageType: 'text',
      createdAt: '2026-10-21T12:00:00.000Z',
    });
  });

  it('ignores empty email body after quote stripping', () => {
    const emptyResult = normalizeEmailEvent({
      messageId: 'email-msg-2',
      sender: 'user@example.com',
      targetChatId: '15551234567@s.whatsapp.net',
      body: `\n> Quoted text only\n\nSent from my iPhone`,
    });

    assert.equal(emptyResult.kind, 'ignored');
    assert.equal(emptyResult.reason, 'empty_email_body');
  });
});
