import type { SendMessageResult } from '../../domain/types.js';

export interface SendEmailParams {
  to: string;
  chatId: string;
  senderName?: string | null;
  subject: string;
  text: string;
  conversationId: string;
}

export interface RawEmailInboundEvent {
  messageId: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  targetChatId: string;
  receivedAt: string;
  inReplyTo?: string;
  references?: string;
}

export type InboundEmailHandler = (event: RawEmailInboundEvent) => Promise<void> | void;

export interface EmailAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendEmail(params: SendEmailParams): Promise<SendMessageResult>;
  onInboundEmail(handler: InboundEmailHandler): void;
  isHealthy(): boolean;
}
