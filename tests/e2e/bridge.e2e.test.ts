import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { BridgeApplication } from '../../src/app.js';
import { validateConfigObject } from '../../src/config/loader.js';
import { createLogger } from '../../src/observability/logger.js';
import type {
  InboundWhatsAppHandler,
  WhatsAppAdapter,
  WhatsAppReceiptUpdateHandler,
} from '../../src/adapters/whatsapp/interface.js';
import { AmbiguousDeliveryError } from '../../src/domain/errors.js';
import type {
  EmailAdapter,
  InboundEmailHandler,
  RawEmailInboundEvent,
  SendEmailParams,
} from '../../src/adapters/email/interface.js';
import type { ConnectionState, SendMessageResult } from '../../src/domain/types.js';
import type { RawWhatsAppInboundEvent } from '../../src/domain/normalizer.js';

const TARGET_CHAT_ID = '15551234567@s.whatsapp.net';
const USER_EMAIL = 'user@example.com';
const TEST_EMAIL_PASSWORD = 'super-secret-email-password';

class FakeWhatsAppAdapter implements WhatsAppAdapter {
  public state: ConnectionState = 'connected';
  public sentMessages: Array<{ chatId: string; text: string; providerMessageId: string }> = [];
  private inboundHandlers: InboundWhatsAppHandler[] = [];
  private receiptHandlers: WhatsAppReceiptUpdateHandler[] = [];
  private sentIds = new Set<string>();
  private counter = 0;

  public async start(): Promise<void> {
    this.state = 'connected';
  }

  public async stop(): Promise<void> {
    this.state = 'disconnected';
  }

  public getConnectionState(): ConnectionState {
    return this.state;
  }

  public isReadyForSend(): boolean {
    return this.state === 'connected';
  }

  public onInboundMessage(handler: InboundWhatsAppHandler): void {
    this.inboundHandlers.push(handler);
  }

  public onReceiptUpdate(handler: WhatsAppReceiptUpdateHandler): void {
    this.receiptHandlers.push(handler);
  }

  public async sendTextMessage(chatId: string, text: string): Promise<SendMessageResult> {
    const id = `wa-sent-${++this.counter}`;
    this.sentIds.add(id);
    this.sentMessages.push({ chatId, text, providerMessageId: id });
    return {
      providerMessageId: id,
      status: 'submitted',
    };
  }

  public emitInbound(event: RawWhatsAppInboundEvent): void {
    if (event.fromMe || this.sentIds.has(event.eventId)) {
      return;
    }
    for (const h of this.inboundHandlers) {
      void h(event);
    }
  }

  public emitReceipt(providerMessageId: string): void {
    for (const h of this.receiptHandlers) {
      void h({ providerMessageId, status: 'delivered' });
    }
  }
}

class FakeEmailAdapter implements EmailAdapter {
  public healthy = true;
  public sentEmails: Array<SendEmailParams & { messageId: string }> = [];
  private inboundHandlers: InboundEmailHandler[] = [];
  private counter = 0;
  public nextSendError: Error | null = null;

  public async start(): Promise<void> {
    this.healthy = true;
  }

  public async stop(): Promise<void> {
    this.healthy = false;
  }

  public isHealthy(): boolean {
    return this.healthy;
  }

  public onInboundEmail(handler: InboundEmailHandler): void {
    this.inboundHandlers.push(handler);
  }

  public async sendEmail(params: SendEmailParams): Promise<SendMessageResult> {
    if (this.nextSendError) {
      const err = this.nextSendError;
      this.nextSendError = null;
      throw err;
    }
    const messageId = `<email-${++this.counter}@bridge.local>`;
    this.sentEmails.push({ ...params, messageId });
    return {
      providerMessageId: messageId,
      status: 'delivered',
    };
  }

  public emitInboundEmail(event: RawEmailInboundEvent): void {
    for (const h of this.inboundHandlers) {
      void h(event);
    }
  }
}

interface SimulatedHttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

async function invokeHandler(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void,
  method: string,
  url: string
): Promise<SimulatedHttpResponse> {
  const req = {
    method,
    url,
    headers: {},
  } as unknown as IncomingMessage;

  let statusCode = 200;
  let headers: Record<string, string> = {};
  let responseBody = '';

  let headersSent = false;
  const res = {
    headersSent: false,
    writeHead(code: number, hdrs?: Record<string, string>) {
      statusCode = code;
      if (hdrs) {
        headers = { ...hdrs };
      }
      headersSent = true;
      (this as any).headersSent = true;
      return this;
    },
    end(chunk?: string | Buffer) {
      if (chunk) {
        responseBody += chunk.toString();
      }
      return this;
    },
  } as unknown as ServerResponse;

  await handler(req, res);
  return { statusCode, headers, body: responseBody };
}

function createTestEnvironment(dbPath: string, authDir: string) {
  const logLines: string[] = [];
  const logger = createLogger({
    level: 'info',
    destination: {
      write(chunk: string) {
        logLines.push(chunk);
      },
    },
  });

  const config = validateConfigObject(
    {
      whatsapp: {
        enabled: true,
        targetChatId: TARGET_CHAT_ID,
        authDirectory: authDir,
      },
      email: {
        smtp: {
          host: 'smtp.example.com',
          port: 587,
          secure: false,
          user: 'bridge@example.com',
          fromAddress: 'bridge@example.com',
        },
        imap: {
          host: 'imap.example.com',
          port: 993,
          secure: true,
          user: 'bridge@example.com',
          enabled: true,
        },
        userEmail: USER_EMAIL,
        replyDomain: 'bridge.example.com',
      },
      routing: {
        whatsappToEmail: true,
        emailToWhatsapp: true,
        allowedEmailSenders: [USER_EMAIL],
      },
      database: {
        path: dbPath,
        retentionDays: 7,
      },
      worker: {
        pollIntervalMs: 50,
        maxAttempts: 3,
        baseBackoffMs: 50,
        maxBackoffMs: 500,
      },
      http: {
        host: '127.0.0.1',
        port: 0,
      },
    },
    { emailPassword: TEST_EMAIL_PASSWORD }
  );

  const whatsappAdapter = new FakeWhatsAppAdapter();
  const emailAdapter = new FakeEmailAdapter();

  const app = new BridgeApplication(config, {
    logger,
    whatsappAdapter,
    emailAdapter,
  });

  return {
    app,
    whatsappAdapter,
    emailAdapter,
    logLines,
  };
}

describe('End-to-End Bridge Scenarios (WhatsApp <-> Email)', () => {
  it('completes all core WhatsApp <-> Email bridge scenarios deterministically', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-email-e2e-'));
    const dbPath = path.join(tmpDir, 'bridge.sqlite');
    const authDir = path.join(tmpDir, 'auth');

    let env = createTestEnvironment(dbPath, authDir);

    try {
      // -----------------------------------------------------------------------
      // Scenario 1: Send a WhatsApp message and verify corresponding Email is delivered
      // -----------------------------------------------------------------------
      env.whatsappAdapter.emitInbound({
        eventId: 'wa-msg-1',
        messageId: 'wa-msg-1',
        chatId: TARGET_CHAT_ID,
        senderId: TARGET_CHAT_ID,
        senderName: 'Alice',
        fromMe: false,
        timestampMs: Date.now(),
        messageContent: {
          conversation: 'Are we meeting at 19:00?',
        },
      });

      await env.app.worker.runTick();

      assert.equal(env.emailAdapter.sentEmails.length, 1);
      assert.equal(env.emailAdapter.sentEmails[0]?.to, USER_EMAIL);
      assert.equal(env.emailAdapter.sentEmails[0]?.senderName, 'Alice');
      assert.equal(env.emailAdapter.sentEmails[0]?.text, 'Are we meeting at 19:00?');
      assert.equal(env.emailAdapter.sentEmails[0]?.chatId, TARGET_CHAT_ID);

      // -----------------------------------------------------------------------
      // Scenario 2: Send an Email reply and verify WhatsApp message is delivered (with quotes stripped)
      // -----------------------------------------------------------------------
      env.emailAdapter.emitInboundEmail({
        messageId: '<reply-email-001@mail.client.com>',
        from: USER_EMAIL,
        to: `bridge+${TARGET_CHAT_ID}@bridge.example.com`,
        subject: 'Re: WhatsApp: Alice',
        body: 'Yes, see you at 19:00!\n\nOn Oct 21, 2026, Alice wrote:\n> Are we meeting at 19:00?',
        targetChatId: TARGET_CHAT_ID,
        receivedAt: new Date().toISOString(),
      });

      await env.app.worker.runTick();

      assert.equal(env.whatsappAdapter.sentMessages.length, 1);
      assert.equal(env.whatsappAdapter.sentMessages[0]?.chatId, TARGET_CHAT_ID);
      assert.equal(
        env.whatsappAdapter.sentMessages[0]?.text,
        'Yes, see you at 19:00!'
      );

      // -----------------------------------------------------------------------
      // Scenario 3: Send a WhatsApp image and verify placeholder is delivered to Email
      // -----------------------------------------------------------------------
      env.whatsappAdapter.emitInbound({
        eventId: 'wa-img-1',
        messageId: 'wa-img-1',
        chatId: TARGET_CHAT_ID,
        senderId: TARGET_CHAT_ID,
        senderName: 'Alice',
        fromMe: false,
        timestampMs: Date.now(),
        messageContent: {
          imageMessage: { caption: 'Photo of the venue' },
        },
      });

      await env.app.worker.runTick();
      assert.equal(env.emailAdapter.sentEmails.length, 2);
      assert.equal(
        env.emailAdapter.sentEmails[1]?.text,
        'Photo of the venue [Image attached]'
      );

      // -----------------------------------------------------------------------
      // Scenario 3b: Send a WhatsApp voice recording and verify audio attachment is delivered
      // -----------------------------------------------------------------------
      const audioFilePath = path.join(tmpDir, 'test-voice.ogg');
      const sampleAudioData = Buffer.from('FAKE-OGG-AUDIO-CONTENT-UNDER-2MB');
      fs.writeFileSync(audioFilePath, sampleAudioData);

      env.whatsappAdapter.emitInbound({
        eventId: 'wa-audio-1',
        messageId: 'wa-audio-1',
        chatId: TARGET_CHAT_ID,
        senderId: TARGET_CHAT_ID,
        senderName: 'Alice',
        fromMe: false,
        timestampMs: Date.now(),
        messageContent: {
          audioMessage: { ptt: true },
        },
        mediaPath: audioFilePath,
      });

      await env.app.worker.runTick();
      assert.equal(env.emailAdapter.sentEmails.length, 3);
      const audioEmail = env.emailAdapter.sentEmails[2]!;
      assert.equal(audioEmail.text, '[Audio attached]');
      assert.equal(audioEmail.attachments?.length, 1);
      assert.equal(audioEmail.attachments[0]?.filename, 'voice-message.ogg');
      assert.equal(audioEmail.attachments[0]?.contentType, 'audio/ogg');
      assert.equal(
        Buffer.compare(audioEmail.attachments[0]?.content as Buffer, sampleAudioData),
        0
      );

      // -----------------------------------------------------------------------
      // Scenario 4: Deliver the same inbound email twice and verify deduplication
      // -----------------------------------------------------------------------
      const jobCountBefore = env.app.deliveryJobs.listAll().length;
      env.emailAdapter.emitInboundEmail({
        messageId: '<reply-email-001@mail.client.com>', // same messageId
        from: USER_EMAIL,
        to: `bridge+${TARGET_CHAT_ID}@bridge.example.com`,
        subject: 'Re: WhatsApp: Alice',
        body: 'Duplicate reply',
        targetChatId: TARGET_CHAT_ID,
        receivedAt: new Date().toISOString(),
      });

      await env.app.worker.runTick();
      assert.equal(env.app.deliveryJobs.listAll().length, jobCountBefore);

      // -----------------------------------------------------------------------
      // Scenario 5: Process restart recovery survives with pending jobs
      // -----------------------------------------------------------------------
      env.whatsappAdapter.emitInbound({
        eventId: 'wa-before-restart',
        messageId: 'wa-before-restart',
        chatId: TARGET_CHAT_ID,
        senderId: TARGET_CHAT_ID,
        senderName: 'Alice',
        fromMe: false,
        timestampMs: Date.now(),
        messageContent: {
          conversation: 'Survives restart',
        },
      });

      // Close database before running worker
      env.app.db.close();

      // Restart application on the same SQLite database
      env = createTestEnvironment(dbPath, authDir);
      env.app.deliveryJobs.recoverInFlightJobs();
      await env.app.worker.runTick();

      assert.equal(env.emailAdapter.sentEmails.length, 1);
      assert.equal(env.emailAdapter.sentEmails[0]?.text, 'Survives restart');

      // -----------------------------------------------------------------------
      // Scenario 6: Disconnect WhatsApp and verify email jobs remain queued
      // -----------------------------------------------------------------------
      env.whatsappAdapter.state = 'disconnected';
      env.emailAdapter.emitInboundEmail({
        messageId: '<queued-email-001@mail.client.com>',
        from: USER_EMAIL,
        to: `bridge+${TARGET_CHAT_ID}@bridge.example.com`,
        subject: 'Re: Offline test',
        body: 'Sent while WhatsApp is offline',
        targetChatId: TARGET_CHAT_ID,
        receivedAt: new Date().toISOString(),
      });

      await env.app.worker.runTick();
      // Should remain queued
      assert.equal(env.whatsappAdapter.sentMessages.length, 0);
      assert.equal(env.app.deliveryJobs.getCountsByStatus().pending, 1);

      // Reconnect WhatsApp and run worker
      env.whatsappAdapter.state = 'connected';
      await env.app.worker.runTick();
      assert.equal(env.whatsappAdapter.sentMessages.length, 1);
      assert.equal(
        env.whatsappAdapter.sentMessages[0]?.text,
        'Sent while WhatsApp is offline'
      );

      // -----------------------------------------------------------------------
      // Scenario 7: Ambiguous timeout does not blindly resend
      // -----------------------------------------------------------------------
      env.emailAdapter.nextSendError = new AmbiguousDeliveryError(
        'Socket timeout during email send',
        'ETIMEDOUT'
      );

      env.whatsappAdapter.emitInbound({
        eventId: 'wa-ambiguous-1',
        messageId: 'wa-ambiguous-1',
        chatId: TARGET_CHAT_ID,
        senderId: TARGET_CHAT_ID,
        senderName: 'Alice',
        fromMe: false,
        timestampMs: Date.now(),
        messageContent: {
          conversation: 'Did this email send?',
        },
      });

      await env.app.worker.runTick();
      assert.equal(env.app.deliveryJobs.getCountsByStatus().unknown, 1);

      const emailCountAfterTimeout = env.emailAdapter.sentEmails.length;
      await env.app.worker.runTick();
      assert.equal(env.emailAdapter.sentEmails.length, emailCountAfterTimeout);

      // -----------------------------------------------------------------------
      // Scenario 8: Reject inbound Email from unauthorized sender
      // -----------------------------------------------------------------------
      const waCountBefore = env.whatsappAdapter.sentMessages.length;
      env.emailAdapter.emitInboundEmail({
        messageId: '<spam-001@stranger.com>',
        from: 'stranger@spammer.org',
        to: `bridge+${TARGET_CHAT_ID}@bridge.example.com`,
        subject: 'Spam',
        body: 'Buy crypto',
        targetChatId: TARGET_CHAT_ID,
        receivedAt: new Date().toISOString(),
      });

      await env.app.worker.runTick();
      assert.equal(env.whatsappAdapter.sentMessages.length, waCountBefore);

      // -----------------------------------------------------------------------
      // Scenario 9: WhatsApp message from unconfigured chat is not forwarded
      // -----------------------------------------------------------------------
      env.whatsappAdapter.emitInbound({
        eventId: 'wa-unconfigured-1',
        messageId: 'wa-unconfigured-1',
        chatId: '15559999999@s.whatsapp.net',
        senderId: '15559999999@s.whatsapp.net',
        senderName: 'Stranger',
        fromMe: false,
        timestampMs: Date.now(),
        messageContent: {
          conversation: 'Should not reach email',
        },
      });

      await env.app.worker.runTick();
      assert.equal(env.emailAdapter.sentEmails.length, emailCountAfterTimeout);

      // -----------------------------------------------------------------------
      // Scenario 10: Loop prevention (self-sent WhatsApp messages ignored)
      // -----------------------------------------------------------------------
      env.whatsappAdapter.emitInbound({
        eventId: 'wa-self-1',
        messageId: 'wa-self-1',
        chatId: TARGET_CHAT_ID,
        senderId: TARGET_CHAT_ID,
        senderName: 'Me',
        fromMe: true,
        timestampMs: Date.now(),
        messageContent: {
          conversation: 'Sent from my own WhatsApp client',
        },
      });

      await env.app.worker.runTick();
      assert.equal(env.emailAdapter.sentEmails.length, emailCountAfterTimeout);

      // -----------------------------------------------------------------------
      // Health endpoints & sanitization check
      // -----------------------------------------------------------------------
      const liveRes = await invokeHandler(
        (req, res) => env.app.httpServer['options'].healthHandlers.handleLive(req, res),
        'GET',
        '/health/live'
      );
      assert.equal(liveRes.statusCode, 200);

      const readyRes = await invokeHandler(
        (req, res) => env.app.httpServer['options'].healthHandlers.handleReady(req, res),
        'GET',
        '/health/ready'
      );
      assert.equal(readyRes.statusCode, 200);
      assert.equal(readyRes.body.includes(TEST_EMAIL_PASSWORD), false);
      assert.equal(readyRes.body.includes(USER_EMAIL), false);
      assert.equal(readyRes.body.includes(TARGET_CHAT_ID), false);

      const combinedLogs = env.logLines.join('\n');
      assert.equal(combinedLogs.includes(TEST_EMAIL_PASSWORD), false);
    } finally {
      env.app.db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('bridges all WhatsApp chats to email with individual threading when targetChatId is "*"', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-email-allchats-'));
    const dbPath = path.join(tmpDir, 'bridge.sqlite');
    const authDir = path.join(tmpDir, 'auth');

    const config = validateConfigObject(
      {
        whatsapp: {
          enabled: true,
          targetChatId: '*',
          authDirectory: authDir,
        },
        email: {
          smtp: {
            host: 'smtp.example.com',
            port: 587,
            secure: false,
            user: 'bridge@example.com',
            fromAddress: 'bridge@example.com',
          },
          imap: {
            host: 'imap.example.com',
            port: 993,
            secure: true,
            user: 'bridge@example.com',
            enabled: true,
          },
          userEmail: USER_EMAIL,
          replyDomain: 'bridge.example.com',
        },
        routing: {
          whatsappToEmail: true,
          emailToWhatsapp: true,
          allowedEmailSenders: [USER_EMAIL],
        },
        database: {
          path: dbPath,
          retentionDays: 7,
        },
        worker: {
          pollIntervalMs: 50,
          maxAttempts: 3,
          baseBackoffMs: 50,
          maxBackoffMs: 500,
        },
        http: {
          host: '127.0.0.1',
          port: 0,
        },
      },
      { emailPassword: TEST_EMAIL_PASSWORD }
    );

    const whatsappAdapter = new FakeWhatsAppAdapter();
    const emailAdapter = new FakeEmailAdapter();
    const app = new BridgeApplication(config, {
      whatsappAdapter,
      emailAdapter,
    });

    try {
      // 1. Message from Alice
      const ALICE_CHAT = 'alice123@s.whatsapp.net';
      whatsappAdapter.emitInbound({
        eventId: 'wa-msg-alice-1',
        messageId: 'wa-msg-alice-1',
        chatId: ALICE_CHAT,
        senderId: ALICE_CHAT,
        senderName: 'Alice',
        fromMe: false,
        timestampMs: Date.now(),
        messageContent: { conversation: 'Hey, lunch today?' },
      });
      await app.worker.runTick();

      assert.equal(emailAdapter.sentEmails.length, 1);
      assert.equal(emailAdapter.sentEmails[0]?.chatId, ALICE_CHAT);
      assert.equal(emailAdapter.sentEmails[0]?.subject, 'WhatsApp: Alice');
      assert.equal(emailAdapter.sentEmails[0]?.text, 'Hey, lunch today?');

      // 2. Message from Bob
      const BOB_CHAT = 'bob987@s.whatsapp.net';
      whatsappAdapter.emitInbound({
        eventId: 'wa-msg-bob-1',
        messageId: 'wa-msg-bob-1',
        chatId: BOB_CHAT,
        senderId: BOB_CHAT,
        senderName: 'Bob',
        fromMe: false,
        timestampMs: Date.now(),
        messageContent: { conversation: 'Did you review the PR?' },
      });
      await app.worker.runTick();

      assert.equal(emailAdapter.sentEmails.length, 2);
      assert.equal(emailAdapter.sentEmails[1]?.chatId, BOB_CHAT);
      assert.equal(emailAdapter.sentEmails[1]?.subject, 'WhatsApp: Bob');
      assert.equal(emailAdapter.sentEmails[1]?.text, 'Did you review the PR?');

      // 3. User replies to Bob via Email
      emailAdapter.emitInboundEmail({
        messageId: '<reply-to-bob@mail.client.com>',
        from: USER_EMAIL,
        to: `bridge+${BOB_CHAT}@bridge.example.com`,
        subject: 'Re: WhatsApp: Bob',
        body: 'Reviewing it now!',
        targetChatId: BOB_CHAT,
        receivedAt: new Date().toISOString(),
      });
      await app.worker.runTick();

      assert.equal(whatsappAdapter.sentMessages.length, 1);
      assert.equal(whatsappAdapter.sentMessages[0]?.chatId, BOB_CHAT);
      assert.equal(
        whatsappAdapter.sentMessages[0]?.text,
        'Reviewing it now!'
      );

      // 4. User replies to Alice via Email
      emailAdapter.emitInboundEmail({
        messageId: '<reply-to-alice@mail.client.com>',
        from: USER_EMAIL,
        to: `bridge+${ALICE_CHAT}@bridge.example.com`,
        subject: 'Re: WhatsApp: Alice',
        body: 'Sure, 12:30!',
        targetChatId: ALICE_CHAT,
        receivedAt: new Date().toISOString(),
      });
      await app.worker.runTick();

      assert.equal(whatsappAdapter.sentMessages.length, 2);
      assert.equal(whatsappAdapter.sentMessages[1]?.chatId, ALICE_CHAT);
      assert.equal(
        whatsappAdapter.sentMessages[1]?.text,
        'Sure, 12:30!'
      );

      // 4b. User replies directly without plus tag in To, resolved via In-Reply-To thread lookup
      emailAdapter.emitInboundEmail({
        messageId: '<reply-thread-lookup@mail.client.com>',
        from: USER_EMAIL,
        to: 'bridge@bridge.example.com',
        subject: 'Re: WhatsApp: Alice',
        body: 'See you there!',
        targetChatId: '',
        inReplyTo: emailAdapter.sentEmails[0]?.messageId,
        receivedAt: new Date().toISOString(),
      });
      await app.worker.runTick();

      assert.equal(whatsappAdapter.sentMessages.length, 3);
      assert.equal(whatsappAdapter.sentMessages[2]?.chatId, ALICE_CHAT);
      assert.equal(
        whatsappAdapter.sentMessages[2]?.text,
        'See you there!'
      );

      // 5. Group chat message is safely ignored
      const GROUP_CHAT = 'dev-team@g.us';
      whatsappAdapter.emitInbound({
        eventId: 'wa-msg-group-1',
        messageId: 'wa-msg-group-1',
        chatId: GROUP_CHAT,
        senderId: ALICE_CHAT,
        senderName: 'Alice',
        fromMe: false,
        timestampMs: Date.now(),
        messageContent: { conversation: 'Group notification' },
      });
      await app.worker.runTick();

      // Email count remains 2
      assert.equal(emailAdapter.sentEmails.length, 2);
    } finally {
      app.db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
