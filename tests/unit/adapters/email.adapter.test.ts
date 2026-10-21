import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  NodemailerEmailAdapter,
  mapEmailError,
  extractDomain,
  extractEmailUser,
  encodeChatIdForEmail,
  decodeChatIdFromEmail,
  extractTargetChatId,
  parseEmailSource,
  decodeQuotedPrintable,
  type EmailAdapterOptions,
  type ImapClientLike,
  type ImapFetchMessage,
  type TransporterLike,
} from '../../../src/adapters/email/index.js';
import {
  AmbiguousDeliveryError,
  AuthDeliveryError,
  PermanentDeliveryError,
  TransientDeliveryError,
} from '../../../src/domain/errors.js';
import type { RawEmailInboundEvent } from '../../../src/adapters/email/interface.js';

class MockTransporter implements TransporterLike {
  public sentMail: any[] = [];
  public shouldFailWith: Error | null = null;
  public closed = false;

  async sendMail(options: any): Promise<any> {
    if (this.shouldFailWith) {
      throw this.shouldFailWith;
    }
    this.sentMail.push(options);
    return {
      messageId: options.messageId || '<mock-id@domain.com>',
      response: '250 OK',
    };
  }

  async verify(): Promise<true> {
    return true;
  }

  close(): void {
    this.closed = true;
  }
}

class MockImapClient extends EventEmitter implements ImapClientLike {
  public connected = false;
  public loggedOut = false;
  public closed = false;
  public mailboxLocked: string | null = null;
  public idled = false;
  public usable = true;
  public messagesToReturn: ImapFetchMessage[] = [];
  public markedFlags: Array<{ range: any; flags: string[] }> = [];
  private idleResolvers: Array<() => void> = [];

  async connect(): Promise<void> {
    this.connected = true;
  }

  async logout(): Promise<void> {
    this.loggedOut = true;
    this.connected = false;
    this.wakeIdle();
  }

  close(): void {
    this.closed = true;
    this.connected = false;
    this.wakeIdle();
  }

  private wakeIdle(): void {
    const resolvers = this.idleResolvers;
    this.idleResolvers = [];
    for (const r of resolvers) {
      r();
    }
  }

  async getMailboxLock(mailbox: string) {
    this.mailboxLocked = mailbox;
    return {
      release: () => {
        if (this.mailboxLocked === mailbox) {
          this.mailboxLocked = null;
        }
      },
    };
  }

  async idle(): Promise<boolean | undefined> {
    this.idled = true;
    return new Promise((resolve) => {
      this.idleResolvers.push(() => resolve(true));
    });
  }

  async search(query?: any, options?: any): Promise<number[] | false> {
    return this.messagesToReturn.map((m) => m.uid);
  }

  async *fetch() {
    for (const msg of this.messagesToReturn) {
      yield msg;
    }
  }

  async messageFlagsAdd(range: any, flags: string[]) {
    this.markedFlags.push({ range, flags });
    return true;
  }
}

describe('Email Adapter - SMTP Outbound Sending', () => {
  const baseOptions: EmailAdapterOptions = {
    smtp: {
      host: 'smtp.example.com',
      port: 587,
      fromAddress: 'bridge@example.com',
      domain: 'example.com',
    },
    imap: {
      host: 'imap.example.com',
      port: 993,
      enabled: false,
    },
  };

  it('sends email with all RFC threading and metadata headers', async () => {
    const mockTransporter = new MockTransporter();
    const adapter = new NodemailerEmailAdapter({
      ...baseOptions,
      transporter: mockTransporter,
    });

    await adapter.start();
    assert.equal(adapter.isHealthy(), true);

    const result = await adapter.sendEmail({
      to: 'recipient@example.com',
      chatId: '15551234567@s.whatsapp.net',
      senderName: 'Alice',
      subject: 'WhatsApp: Alice',
      text: 'Hello from WhatsApp!',
      conversationId: 'conv-98765',
    });

    assert.equal(result.status, 'submitted');
    assert.match(result.providerMessageId, /^<wa-\d+-[a-f0-9]+@example\.com>$/);

    assert.equal(mockTransporter.sentMail.length, 1);
    const sent = mockTransporter.sentMail[0];

    assert.equal(sent.to, 'recipient@example.com');
    assert.equal(sent.from, '"Alice" <bridge@example.com>');
    assert.equal(sent.subject, 'WhatsApp: Alice');
    assert.equal(sent.text, 'Hello from WhatsApp!');
    assert.equal(sent.replyTo, '<bridge+15551234567__s.whatsapp.net@example.com>');

    // Threading headers
    assert.match(sent.messageId, /^<wa-\d+-[a-f0-9]+@example\.com>$/);
    assert.equal(sent.inReplyTo, '<chat-conv-98765@example.com>');
    assert.equal(sent.references, '<chat-conv-98765@example.com>');
    assert.equal(sent.headers['Message-ID'], sent.messageId);
    assert.equal(sent.headers['In-Reply-To'], '<chat-conv-98765@example.com>');
    assert.equal(sent.headers['References'], '<chat-conv-98765@example.com>');

    await adapter.stop();
    assert.equal(adapter.isHealthy(), false);
    assert.equal(mockTransporter.closed, true);
  });

  it('groups multiple messages in the same WhatsApp chat with identical threading references', async () => {
    const mockTransporter = new MockTransporter();
    const adapter = new NodemailerEmailAdapter({
      ...baseOptions,
      transporter: mockTransporter,
    });

    await adapter.start();

    await adapter.sendEmail({
      to: 'recipient@example.com',
      chatId: '15551234567',
      senderName: 'Bob',
      subject: 'WhatsApp: Bob',
      text: 'First message',
      conversationId: 'chat-thread-42',
    });

    await adapter.sendEmail({
      to: 'recipient@example.com',
      chatId: '15551234567',
      senderName: 'Bob',
      subject: 'WhatsApp: Bob',
      text: 'Second message in conversation',
      conversationId: 'chat-thread-42',
    });

    assert.equal(mockTransporter.sentMail.length, 2);
    const first = mockTransporter.sentMail[0];
    const second = mockTransporter.sentMail[1];

    // Unique Message-IDs
    assert.notEqual(first.messageId, second.messageId);

    // Identical threading references for email client conversation grouping
    assert.equal(first.inReplyTo, '<chat-chat-thread-42@example.com>');
    assert.equal(second.inReplyTo, '<chat-chat-thread-42@example.com>');
    assert.equal(first.references, '<chat-chat-thread-42@example.com>');
    assert.equal(second.references, '<chat-chat-thread-42@example.com>');

    await adapter.stop();
  });

  it('falls back to "WhatsApp" display name when senderName is null or undefined', async () => {
    const mockTransporter = new MockTransporter();
    const adapter = new NodemailerEmailAdapter({
      ...baseOptions,
      transporter: mockTransporter,
    });

    await adapter.start();

    await adapter.sendEmail({
      to: 'recipient@example.com',
      chatId: '15551234567',
      senderName: null,
      subject: 'WhatsApp: 15551234567',
      text: 'Anonymous ping',
      conversationId: 'anon-1',
    });

    assert.equal(mockTransporter.sentMail[0].from, '"WhatsApp" <bridge@example.com>');
    await adapter.stop();
  });

  it('supports custom replyToPattern option', async () => {
    const mockTransporter = new MockTransporter();
    const adapter = new NodemailerEmailAdapter({
      smtp: {
        host: 'smtp.example.com',
        port: 587,
        fromAddress: 'bot@mycustomdomain.org',
        replyToPattern: 'wa+{chatId}@{domain}',
      },
      imap: {
        host: 'imap.example.com',
        port: 993,
        enabled: false,
      },
      transporter: mockTransporter,
    });

    await adapter.start();

    await adapter.sendEmail({
      to: 'recipient@example.com',
      chatId: '447123456789',
      subject: 'Custom reply-to',
      text: 'Testing custom reply pattern',
      conversationId: 'pattern-1',
    });

    assert.equal(mockTransporter.sentMail[0].replyTo, 'wa+447123456789@mycustomdomain.org');
    await adapter.stop();
  });
});

describe('Email Adapter - IMAP Inbound IDLE & Message Processing', () => {
  it('connects to IMAP, acquires mailbox lock, and handles exists event to emit inbound email', async () => {
    const mockTransporter = new MockTransporter();
    const mockImap = new MockImapClient();

    const receivedEvents: RawEmailInboundEvent[] = [];

    mockImap.messagesToReturn = [
      {
        uid: 101,
        envelope: {
          messageId: '<inbound-101@mail.client.com>',
          from: [{ name: 'User Someone', address: 'user@external.com' }],
          to: [{ name: 'WhatsApp Bridge', address: 'bridge+15551234567@example.com' }],
          subject: 'Re: WhatsApp: Alice',
          date: new Date('2026-10-21T12:00:00Z'),
        },
        source: Buffer.from(
          'From: user@external.com\r\nTo: bridge+15551234567@example.com\r\nSubject: Re: WhatsApp: Alice\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSounds good! Let us meet then.'
        ),
      },
    ];

    const adapter = new NodemailerEmailAdapter({
      smtp: {
        host: 'smtp.example.com',
        port: 587,
        fromAddress: 'bridge@example.com',
      },
      imap: {
        host: 'imap.example.com',
        port: 993,
        enabled: true,
        mailbox: 'INBOX',
      },
      transporter: mockTransporter,
      imapClient: mockImap,
    });

    adapter.onInboundEmail((event) => {
      receivedEvents.push(event);
    });

    await adapter.start();

    assert.equal(mockImap.connected, true);
    assert.equal(mockImap.mailboxLocked, 'INBOX');
    assert.equal(mockImap.idled, true);
    assert.equal(adapter.isHealthy(), true);

    // Initial unseen message should have been fetched on connect
    assert.equal(receivedEvents.length, 1);
    const event = receivedEvents[0]!;
    assert.equal(event.messageId, '<inbound-101@mail.client.com>');
    assert.equal(event.from, 'user@external.com');
    assert.equal(event.to, 'bridge+15551234567@example.com');
    assert.equal(event.subject, 'Re: WhatsApp: Alice');
    assert.equal(event.body, 'Sounds good! Let us meet then.');
    assert.equal(event.targetChatId, '15551234567');
    assert.equal(event.receivedAt, '2026-10-21T12:00:00.000Z');

    // Should have marked message as \Seen
    assert.equal(mockImap.markedFlags.length, 1);
    assert.deepEqual(mockImap.markedFlags[0]?.flags, ['\\Seen']);

    // Now simulate an exists event with a new message arriving
    mockImap.messagesToReturn = [
      {
        uid: 102,
        envelope: {
          messageId: '<inbound-102@mail.client.com>',
          from: [{ address: 'friend@test.org' }],
          to: [{ address: 'bridge+999888777@example.com' }],
          subject: 'Another reply',
          date: new Date('2026-10-21T12:05:00Z'),
        },
        text: 'Direct body text from mock',
      },
    ];

    mockImap.emit('exists');

    // Small yield to let async exists handler complete
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(receivedEvents.length, 2);
    assert.equal(receivedEvents[1]?.messageId, '<inbound-102@mail.client.com>');
    assert.equal(receivedEvents[1]?.targetChatId, '999888777');
    assert.equal(receivedEvents[1]?.body, 'Direct body text from mock');

    await adapter.stop();
    assert.equal(mockImap.loggedOut, true);
    assert.equal(mockImap.mailboxLocked, null);
    assert.equal(adapter.isHealthy(), false);
  });

  it('extracts targetChatId from X-Target-Chat-ID header or In-Reply-To when To has no plus-address', async () => {
    const mockTransporter = new MockTransporter();
    const mockImap = new MockImapClient();
    const receivedEvents: RawEmailInboundEvent[] = [];

    mockImap.messagesToReturn = [
      {
        uid: 201,
        envelope: {
          messageId: '<header-id@test.com>',
          to: [{ address: 'plainbridge@example.com' }],
          subject: 'Header routing',
          inReplyTo: '<chat-wa-chat-conv123@example.com>',
        },
        source: Buffer.from(
          'From: boss@corp.com\r\nTo: plainbridge@example.com\r\nX-Target-Chat-ID: custom-chat-456\r\n\r\nBody text'
        ),
      },
    ];

    const adapter = new NodemailerEmailAdapter({
      smtp: { host: 'localhost', port: 25, fromAddress: 'b@e.com' },
      imap: { host: 'localhost', port: 143, enabled: true },
      transporter: mockTransporter,
      imapClient: mockImap,
    });

    adapter.onInboundEmail((ev) => {
      receivedEvents.push(ev);
    });
    await adapter.start();

    assert.equal(receivedEvents.length, 1);
    assert.equal(receivedEvents[0]?.targetChatId, 'custom-chat-456');

    await adapter.stop();
  });

  it('gracefully handles initial IMAP connect failure and schedules reconnect without crashing', async () => {
    const mockTransporter = new MockTransporter();
    const mockImap = new MockImapClient();
    mockImap.connect = async () => {
      throw new Error('getaddrinfo ENOTFOUND imap.invalid');
    };

    const adapter = new NodemailerEmailAdapter({
      smtp: {
        host: 'smtp.example.com',
        port: 587,
        fromAddress: 'bridge@example.com',
      },
      imap: {
        host: 'imap.invalid',
        port: 993,
        enabled: true,
        reconnectDelayMs: 50,
      },
      transporter: mockTransporter,
      imapClient: mockImap,
    });

    await adapter.start();
    assert.equal(adapter.isHealthy(), false);
    await adapter.stop();
  });
});

describe('Email Adapter - Error Mapping', () => {
  it('maps SMTP authentication failures (EAUTH / 535) to AuthDeliveryError', () => {
    const smtpAuthErr = {
      message: 'Invalid login: 535 5.7.8 Error: authentication failed',
      code: 'EAUTH',
      responseCode: 535,
    };
    const mapped = mapEmailError(smtpAuthErr, { phase: 'send' });
    assert(mapped instanceof AuthDeliveryError);
    assert.equal(mapped.category, 'auth');
    assert.equal(mapped.code, 'EAUTH');
  });

  it('maps IMAP authentication failures to AuthDeliveryError', () => {
    const imapAuthErr = {
      name: 'AuthenticationFailure',
      message: 'AUTHENTICATE failed: Invalid credentials',
      code: 'AUTHENTICATIONFAILED',
    };
    const mapped = mapEmailError(imapAuthErr, { phase: 'connect' });
    assert(mapped instanceof AuthDeliveryError);
    assert.equal(mapped.category, 'auth');
  });

  it('maps imapflow Command failed with responseText to AuthDeliveryError', () => {
    const imapFlowErr = {
      message: 'Command failed',
      responseText: '[AUTHENTICATIONFAILED] Invalid credentials (Failure)',
      responseStatus: 'NO',
    };
    const mapped = mapEmailError(imapFlowErr, { phase: 'connect' });
    assert(mapped instanceof AuthDeliveryError);
    assert.equal(mapped.category, 'auth');
    assert.match(mapped.message, /AUTHENTICATIONFAILED/);
  });

  it('maps recipient rejection (EENVELOPE / 550 / 5xx) to PermanentDeliveryError', () => {
    const recipientErr = {
      message: '550 5.1.1 <nobody@example.com>: Recipient address rejected: User unknown',
      code: 'EENVELOPE',
      responseCode: 550,
      rejected: ['nobody@example.com'],
    };
    const mapped = mapEmailError(recipientErr, { phase: 'send' });
    assert(mapped instanceof PermanentDeliveryError);
    assert.equal(mapped.category, 'permanent');
    assert.equal(mapped.code, 'EENVELOPE');
  });

  it('maps network timeouts during send to AmbiguousDeliveryError', () => {
    const timeoutErr = {
      message: 'Connection timed out',
      code: 'ETIMEDOUT',
    };
    const mapped = mapEmailError(timeoutErr, { phase: 'send' });
    assert(mapped instanceof AmbiguousDeliveryError);
    assert.equal(mapped.category, 'ambiguous');
    assert.equal(mapped.code, 'ETIMEDOUT');
  });

  it('maps connection drops / network errors to TransientDeliveryError', () => {
    const connRefused = {
      message: 'connect ECONNREFUSED 127.0.0.1:587',
      code: 'ECONNREFUSED',
    };
    const mapped = mapEmailError(connRefused, { phase: 'connect' });
    assert(mapped instanceof TransientDeliveryError);
    assert.equal(mapped.category, 'transient');
    assert.equal(mapped.code, 'ECONNREFUSED');
  });

  it('re-throws mapped error when sendEmail fails', async () => {
    const mockTransporter = new MockTransporter();
    mockTransporter.shouldFailWith = Object.assign(new Error('550 User unknown'), {
      code: 'EENVELOPE',
      responseCode: 550,
    });

    const adapter = new NodemailerEmailAdapter({
      smtp: { host: 'smtp.example.com', port: 587, fromAddress: 'b@e.com' },
      transporter: mockTransporter,
    });

    await adapter.start();

    await assert.rejects(
      async () => {
        await adapter.sendEmail({
          to: 'unknown@example.com',
          chatId: '123',
          subject: 'Test',
          text: 'Fail',
          conversationId: 'c1',
        });
      },
      (err: any) => {
        assert(err instanceof PermanentDeliveryError);
        assert.equal(err.category, 'permanent');
        return true;
      }
    );

    await adapter.stop();
  });
});

describe('Email Helper Functions', () => {
  it('extractDomain extracts domain name cleanly', () => {
    assert.equal(extractDomain('alice@example.com'), 'example.com');
    assert.equal(extractDomain('"Bridge Service" <bridge@domain.co.uk>'), 'domain.co.uk');
    assert.equal(extractDomain('nodomain'), 'localhost');
  });

  it('decodeQuotedPrintable decodes ascii and multi-byte UTF-8 properly', () => {
    assert.equal(decodeQuotedPrintable('Hello=20world=3D1!'), 'Hello world=1!');
    assert.equal(decodeQuotedPrintable('Caf=C3=A9=20cr=C3=A8me'), 'Café crème');
    assert.equal(decodeQuotedPrintable('soft=\r\nbreak'), 'softbreak');
  });

  it('parseEmailSource parses base64, multipart, and html fallback bodies', () => {
    // 1. Base64
    const base64Email =
      'From: sender@test.com\r\nTo: b@e.com\r\nContent-Transfer-Encoding: base64\r\n\r\nSGVsbG8gZnJvbSBiYXNlNjQ=';
    assert.equal(parseEmailSource(base64Email).text, 'Hello from base64');

    // 2. Multipart alternative
    const multipart =
      'Content-Type: multipart/alternative; boundary="bound1"\r\n\r\n--bound1\r\nContent-Type: text/plain\r\n\r\nPlain version\r\n--bound1\r\nContent-Type: text/html\r\n\r\n<p>HTML</p>\r\n--bound1--';
    assert.equal(parseEmailSource(multipart).text, 'Plain version');

    // 3. HTML only fallback
    const htmlEmail =
      'Content-Type: text/html\r\n\r\n<html><body><h1>Hello</h1>&nbsp;World</body></html>';
    assert.equal(parseEmailSource(htmlEmail).text, 'Hello World');
  });

  it('extractTargetChatId extracts chatId from various formats', () => {
    assert.equal(
      extractTargetChatId({ to: [{ address: 'bridge+34612345678@example.com' }] }),
      '34612345678'
    );
    assert.equal(
      extractTargetChatId({ to: [{ address: 'bridge+alice%40domain.net@example.com' }] }),
      'alice@domain.net'
    );
    assert.equal(
      extractTargetChatId({ to: [{ address: 'veronicabridgerp+64626456797369__lid@gmail.com' }] }),
      '64626456797369@lid'
    );
    assert.equal(
      extractTargetChatId({ to: [{ address: 'veronicabridgerp+15551234567__s.whatsapp.net@gmail.com' }] }),
      '15551234567@s.whatsapp.net'
    );
    assert.equal(
      extractTargetChatId(undefined, { 'delivered-to': 'bridge+987654321@example.com' }),
      '987654321'
    );
    assert.equal(
      extractTargetChatId({ inReplyTo: '<chat-conversation_99@example.com>' }),
      'conversation_99'
    );
    assert.equal(
      extractTargetChatId(undefined, { 'references': '<chat-64626456797369__lid@gmail.com> <wa-12345@gmail.com>' }),
      '64626456797369@lid'
    );
  });

  it('extractEmailUser extracts username from plain or formatted email addresses', () => {
    assert.equal(extractEmailUser('veronicabridgerp@gmail.com'), 'veronicabridgerp');
    assert.equal(extractEmailUser('"Veronica Bridge" <veronicabridgerp@gmail.com>'), 'veronicabridgerp');
    assert.equal(extractEmailUser('hello.world+filter@domain.co.uk'), 'hello.world+filter');
    assert.equal(extractEmailUser('bridge'), 'bridge');
  });

  it('encodeChatIdForEmail and decodeChatIdFromEmail handle WhatsApp JIDs safely without quotes', () => {
    const lid = '64626456797369@lid';
    const encodedLid = encodeChatIdForEmail(lid);
    assert.equal(encodedLid, '64626456797369__lid');
    assert.equal(decodeChatIdFromEmail(encodedLid), lid);

    const phoneJid = '34612345678@s.whatsapp.net';
    const encodedPhone = encodeChatIdForEmail(phoneJid);
    assert.equal(encodedPhone, '34612345678__s.whatsapp.net');
    assert.equal(decodeChatIdFromEmail(encodedPhone), phoneJid);

    const plain = '34612345678';
    assert.equal(encodeChatIdForEmail(plain), '34612345678');
    assert.equal(decodeChatIdFromEmail('34612345678'), '34612345678');
  });
});
