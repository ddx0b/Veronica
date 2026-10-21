import crypto from 'node:crypto';
import nodemailer, { type Transporter, type SendMailOptions } from 'nodemailer';
import { ImapFlow } from 'imapflow';
import type { Logger } from 'pino';
import {
  AmbiguousDeliveryError,
  AuthDeliveryError,
  BridgeError,
  PermanentDeliveryError,
  TransientDeliveryError,
} from '../../domain/errors.js';
import type { SendMessageResult } from '../../domain/types.js';
import type {
  EmailAdapter,
  InboundEmailHandler,
  RawEmailInboundEvent,
  SendEmailParams,
} from './interface.js';

export interface SmtpConfig {
  host: string;
  port: number;
  secure?: boolean;
  auth?: {
    user: string;
    pass: string;
  };
  fromAddress: string;
  domain?: string;
  replyToPattern?: string;
}

export interface ImapConfig {
  host: string;
  port: number;
  secure?: boolean;
  auth?: {
    user: string;
    pass: string;
  };
  enabled: boolean;
  mailbox?: string;
  reconnectDelayMs?: number;
}

export interface ImapMailboxLock {
  release: () => void | Promise<void>;
}

export interface ImapAddress {
  name?: string;
  address?: string;
}

export interface ImapEnvelope {
  date?: Date | string;
  subject?: string;
  messageId?: string;
  inReplyTo?: string;
  from?: ImapAddress[];
  to?: ImapAddress[];
  replyTo?: ImapAddress[];
  cc?: ImapAddress[];
  bcc?: ImapAddress[];
}

export interface ImapFetchMessage {
  uid: number;
  seq?: number;
  envelope?: ImapEnvelope;
  bodyStructure?: any;
  source?: Buffer | string;
  internalDate?: Date | string;
  text?: string;
  body?: string;
}

export interface ImapClientLike {
  connect(): Promise<void>;
  logout(): Promise<void>;
  close(): void;
  getMailboxLock(mailbox: string): Promise<ImapMailboxLock>;
  idle(): Promise<boolean | undefined>;
  fetch(
    range: any,
    query: any,
    options?: any
  ): AsyncIterable<ImapFetchMessage> | Promise<ImapFetchMessage[]> | ImapFetchMessage[];
  messageFlagsAdd?(
    range: any,
    flags: string[],
    options?: any
  ): Promise<boolean>;
  download?(
    range: any,
    part?: string,
    options?: any
  ): Promise<{ content?: NodeJS.ReadableStream; meta?: any }>;
  on(event: string, listener: (...args: any[]) => void): this | void;
  removeListener?(event: string, listener: (...args: any[]) => void): this | void;
  usable?: boolean;
  authenticated?: string | boolean;
}

export type TransporterLike = Pick<Transporter, 'sendMail'> & {
  verify?: () => Promise<unknown>;
  close?: () => void;
};

export interface EmailAdapterOptions {
  smtp: SmtpConfig;
  imap?: ImapConfig;
  logger?: Logger;
  transporter?: TransporterLike;
  imapClient?: ImapClientLike;
}

export function extractDomain(address: string): string {
  const atIdx = address.lastIndexOf('@');
  if (atIdx !== -1) {
    const d = address.slice(atIdx + 1).replace(/[>\s]/g, '').trim();
    if (d) return d;
  }
  return 'localhost';
}

export function extractEmailUser(address: string): string {
  const match = address.match(/<([^>]+)>/);
  const clean = (match && match[1] ? match[1] : address) || '';
  const atIdx = clean.lastIndexOf('@');
  if (atIdx > 0) {
    return clean.slice(0, atIdx).replace(/[<\s]/g, '').trim();
  }
  return clean.replace(/[<>\s]/g, '').trim() || 'bridge';
}

export function encodeChatIdForEmail(chatId: string): string {
  if (!chatId) return '';
  // WhatsApp JIDs contain '@' (e.g. 15551234567@s.whatsapp.net, 64626456797369@lid).
  // Email local-parts cannot contain unquoted '@', and mail providers (like Gmail) reject quoted '@'.
  // We use '__' as a safe, unquoted replacement for '@'.
  return chatId.replace(/@/g, '__');
}

export function decodeChatIdFromEmail(encoded: string): string {
  if (!encoded) return '';
  let decoded = decodeURIComponent(encoded);
  if (decoded.includes('__at__')) {
    decoded = decoded.replace(/__at__/g, '@');
  } else if (decoded.includes('__')) {
    decoded = decoded.replace(/__/g, '@');
  }
  return decoded;
}

export function decodeQuotedPrintable(input: string, encoding: BufferEncoding = 'utf-8'): string {
  const sanitized = input.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < sanitized.length; i++) {
    if (
      sanitized[i] === '=' &&
      i + 2 < sanitized.length &&
      /^[0-9A-Fa-f]{2}$/.test(sanitized.slice(i + 1, i + 3))
    ) {
      bytes.push(parseInt(sanitized.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(sanitized.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString(encoding);
}

export function parseEmailSource(source: Buffer | string): {
  headers: Record<string, string>;
  text: string;
} {
  const str = Buffer.isBuffer(source) ? source.toString('utf-8') : String(source);
  const headerEnd = str.indexOf('\r\n\r\n');
  const headerEndAlt = str.indexOf('\n\n');
  let headerPart = '';
  let bodyPart = '';

  if (headerEnd !== -1) {
    headerPart = str.slice(0, headerEnd);
    bodyPart = str.slice(headerEnd + 4);
  } else if (headerEndAlt !== -1) {
    headerPart = str.slice(0, headerEndAlt);
    bodyPart = str.slice(headerEndAlt + 2);
  } else {
    bodyPart = str;
  }

  const headers: Record<string, string> = {};
  const lines = headerPart.split(/\r?\n/);
  let currentKey = '';
  for (const line of lines) {
    if (/^\s/.test(line) && currentKey) {
      headers[currentKey] += ' ' + line.trim();
    } else {
      const idx = line.indexOf(':');
      if (idx !== -1) {
        currentKey = line.slice(0, idx).toLowerCase().trim();
        headers[currentKey] = line.slice(idx + 1).trim();
      }
    }
  }

  const contentType = headers['content-type'] || 'text/plain';
  const contentTransferEncoding = headers['content-transfer-encoding'] || '';

  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  if (boundaryMatch) {
    const boundary = boundaryMatch[1] || boundaryMatch[2];
    const parts = bodyPart.split('--' + boundary);
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed || trimmed === '--') continue;
      const parsedPart = parseEmailSource(trimmed);
      if (parsedPart.text) {
        return { headers, text: parsedPart.text };
      }
    }
  }

  let decoded = bodyPart;
  const enc = contentTransferEncoding.toLowerCase().trim();
  if (enc === 'base64') {
    try {
      decoded = Buffer.from(bodyPart.replace(/\s+/g, ''), 'base64').toString('utf-8');
    } catch {
      decoded = bodyPart;
    }
  } else if (enc === 'quoted-printable') {
    decoded = decodeQuotedPrintable(bodyPart);
  }

  if (
    contentType.toLowerCase().includes('text/html') &&
    !contentType.toLowerCase().includes('text/plain')
  ) {
    decoded = decoded.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ');
  }

  return { headers, text: decoded.trim() };
}

export function extractTargetChatId(
  envelope?: ImapEnvelope,
  headers?: Record<string, string>
): string {
  // 1. Try envelope To addresses
  if (envelope?.to) {
    for (const recipient of envelope.to) {
      if (recipient.address) {
        const plusMatch = recipient.address.match(/\+([^@\s>]+)@/);
        if (plusMatch && plusMatch[1]) {
          return decodeChatIdFromEmail(plusMatch[1]);
        }
      }
    }
  }

  // 2. Try raw headers: To, Delivered-To, X-Original-To, Envelope-To
  if (headers) {
    const candidateHeaders = [
      headers['to'],
      headers['delivered-to'],
      headers['x-original-to'],
      headers['envelope-to'],
    ];
    for (const candidate of candidateHeaders) {
      if (candidate) {
        const plusMatch = candidate.match(/\+([^@\s>]+)@/);
        if (plusMatch && plusMatch[1]) {
          return decodeChatIdFromEmail(plusMatch[1]);
        }
      }
    }

    if (headers['x-target-chat-id']) {
      return decodeChatIdFromEmail(headers['x-target-chat-id'].trim());
    }
    if (headers['x-chat-id']) {
      return decodeChatIdFromEmail(headers['x-chat-id'].trim());
    }

    if (headers['in-reply-to']) {
      const replyMatch = headers['in-reply-to'].match(/<chat-([^@>]+)@/);
      if (replyMatch && replyMatch[1]) {
        return decodeChatIdFromEmail(replyMatch[1].trim());
      }
    }

    if (headers['references']) {
      const refMatch = headers['references'].match(/<chat-([^@>]+)@/);
      if (refMatch && refMatch[1]) {
        return decodeChatIdFromEmail(refMatch[1].trim());
      }
    }
  }

  // 3. Try In-Reply-To in envelope
  if (envelope?.inReplyTo) {
    const replyMatch = envelope.inReplyTo.match(/<chat-([^@>]+)@/);
    if (replyMatch && replyMatch[1]) {
      return decodeChatIdFromEmail(replyMatch[1].trim());
    }
  }

  return '';
}

export function mapEmailError(
  err: unknown,
  context?: { phase?: 'send' | 'connect' | 'read' }
): BridgeError {
  if (err instanceof BridgeError) {
    return err;
  }

  const errorObj = err as Record<string, unknown> | null | undefined;
  const rawMessage =
    (errorObj?.message as string) ||
    (typeof err === 'string' ? err : 'Unknown email delivery error');
  const responseText = (errorObj?.responseText as string) || '';
  const message = responseText ? `${rawMessage}: ${responseText}` : rawMessage;
  const code =
    (errorObj?.code as string) ||
    (errorObj?.responseStatus as string) ||
    (errorObj?.name as string) ||
    '';
  const responseCode = Number(errorObj?.responseCode) || 0;

  // 1. Auth errors
  if (
    code === 'EAUTH' ||
    code === 'AUTHENTICATIONFAILED' ||
    code === 'AuthenticationFailure' ||
    responseCode === 535 ||
    /auth|login|credential|unauthorized|authenticate|app-specific password|password required/i.test(
      message
    )
  ) {
    return new AuthDeliveryError(message, code || 'EMAIL_AUTH_ERROR', {
      cause: err as Error,
    });
  }

  // 2. Recipient errors (Permanent)
  if (
    (responseCode >= 500 && responseCode < 600) ||
    code === 'EENVELOPE' ||
    /recipient|user unknown|mailbox unavailable|invalid address|address rejected|relay access denied|does not exist/i.test(
      message
    ) ||
    (Array.isArray(errorObj?.rejected) && (errorObj?.rejected as unknown[]).length > 0)
  ) {
    return new PermanentDeliveryError(
      message,
      code || (responseCode ? `SMTP_${responseCode}` : 'RECIPIENT_REJECTED'),
      { cause: err as Error }
    );
  }

  // 3. Network timeouts
  if (
    code === 'ETIMEDOUT' ||
    code === 'ESOCKETTIMEDOUT' ||
    code === 'ECONNRESET' ||
    /timed? ?out/i.test(message)
  ) {
    if (context?.phase === 'send') {
      return new AmbiguousDeliveryError(message, code || 'EMAIL_TIMEOUT', {
        cause: err as Error,
      });
    }
    return new TransientDeliveryError(message, code || 'EMAIL_TIMEOUT', {
      cause: err as Error,
    });
  }

  // 4. Other transient network errors (connection refused, host unreachable, 4xx responses)
  if (
    code === 'ECONNREFUSED' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENOTFOUND' ||
    code === 'ENETUNREACH' ||
    code === 'EAI_AGAIN' ||
    (responseCode >= 400 && responseCode < 500) ||
    /connection|network|temporary|busy|try again|rate limit|throttl/i.test(message)
  ) {
    return new TransientDeliveryError(
      message,
      code || (responseCode ? `SMTP_${responseCode}` : 'TRANSIENT_ERROR'),
      { cause: err as Error }
    );
  }

  // Default fallback
  return new TransientDeliveryError(message, code || 'EMAIL_ERROR', {
    cause: err as Error,
  });
}

function isAsyncIterable(obj: unknown): obj is AsyncIterable<ImapFetchMessage> {
  return obj != null && typeof (obj as any)[Symbol.asyncIterator] === 'function';
}

export class NodemailerEmailAdapter implements EmailAdapter {
  private readonly options: EmailAdapterOptions;
  private readonly logger?: Logger;
  private readonly transporter: TransporterLike;
  private imapClient: ImapClientLike | null = null;
  private readonly inboundHandlers: InboundEmailHandler[] = [];
  private started = false;
  private stopping = false;
  private isImapConnected = false;
  private mailboxLock: ImapMailboxLock | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(options: EmailAdapterOptions) {
    this.options = options;
    this.logger = options.logger;

    if (options.transporter) {
      this.transporter = options.transporter;
    } else {
      this.transporter = nodemailer.createTransport({
        host: options.smtp.host,
        port: options.smtp.port,
        secure: options.smtp.secure ?? options.smtp.port === 465,
        auth: options.smtp.auth,
      });
    }

    if (options.imapClient) {
      this.imapClient = options.imapClient;
    }
  }

  public onInboundEmail(handler: InboundEmailHandler): void {
    this.inboundHandlers.push(handler);
  }

  public isHealthy(): boolean {
    if (!this.started || this.stopping) {
      return false;
    }
    if (this.options.imap?.enabled) {
      if (!this.isImapConnected) {
        return false;
      }
      if (this.imapClient?.usable === false) {
        return false;
      }
    }
    return true;
  }

  public async start(): Promise<void> {
    this.stopping = false;

    if (this.options.imap?.enabled) {
      try {
        await this.initAndConnectImap();
      } catch (err) {
        this.logger?.warn(
          { err: (err as Error).message },
          'Initial IMAP connection failed; scheduling retry in background'
        );
        this.scheduleReconnect();
      }
    }

    this.started = true;
    this.logger?.info('Email adapter started');
  }

  public async stop(): Promise<void> {
    this.stopping = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.mailboxLock) {
      try {
        await this.mailboxLock.release();
      } catch {
        // Ignore lock release error on shutdown
      }
      this.mailboxLock = null;
    }

    if (this.imapClient) {
      try {
        await this.imapClient.logout();
      } catch {
        try {
          this.imapClient.close();
        } catch {
          // Ignore close error on shutdown
        }
      }
    }

    if (this.transporter.close) {
      try {
        this.transporter.close();
      } catch {
        // Ignore close error on shutdown
      }
    }

    this.isImapConnected = false;
    this.started = false;
    this.logger?.info('Email adapter stopped');
  }

  public async sendEmail(params: SendEmailParams): Promise<SendMessageResult> {
    const domain = this.options.smtp.domain || extractDomain(this.options.smtp.fromAddress);
    const emailUser = extractEmailUser(this.options.smtp.fromAddress);
    const senderDisplay = params.senderName?.trim() || 'WhatsApp';
    const from = `"${senderDisplay}" <${this.options.smtp.fromAddress}>`;

    const encodedChatId = encodeChatIdForEmail(params.chatId);
    const encodedConvId = encodeChatIdForEmail(params.conversationId);

    const random = crypto.randomBytes(4).toString('hex');
    const messageId = `<wa-${Date.now()}-${random}@${domain}>`;
    const inReplyTo = `<chat-${encodedConvId}@${domain}>`;
    const references = `<chat-${encodedConvId}@${domain}>`;

    const replyTo = this.options.smtp.replyToPattern
      ? this.options.smtp.replyToPattern
          .replace('{chatId}', encodedChatId)
          .replace('{domain}', domain)
          .replace('{user}', emailUser)
      : `<${emailUser}+${encodedChatId}@${domain}>`;

    const mailOptions: SendMailOptions = {
      from,
      to: params.to,
      subject: params.subject,
      text: params.text,
      messageId,
      inReplyTo,
      references,
      replyTo,
      headers: {
        'Message-ID': messageId,
        'In-Reply-To': inReplyTo,
        'References': references,
      },
    };

    try {
      const info = await this.transporter.sendMail(mailOptions);
      return {
        providerMessageId: (info as any)?.messageId || messageId,
        status: 'submitted',
      };
    } catch (err) {
      throw mapEmailError(err, { phase: 'send' });
    }
  }

  private async initAndConnectImap(): Promise<void> {
    if (!this.options.imapClient) {
      if (this.imapClient) {
        try {
          this.imapClient.close();
        } catch {
          // Ignore close error on stale client
        }
      }
      this.imapClient = new ImapFlow({
        host: this.options.imap!.host,
        port: this.options.imap!.port,
        secure: this.options.imap!.secure ?? this.options.imap!.port === 993,
        auth: this.options.imap!.auth,
        logger: false,
      });
    } else {
      this.imapClient = this.options.imapClient;
    }

    if (!this.imapClient) {
      return;
    }

    this.bindImapEvents();

    try {
      await this.imapClient.connect();
      this.isImapConnected = true;

      const mailbox = this.options.imap?.mailbox ?? 'INBOX';
      this.mailboxLock = await this.imapClient.getMailboxLock(mailbox);

      // Fetch any existing unseen messages upon connecting
      await this.fetchAndProcessUnseenMessages();

      // Enter IDLE loop in background
      this.startIdleLoop();
    } catch (err) {
      this.isImapConnected = false;
      throw mapEmailError(err, { phase: 'connect' });
    }
  }

  private bindImapEvents(): void {
    if (!this.imapClient) return;

    this.imapClient.on('error', (err: unknown) => {
      this.logger?.error({ err }, 'IMAP client error event');
      this.handleImapDisconnect();
    });

    this.imapClient.on('close', () => {
      this.logger?.info('IMAP connection closed');
      this.handleImapDisconnect();
    });

    this.imapClient.on('exists', () => {
      this.fetchAndProcessUnseenMessages().catch((err) => {
        this.logger?.error({ err }, 'Error processing unseen messages on exists event');
      });
    });
  }

  private handleImapDisconnect(): void {
    this.isImapConnected = false;
    if (this.mailboxLock) {
      try {
        this.mailboxLock.release();
      } catch {
        // Ignore lock release error
      }
      this.mailboxLock = null;
    }

    if (this.stopping) {
      return;
    }

    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopping) {
      return;
    }
    const delay = this.options.imap?.reconnectDelayMs ?? 5000;
    this.logger?.info({ delay }, 'Scheduling IMAP reconnect');

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.stopping) return;
      try {
        await this.initAndConnectImap();
      } catch (err) {
        this.logger?.error({ err }, 'IMAP reconnect attempt failed');
        this.scheduleReconnect();
      }
    }, delay);
  }

  private async startIdleLoop(): Promise<void> {
    while (!this.stopping && this.isImapConnected && this.imapClient) {
      try {
        await this.imapClient.idle();
        if (this.stopping) break;
        // Pause briefly before re-entering idle if idle returned immediately
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch (err) {
        if (this.stopping) break;
        this.logger?.debug({ err }, 'IMAP idle interrupted or failed');
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }

  private async fetchAndProcessUnseenMessages(): Promise<void> {
    if (!this.imapClient || !this.isImapConnected) {
      return;
    }

    try {
      const fetchResult = this.imapClient.fetch(
        { seen: false },
        {
          envelope: true,
          bodyStructure: true,
          source: true,
          uid: true,
        }
      );

      const messages = isAsyncIterable(fetchResult)
        ? fetchResult
        : Array.isArray(fetchResult)
          ? fetchResult
          : await fetchResult;

      for await (const msg of messages) {
        if (this.stopping) break;
        try {
          await this.processMessage(msg);
          if (msg.uid && this.imapClient.messageFlagsAdd) {
            await this.imapClient.messageFlagsAdd({ uid: msg.uid }, ['\\Seen'], {
              uid: true,
            });
          }
        } catch (msgErr) {
          this.logger?.error(
            { err: msgErr, uid: msg.uid },
            'Failed to process individual incoming email'
          );
        }
      }
    } catch (err) {
      this.logger?.error({ err }, 'Failed to fetch unseen messages from IMAP');
    }
  }

  private async processMessage(msg: ImapFetchMessage): Promise<void> {
    let rawHeaders: Record<string, string> = {};
    let parsedBodyText = '';

    if (msg.source) {
      const parsed = parseEmailSource(msg.source);
      rawHeaders = parsed.headers;
      parsedBodyText = parsed.text;
    }

    // Direct body or text properties on msg take precedence if provided (e.g. test doubles)
    if (msg.text) {
      parsedBodyText = msg.text;
    } else if (msg.body) {
      parsedBodyText = msg.body;
    }

    // Try downloading text/plain part if imapClient supports download and no body parsed yet
    if (!parsedBodyText && msg.bodyStructure && this.imapClient?.download) {
      const textPart = this.findTextPlainPart(msg.bodyStructure);
      if (textPart) {
        try {
          const download = await this.imapClient.download(msg.uid, textPart, {
            uid: true,
          });
          if (download.content) {
            parsedBodyText = await this.streamToString(download.content);
          }
        } catch (dlErr) {
          this.logger?.debug({ err: dlErr }, 'Could not download text/plain part');
        }
      }
    }

    const messageId =
      msg.envelope?.messageId ||
      rawHeaders['message-id'] ||
      `<email-${msg.uid ?? Date.now()}@veronica.bridge>`;

    const fromAddress =
      msg.envelope?.from?.[0]?.address ||
      (msg.envelope?.from?.[0]
        ? `${msg.envelope.from[0].name || ''} <${msg.envelope.from[0].address || ''}>`.trim()
        : rawHeaders['from'] || '');

    const toAddress =
      msg.envelope?.to?.[0]?.address ||
      (msg.envelope?.to?.[0]
        ? `${msg.envelope.to[0].name || ''} <${msg.envelope.to[0].address || ''}>`.trim()
        : rawHeaders['to'] || '');

    const subject = msg.envelope?.subject || rawHeaders['subject'] || '';

    const targetChatId = extractTargetChatId(msg.envelope, rawHeaders);

    const receivedAt = msg.envelope?.date
      ? new Date(msg.envelope.date).toISOString()
      : msg.internalDate
        ? new Date(msg.internalDate).toISOString()
        : new Date().toISOString();

    const inReplyTo = msg.envelope?.inReplyTo || rawHeaders['in-reply-to'] || undefined;
    const references = rawHeaders['references'] || undefined;

    const event: RawEmailInboundEvent = {
      messageId,
      from: fromAddress,
      to: toAddress,
      subject,
      body: parsedBodyText,
      targetChatId,
      receivedAt,
      inReplyTo,
      references,
    };

    for (const handler of this.inboundHandlers) {
      try {
        await handler(event);
      } catch (handlerErr) {
        this.logger?.error({ err: handlerErr, messageId }, 'Inbound email handler threw');
      }
    }
  }

  private findTextPlainPart(structure: any): string | null {
    if (!structure) return null;
    if (structure.type === 'text/plain' && structure.part) {
      return structure.part;
    }
    if (Array.isArray(structure.childNodes)) {
      for (const child of structure.childNodes) {
        const found = this.findTextPlainPart(child);
        if (found) return found;
      }
    }
    return null;
  }

  private async streamToString(stream: NodeJS.ReadableStream): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf-8');
  }
}

export { NodemailerEmailAdapter as EmailAdapterImpl };
