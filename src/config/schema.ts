import { z } from 'zod';
import { isGroupWhatsAppChat } from '../domain/router.js';

const e164PhoneSchema = z
  .string()
  .regex(/^\+[1-9]\d{6,14}$/, 'Must be a valid E.164 phone number (e.g. +15551234567)');

const whatsappChatIdSchema = z
  .string()
  .min(1, 'targetChatId must not be empty')
  .refine(
    (val) => val === '*' || !isGroupWhatsAppChat(val),
    'Group or broadcast WhatsApp chats (@g.us / @broadcast) are not supported'
  );

export const ConfigFileSchema = z.object({
  whatsapp: z.object({
    enabled: z.boolean(),
    targetChatId: whatsappChatIdSchema,
    authDirectory: z.string().min(1, 'authDirectory is required'),
  }),
  email: z.object({
    smtp: z.object({
      host: z.string().min(1, 'smtp.host is required'),
      port: z.number().int(),
      secure: z.boolean(),
      user: z.string().min(1, 'smtp.user is required'),
      fromAddress: z.string().email('smtp.fromAddress must be a valid email address'),
    }),
    imap: z.object({
      host: z.string().min(1, 'imap.host is required'),
      port: z.number().int(),
      secure: z.boolean(),
      user: z.string().min(1, 'imap.user is required'),
      enabled: z.boolean(),
    }),
    userEmail: z.string().email('userEmail must be a valid email address'),
    replyDomain: z.string().default('bridge.local'),
  }),
  routing: z.object({
    whatsappToEmail: z.boolean(),
    emailToWhatsapp: z.boolean(),
    allowedEmailSenders: z
      .array(z.string().email())
      .min(1, 'allowedEmailSenders must contain at least one email address'),
  }),
  database: z.object({
    path: z.string().min(1, 'database.path is required'),
    retentionDays: z.number().int().min(1).max(365).default(7),
  }),
  worker: z.object({
    pollIntervalMs: z.number().int().min(50).max(60000),
    maxAttempts: z.number().int().min(1).max(20),
    baseBackoffMs: z.number().int().min(50).max(60000),
    maxBackoffMs: z.number().int().min(100).max(3600000),
    processingTimeoutMs: z.number().int().min(1000).max(600000).default(30000),
  }).refine(
    (w) => w.maxBackoffMs >= w.baseBackoffMs,
    {
      message: 'worker.maxBackoffMs must be greater than or equal to worker.baseBackoffMs',
      path: ['maxBackoffMs'],
    }
  ),
  http: z.object({
    host: z.string().min(1, 'http.host is required'),
    port: z.number().int().min(0).max(65535),
  }),
});

export const SecretsSchema = z.object({
  emailPassword: z.string().min(1, 'EMAIL_PASSWORD is required'),
});

export type AppConfigFile = z.infer<typeof ConfigFileSchema>;
export type AppSecrets = z.infer<typeof SecretsSchema>;

export interface AppConfig extends AppConfigFile {
  secrets: AppSecrets;
  logLevel: string;
  whatsappPairingMode: boolean;
}
