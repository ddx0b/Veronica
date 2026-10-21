import crypto from 'node:crypto';
import type { MessageType, NormalizedMessage, RawEmailInboundEvent } from './types.js';

export type { RawEmailInboundEvent };

export interface RawWhatsAppInboundEvent {
  eventId: string;
  messageId: string;
  chatId: string;
  senderId: string;
  senderName?: string | null;
  fromMe: boolean;
  timestampMs: number;
  messageContent?: {
    conversation?: string | null;
    extendedTextMessage?: { text?: string | null } | null;
    imageMessage?: { caption?: string | null } | null;
    videoMessage?: { caption?: string | null } | null;
    audioMessage?: Record<string, unknown> | null;
    documentMessage?: { caption?: string | null; fileName?: string | null } | null;
    stickerMessage?: Record<string, unknown> | null;
    [key: string]: unknown;
  } | null;
  mediaPath?: string | null;
}


export type NormalizationOutcome =
  | { kind: 'normalized'; message: NormalizedMessage }
  | { kind: 'ignored'; reason: string };

const MEDIA_PLACEHOLDERS: Readonly<Record<Exclude<MessageType, 'text'>, string>> = {
  image: '[Image attached]',
  video: '[Video attached]',
  audio: '[Audio attached]',
  document: '[Document attached]',
  sticker: '[Sticker attached]',
  other_media: '[Media attached]',
};

const IGNORED_PROTOCOL_KEYS = new Set([
  'protocolMessage',
  'reactionMessage',
  'senderKeyDistributionMessage',
  'messageContextInfo',
  'keepInChatMessage',
  'pollUpdateMessage',
  'ephemeralMessage',
]);

function combineCaptionAndPlaceholder(
  caption: string | null | undefined,
  placeholder: string
): string {
  const trimmed = caption?.trim() ?? '';
  if (trimmed.length === 0) {
    return placeholder;
  }
  return `${trimmed} ${placeholder}`;
}

export function normalizeWhatsAppEvent(
  event: RawWhatsAppInboundEvent,
  idGenerator: () => string = () => crypto.randomUUID()
): NormalizationOutcome {
  if (event.fromMe) {
    return { kind: 'ignored', reason: 'self_originated' };
  }

  const content = event.messageContent;
  if (!content || typeof content !== 'object') {
    return { kind: 'ignored', reason: 'empty_message_content' };
  }

  const createdAt = new Date(event.timestampMs).toISOString();
  const baseFields = {
    sourceChannel: 'whatsapp' as const,
    sourceMessageId: event.messageId,
    senderId: event.senderId,
    senderName: event.senderName ?? null,
    conversationId: event.chatId,
    createdAt,
    ...(event.mediaPath ? { mediaPath: event.mediaPath } : {}),
  };

  if (typeof content.conversation === 'string' && content.conversation.trim().length > 0) {
    return {
      kind: 'normalized',
      message: {
        id: idGenerator(),
        ...baseFields,
        text: content.conversation,
        messageType: 'text',
      },
    };
  }

  if (
    content.extendedTextMessage &&
    typeof content.extendedTextMessage.text === 'string' &&
    content.extendedTextMessage.text.trim().length > 0
  ) {
    return {
      kind: 'normalized',
      message: {
        id: idGenerator(),
        ...baseFields,
        text: content.extendedTextMessage.text,
        messageType: 'text',
      },
    };
  }

  if (content.imageMessage) {
    return {
      kind: 'normalized',
      message: {
        id: idGenerator(),
        ...baseFields,
        text: combineCaptionAndPlaceholder(
          content.imageMessage.caption,
          MEDIA_PLACEHOLDERS.image
        ),
        messageType: 'image',
      },
    };
  }

  if (content.videoMessage) {
    return {
      kind: 'normalized',
      message: {
        id: idGenerator(),
        ...baseFields,
        text: combineCaptionAndPlaceholder(
          content.videoMessage.caption,
          MEDIA_PLACEHOLDERS.video
        ),
        messageType: 'video',
      },
    };
  }

  if (content.audioMessage) {
    return {
      kind: 'normalized',
      message: {
        id: idGenerator(),
        ...baseFields,
        text: MEDIA_PLACEHOLDERS.audio,
        messageType: 'audio',
      },
    };
  }

  if (content.documentMessage) {
    return {
      kind: 'normalized',
      message: {
        id: idGenerator(),
        ...baseFields,
        text: combineCaptionAndPlaceholder(
          content.documentMessage.caption,
          MEDIA_PLACEHOLDERS.document
        ),
        messageType: 'document',
      },
    };
  }

  if (content.stickerMessage) {
    return {
      kind: 'normalized',
      message: {
        id: idGenerator(),
        ...baseFields,
        text: MEDIA_PLACEHOLDERS.sticker,
        messageType: 'sticker',
      },
    };
  }

  // Check if all keys are protocol/context metadata or unsupported media
  const contentKeys = Object.keys(content).filter((k) => content[k] != null);
  const nonProtocolKeys = contentKeys.filter((k) => !IGNORED_PROTOCOL_KEYS.has(k));

  if (nonProtocolKeys.length === 0) {
    return { kind: 'ignored', reason: 'protocol_or_metadata_event' };
  }

  return { kind: 'ignored', reason: `unsupported_message_type:${nonProtocolKeys.join(',')}` };
}

export function stripEmailQuotes(text: string): string {
  if (!text || typeof text !== 'string') {
    return '';
  }

  let cleaned = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // 1. Divider lines like --- Original Message ---, -----Original Message-----, --- Mensagem Original ---
  const dividerRegex = /(?:^|\n)\s*(?:[-=_]{2,}\s*(?:Original Message|Mensagem Original|Forwarded Message|Mensagem Encaminhada)[^\n]*|[-=_]{5,}|_{10,})\s*(?:\n|$)/i;
  const dividerMatch = dividerRegex.exec(cleaned);
  if (dividerMatch) {
    cleaned = cleaned.slice(0, dividerMatch.index);
  }

  // 2. Outlook / email header blocks starting with "From: ..." or "De: ..."
  const headerBlockRegex = /(?:^|\n)\s*(?:From|De):\s+[^\n]+(?:\n\s*(?:Sent|To|Subject|Date|Para|Assunto|Enviad[ao](?: em)?|Cc):\s+[^\n]+|\n(?=\s*(?:[-=_>]|$)))/i;
  const headerMatch = headerBlockRegex.exec(cleaned);
  if (headerMatch) {
    cleaned = cleaned.slice(0, headerMatch.index);
  } else {
    // If not matching multiple headers, check standalone "From: ..." or "De: ..." if preceded by newline
    const singleHeaderRegex = /\n\s*(?:From|De):\s+[^\n]+(?:\n|$)/i;
    const singleHeaderMatch = singleHeaderRegex.exec(cleaned);
    if (singleHeaderMatch) {
      cleaned = cleaned.slice(0, singleHeaderMatch.index);
    }
  }

  // 3. Signatures:
  // Standard RFC 3676 signature delimiter: "-- \n" or "--\n"
  const sigDashRegex = /(?:^|\n)--\s*(?:\n|$)/;
  const sigDashMatch = sigDashRegex.exec(cleaned);
  if (sigDashMatch) {
    cleaned = cleaned.slice(0, sigDashMatch.index);
  }

  // Mobile signatures
  const mobileSigRegex = /(?:^|\n)\s*(?:Sent from my|Get Outlook for|Obtener Outlook para|Enviado desde mi|Enviado do meu|Enviado pelo meu|Enviado de meu|Enviado via|Este mensaje (?:ha sido|se ha|fue|se)?\s*enviado desde|This message (?:was|has been)?\s*sent from)\s+[^\n]+/i;
  const mobileSigMatch = mobileSigRegex.exec(cleaned);
  if (mobileSigMatch) {
    cleaned = cleaned.slice(0, mobileSigMatch.index);
  }

  // 4. "On <date>, <sender> wrote:" / "El <fecha>, <remitente> escribió:" / "Em <data>, <remetente> escreveu:"
  const onWroteRegex = /(?:^|\n)\s*(?:On|El|Em|No dia|Le|Am|Il)\s+[^\n]*(?:\d{1,4}[^\n]*(?:\n[^\n]*){0,3}?|[^\n]*?)(?:wrote|escribi[oó]|ha escrito|escreveu|a écrit|ha scritto|schrieb)[^:\n]*:[^\n]*(?:\n|$)/i;
  const onWroteMatch = onWroteRegex.exec(cleaned);
  if (onWroteMatch) {
    const beforeOnWrote = cleaned.slice(0, onWroteMatch.index).trim();
    if (beforeOnWrote.length > 0) {
      // Top-posted reply: everything after On ... wrote: is quoted history
      cleaned = beforeOnWrote;
    } else {
      // Inline or bottom reply: remove the On ... wrote: line
      cleaned = cleaned.replace(onWroteRegex, '\n');
    }
  }

  // 5. Remove any lines starting with '>'
  const lines = cleaned.split('\n').filter((line) => !line.trimStart().startsWith('>'));
  cleaned = lines.join('\n').trim();

  return cleaned;
}

export function normalizeEmailEvent(
  event: RawEmailInboundEvent,
  idGenerator: () => string = () => crypto.randomUUID()
): NormalizationOutcome {
  const rawBody = event.body ?? event.text ?? '';
  const cleanedText = stripEmailQuotes(rawBody);

  if (cleanedText.trim().length === 0) {
    return { kind: 'ignored', reason: 'empty_email_body' };
  }

  const rawSender = (event.sender ?? event.from ?? '').trim();
  const senderMatch = rawSender.match(/<([^>]+)>/);
  const sender = senderMatch && senderMatch[1] ? senderMatch[1].trim() : rawSender;
  const targetChatId = event.targetChatId?.trim() ?? '';

  if (sender.length === 0) {
    return { kind: 'ignored', reason: 'missing_email_sender' };
  }

  return {
    kind: 'normalized',
    message: {
      id: idGenerator(),
      sourceChannel: 'email',
      sourceMessageId: event.messageId,
      senderId: sender,
      senderName: event.senderName ?? null,
      conversationId: targetChatId,
      targetChatId: targetChatId,
      text: cleanedText,
      messageType: 'text',
      createdAt: event.receivedAt ?? new Date().toISOString(),
    },
  };
}
