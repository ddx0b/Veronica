import { pino, stdTimeFunctions, type Logger, type DestinationStream } from 'pino';

export const REDACTED_PATHS = [
  'req.headers.authorization',
  'secrets',
  'secrets.emailPassword',
  'emailPassword',
  'pass',
  'auth.pass',
  'qr',
  'qrCode',
  'creds',
  'keys',
  'body',
  'Body',
  'text',
  'message.text',
  'senderId',
  'destinationId',
  'targetChatId',
];

export interface CreateLoggerOptions {
  level?: string;
  destination?: DestinationStream;
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  return pino(
    {
      level: options.level ?? 'info',
      redact: {
        paths: REDACTED_PATHS,
        censor: '[REDACTED]',
      },
      timestamp: stdTimeFunctions.isoTime,
      formatters: {
        level(label: string) {
          return { level: label };
        },
      },
    },
    options.destination
  );
}
