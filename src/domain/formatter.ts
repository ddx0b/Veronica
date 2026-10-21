import { PermanentDeliveryError } from './errors.js';
import type { Channel, NormalizedMessage } from './types.js';

export interface FormatOutboundOptions {
  maxEmailLength?: number;
  maxWhatsAppLength?: number;
}

const DEFAULT_MAX_WHATSAPP_LENGTH = 4096;

export function formatOutboundMessage(
  message: NormalizedMessage,
  destinationChannel: Channel,
  options: FormatOutboundOptions = {}
): string {
  const senderDisplay =
    message.senderName && message.senderName.trim().length > 0
      ? message.senderName.trim()
      : message.senderId;

  let formatted: string;
  if (destinationChannel === 'whatsapp') {
    formatted = `[Email] ${senderDisplay}: ${message.text}`;
  } else {
    formatted = message.text;
  }

  const maxLength =
    destinationChannel === 'whatsapp'
      ? (options.maxWhatsAppLength ?? DEFAULT_MAX_WHATSAPP_LENGTH)
      : options.maxEmailLength;

  if (maxLength !== undefined && formatted.length > maxLength) {
    throw new PermanentDeliveryError(
      `Formatted outbound message length (${formatted.length}) exceeds maximum allowed (${maxLength}) for ${destinationChannel}`,
      'MESSAGE_TOO_LONG'
    );
  }

  return formatted;
}
