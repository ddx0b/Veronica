import type { ConnectionState, SendMessageResult } from '../../domain/types.js';
import type { RawWhatsAppInboundEvent } from '../../domain/normalizer.js';

export type InboundWhatsAppHandler = (event: RawWhatsAppInboundEvent) => Promise<void> | void;

export type WhatsAppReceiptUpdateHandler = (update: {
  providerMessageId: string;
  status: 'delivered';
}) => Promise<void> | void;

export interface WhatsAppAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  getConnectionState(): ConnectionState;
  isReadyForSend(): boolean;
  onInboundMessage(handler: InboundWhatsAppHandler): void;
  onReceiptUpdate?(handler: WhatsAppReceiptUpdateHandler): void;
  sendTextMessage(chatId: string, text: string): Promise<SendMessageResult>;
}
