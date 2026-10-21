export type Channel = 'whatsapp' | 'email';

export type MessageType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'document'
  | 'sticker'
  | 'other_media';

export type DeliveryJobStatus =
  | 'pending'
  | 'processing'
  | 'submitted'
  | 'delivered'
  | 'failed'
  | 'dead_letter'
  | 'unknown';

export type DeliveryAttemptOutcome =
  | 'in_progress'
  | 'submitted'
  | 'delivered'
  | 'transient_error'
  | 'permanent_error'
  | 'auth_error'
  | 'ambiguous_error';

export type InboundEventProcessingStatus =
  | 'accepted'
  | 'ignored'
  | 'rejected'
  | 'failed';

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'auth_failed';

export interface InboundEvent {
  id: string;
  sourceChannel: Channel;
  sourceEventId: string;
  receivedAt: string;
  payloadMetadata: Record<string, unknown>;
  processingStatus: InboundEventProcessingStatus;
}

export interface NormalizedMessage {
  id: string;
  sourceChannel: Channel;
  sourceMessageId: string;
  senderId: string;
  senderName?: string | null;
  conversationId: string;
  text: string;
  messageType: MessageType;
  createdAt: string;
  targetChatId?: string;
}

export interface RawEmailInboundEvent {
  messageId: string;
  sender?: string;
  from?: string;
  targetChatId: string;
  text?: string;
  body?: string;
  subject?: string;
  senderName?: string | null;
  receivedAt?: string;
  inReplyTo?: string;
  references?: string;
}

export interface DeliveryJob {
  id: string;
  messageId: string;
  destinationChannel: Channel;
  destinationId: string;
  status: DeliveryJobStatus;
  attemptCount: number;
  nextAttemptAt: string;
  providerMessageId: string | null;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryJobWithMessage extends DeliveryJob {
  message: NormalizedMessage;
}

export interface DeliveryAttempt {
  id: string;
  deliveryJobId: string;
  attemptNumber: number;
  startedAt: string;
  finishedAt: string | null;
  outcome: DeliveryAttemptOutcome;
  errorCode: string | null;
  providerMessageId: string | null;
}

export interface RouteRecord {
  id: string;
  sourceChannel: Channel;
  sourceIdentity: string;
  destinationChannel: Channel;
  destinationIdentity: string;
  enabled: boolean;
}

export interface SendMessageResult {
  providerMessageId: string;
  status: 'submitted' | 'delivered';
}
