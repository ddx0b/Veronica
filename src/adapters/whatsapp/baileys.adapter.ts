import fs from 'node:fs';
import path from 'node:path';
import {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestWaWebVersion,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  Browsers,
  downloadMediaMessage,
  type WASocket,
  type BaileysEventMap,
  type WAVersion,
  type WACallEvent,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import { pino, type Logger } from 'pino';
import {
  AmbiguousDeliveryError,
  AuthDeliveryError,
  PermanentDeliveryError,
  TransientDeliveryError,
} from '../../domain/errors.js';
import { isGroupWhatsAppChat } from '../../domain/router.js';
import type { ConnectionState, SendMessageResult } from '../../domain/types.js';
import type { RawWhatsAppInboundEvent } from '../../domain/normalizer.js';
import type {
  InboundWhatsAppHandler,
  WhatsAppAdapter,
  WhatsAppReceiptUpdateHandler,
} from './interface.js';

export interface BaileysSocketLike {
  ev: {
    on<K extends keyof BaileysEventMap>(
      event: K,
      listener: (arg: BaileysEventMap[K]) => void
    ): void;
  };
  sendMessage: WASocket['sendMessage'];
  end: (error?: Error) => void;
}

export type BaileysSocketFactory = (params: {
  authDirectory: string;
  silentLogger: Logger;
  saveCredsCallback: (cb: () => Promise<void>) => void;
}) => Promise<BaileysSocketLike>;

export interface BaileysAdapterOptions {
  authDirectory: string;
  targetChatId: string;
  pairingMode?: boolean;
  logger: Logger;
  reconnectDelayMs?: number;
  socketFactory?: BaileysSocketFactory;
}

async function resolveWaWebVersion(): Promise<WAVersion | undefined> {
  try {
    const waWeb = await fetchLatestWaWebVersion({ timeout: 5000 });
    if (waWeb.isLatest && Array.isArray(waWeb.version)) {
      return waWeb.version;
    }
  } catch {
    // Fall back to Baileys GitHub version check or bundled default
  }

  try {
    const latestBaileys = await fetchLatestBaileysVersion({ timeout: 5000 });
    if (Array.isArray(latestBaileys.version)) {
      return latestBaileys.version;
    }
  } catch {
    // Use bundled version in @whiskeysockets/baileys
  }

  return undefined;
}

export class BaileysWhatsAppAdapter implements WhatsAppAdapter {
  private readonly options: BaileysAdapterOptions;
  private readonly logger: Logger;
  private connectionState: ConnectionState = 'disconnected';
  private socket: BaileysSocketLike | null = null;
  private inboundHandlers: InboundWhatsAppHandler[] = [];
  private receiptHandlers: WhatsAppReceiptUpdateHandler[] = [];
  private sentMessageIds = new Set<string>();
  private readonly callState = new Map<
    string,
    { from: string; isVideo: boolean; timestamp: number; accepted: boolean }
  >();
  private readonly processedCallIds = new Set<string>();
  private stopping = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(options: BaileysAdapterOptions) {
    this.options = options;
    this.logger = options.logger.child({ component: 'whatsapp-adapter' });
  }

  public getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  public isReadyForSend(): boolean {
    return this.connectionState === 'connected' && this.socket !== null;
  }

  public onInboundMessage(handler: InboundWhatsAppHandler): void {
    this.inboundHandlers.push(handler);
  }

  public onReceiptUpdate(handler: WhatsAppReceiptUpdateHandler): void {
    this.receiptHandlers.push(handler);
  }

  public async start(): Promise<void> {
    this.stopping = false;
    fs.mkdirSync(this.options.authDirectory, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(this.options.authDirectory, 0o700);
    } catch {
      // Ignore chmod error on platforms that do not support POSIX permissions
    }

    if (this.options.pairingMode) {
      process.stderr.write(
        '\n================================================================\n' +
          '[WHATSAPP PAIRING MODE ENABLED]\n' +
          'Connecting to WhatsApp Web and waiting for QR code...\n' +
          '================================================================\n\n'
      );
    }

    await this.connectSocket();
  }

  private async connectSocket(): Promise<void> {
    if (this.stopping) {
      return;
    }

    this.connectionState = 'connecting';
    const silentLogger = pino({ level: 'silent' });
    let saveCredsFn: () => Promise<void> = async () => {};

    const factory: BaileysSocketFactory =
      this.options.socketFactory ??
      (async ({ authDirectory, silentLogger: sockLogger, saveCredsCallback }) => {
        const [{ state, saveCreds }, version] = await Promise.all([
          useMultiFileAuthState(authDirectory),
          resolveWaWebVersion(),
        ]);
        saveCredsCallback(saveCreds);
        const sock = makeWASocket({
          ...(version ? { version } : {}),
          browser: Browsers.ubuntu('Chrome'),
          auth: state,
          logger: sockLogger,
          printQRInTerminal: false,
          markOnlineOnConnect: false,
          syncFullHistory: false,
        });
        return sock;
      });

    const sock = await factory({
      authDirectory: this.options.authDirectory,
      silentLogger,
      saveCredsCallback: (cb) => {
        saveCredsFn = cb;
      },
    });

    this.socket = sock;

    sock.ev.on('creds.update', () => {
      void saveCredsFn().catch((err: unknown) => {
        this.logger.error(
          { err: (err as Error).message },
          'Failed to persist WhatsApp auth credentials'
        );
      });
    });

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        // FR-01 & Sec 8.7: Never write QR codes or auth material to application logs.
        this.logger.info(
          'WhatsApp authentication QR challenge received (enable WHATSAPP_PAIRING_MODE=true to scan)'
        );
        if (this.options.pairingMode) {
          qrcode.generate(qr, { small: true }, (asciiQr: string) => {
            process.stderr.write(
              '\n================================================================\n' +
                '[WHATSAPP PAIRING MODE — SCAN QR CODE]\n' +
                '1. Open WhatsApp on your phone\n' +
                '2. Tap Menu / Settings -> Linked Devices -> Link a Device\n' +
                '3. Point your phone camera at this QR code:\n' +
                '================================================================\n\n' +
                `${asciiQr}\n` +
                '================================================================\n\n'
            );
          });
        }
      }

      if (connection === 'open') {
        this.connectionState = 'connected';
        this.logger.info('WhatsApp Web connection established');
        if (this.options.pairingMode) {
          process.stderr.write(
            '\n================================================================\n' +
              '[WHATSAPP CONNECTED SUCCESSFULLY!]\n' +
              `Session saved to: ${this.options.authDirectory}\n` +
              'Tip: Send a test message in the WhatsApp conversation you want\n' +
              'to bridge — its Chat ID (JID) will be printed here so you can\n' +
              'copy it into "whatsapp.targetChatId" in config.json.\n' +
              'When done, press Ctrl+C, set WHATSAPP_PAIRING_MODE=false in .env,\n' +
              'and start normally with: docker compose up -d\n' +
              '================================================================\n\n'
          );
        }
      } else if (connection === 'close') {
        const statusCode = (
          lastDisconnect?.error as { output?: { statusCode?: number } } | undefined
        )?.output?.statusCode;

        const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;

        if (isLoggedOut) {
          this.connectionState = 'auth_failed';
          this.logger.error(
            { statusCode },
            'WhatsApp authentication invalidated or logged out; clearing stale credentials'
          );

          // Purge stale credentials so a fresh session can be initiated
          try {
            if (fs.existsSync(this.options.authDirectory)) {
              const entries = fs.readdirSync(this.options.authDirectory);
              for (const entry of entries) {
                fs.rmSync(path.join(this.options.authDirectory, entry), {
                  recursive: true,
                  force: true,
                });
              }
            }
          } catch (err) {
            this.logger.error({ err }, 'Failed to clear stale auth credentials directory');
          }

          if (this.options.pairingMode && !this.stopping) {
            process.stderr.write(
              '\n[WHATSAPP] Session expired or logged out. Stale session cleared. Requesting new QR code...\n\n'
            );
            const delay = this.options.reconnectDelayMs ?? 1000;
            this.reconnectTimer = setTimeout(() => {
              void this.connectSocket().catch((err: unknown) => {
                this.logger.error(
                  { err: (err as Error).message },
                  'Failed to re-initialize pairing session'
                );
              });
            }, delay);
            return;
          }

          return;
        }

        this.connectionState = 'disconnected';
        this.logger.warn({ statusCode }, 'WhatsApp connection closed; scheduling reconnect');

        if (!this.stopping) {
          const delay = this.options.reconnectDelayMs ?? 3000;
          this.reconnectTimer = setTimeout(() => {
            void this.connectSocket().catch((err: unknown) => {
              this.logger.error(
                { err: (err as Error).message },
                'WhatsApp reconnect attempt failed'
              );
            });
          }, delay);
        }
      }
    });

    sock.ev.on('messages.upsert', async (upsert) => {
      if (upsert.type !== 'notify') {
        return;
      }

      for (const msg of upsert.messages) {
        const messageId = msg.key?.id;
        const rawRemoteJid = msg.key?.remoteJid;
        if (!messageId || !rawRemoteJid) {
          continue;
        }

        const remoteJid = jidNormalizedUser(rawRemoteJid);
        const fromMe = Boolean(msg.key?.fromMe);

        if (this.options.pairingMode && !this.sentMessageIds.has(messageId)) {
          const textSnippet =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            (msg.message?.imageMessage ? '[Image]' : Object.keys(msg.message || {})[0] || '');
          const isWildcard = this.options.targetChatId === '*';
          const matchesTarget = isWildcard || remoteJid === jidNormalizedUser(this.options.targetChatId);
          process.stderr.write(
            `\n[PAIRING MODE — CHAT DISCOVERY]\n` +
              `  Chat ID:    ${remoteJid}\n` +
              `  Sender:     ${msg.pushName ?? 'unknown'} (fromMe=${fromMe})\n` +
              `  Snippet:    "${textSnippet}"\n` +
              (matchesTarget
                ? `  Status:     ${isWildcard ? 'Matches wildcard routing (all personal chats allowed)' : 'Matches current config.whatsapp.targetChatId'}\n\n`
                : `  Action:     To forward this chat, set in config.json:\n` +
                  `              "whatsapp": { "targetChatId": "${remoteJid}" } (or "*" for all chats)\n\n`)
          );
        }

        // FR-09: Ignore messages originating from the bridge's own account or sent by the bridge
        if (fromMe || this.sentMessageIds.has(messageId)) {
          continue;
        }

        const rawSenderId = msg.key?.participant ?? rawRemoteJid;
        const senderId = jidNormalizedUser(rawSenderId);
        const tsSeconds =
          typeof msg.messageTimestamp === 'number'
            ? msg.messageTimestamp
            : Number(msg.messageTimestamp ?? Math.floor(Date.now() / 1000));
        const timestampMs = tsSeconds > 1e11 ? tsSeconds : tsSeconds * 1000;

        let mediaPath: string | null = null;
        const audioMsg = msg.message?.audioMessage;
        if (audioMsg) {
          try {
            const mediaDir = fs.existsSync('/data/media')
              ? '/data/media'
              : path.join(this.options.authDirectory, 'media');
            fs.mkdirSync(mediaDir, { recursive: true });

            const buffer = await downloadMediaMessage(
              msg,
              'buffer',
              {},
              {
                logger: silentLogger,
                reuploadRequest: (update) =>
                  (sock as any).updateMediaMessage?.(update) ?? Promise.resolve(msg),
              }
            );

            if (buffer && Buffer.isBuffer(buffer) && buffer.length > 0) {
              const mimetype = (audioMsg as any).mimetype || '';
              const ext =
                mimetype.includes('ogg') || mimetype.includes('opus')
                  ? '.ogg'
                  : mimetype.includes('mp4') || mimetype.includes('m4a')
                  ? '.m4a'
                  : mimetype.includes('mp3')
                  ? '.mp3'
                  : '.ogg';

              const targetFile = path.join(mediaDir, `audio-${messageId}${ext}`);
              fs.writeFileSync(targetFile, buffer);
              mediaPath = targetFile;
              this.logger.info(
                { messageId, sizeBytes: buffer.length, targetFile },
                'Downloaded audio message attachment'
              );
            }
          } catch (downloadErr) {
            this.logger.warn(
              { messageId, err: (downloadErr as Error).message },
              'Failed to download WhatsApp audio attachment; proceeding with placeholder text'
            );
          }
        }

        const rawEvent: RawWhatsAppInboundEvent = {
          eventId: messageId,
          messageId,
          chatId: remoteJid,
          senderId,
          senderName: msg.pushName ?? null,
          fromMe,
          timestampMs,
          messageContent: (msg.message as RawWhatsAppInboundEvent['messageContent']) ?? null,
          mediaPath,
        };

        for (const handler of this.inboundHandlers) {
          Promise.resolve(handler(rawEvent)).catch((err: unknown) => {
            this.logger.error(
              { err: (err as Error).message, eventId: messageId },
              'Error processing inbound WhatsApp event'
            );
          });
        }
      }
    });

    sock.ev.on('messages.update', (updates) => {
      for (const item of updates) {
        const msgId = item.key?.id;
        const status = item.update?.status;
        // Baileys WAMessageStatus: 3 = DELIVERY_ACK, 4 = READ, 5 = PLAYED
        if (msgId && typeof status === 'number' && status >= 3) {
          for (const handler of this.receiptHandlers) {
            Promise.resolve(handler({ providerMessageId: msgId, status: 'delivered' })).catch(
              (err: unknown) => {
                this.logger.error(
                  { err: (err as Error).message, providerMessageId: msgId },
                  'Error handling WhatsApp receipt update'
                );
              }
            );
          }
        }
      }
    });

    sock.ev.on('call', (calls: WACallEvent[]) => {
      for (const call of calls) {
        if (!call.id || !call.from) continue;

        const remoteJid = jidNormalizedUser(call.from);
        if (call.isGroup || isGroupWhatsAppChat(remoteJid)) {
          continue;
        }

        const isWildcard = this.options.targetChatId === '*';
        const targetNormalized = isWildcard ? '*' : jidNormalizedUser(this.options.targetChatId);
        if (!isWildcard && remoteJid !== targetNormalized) {
          continue;
        }

        if (call.status === 'offer') {
          this.callState.set(call.id, {
            from: remoteJid,
            isVideo: Boolean(call.isVideo),
            timestamp: call.date ? new Date(call.date).getTime() : Date.now(),
            accepted: false,
          });
        } else if (call.status === 'accept') {
          const state = this.callState.get(call.id);
          if (state) {
            state.accepted = true;
          }
        } else if (
          call.status === 'timeout' ||
          call.status === 'terminate' ||
          call.status === 'reject'
        ) {
          if (this.processedCallIds.has(call.id)) {
            continue;
          }

          const existingState = this.callState.get(call.id);
          if (existingState?.accepted) {
            continue;
          }

          this.processedCallIds.add(call.id);
          if (this.processedCallIds.size > 1000) {
            const first = this.processedCallIds.values().next().value;
            if (first) this.processedCallIds.delete(first);
          }
          if (this.callState.size > 500) {
            const firstKey = this.callState.keys().next().value;
            if (firstKey) this.callState.delete(firstKey);
          }

          const isVideo = call.isVideo ?? existingState?.isVideo ?? false;
          const timestampMs = call.date
            ? new Date(call.date).getTime()
            : existingState?.timestamp ?? Date.now();
          const callText = isVideo ? '[Missed Video Call]' : '[Missed Voice Call]';

          this.logger.info(
            { callId: call.id, from: remoteJid, isVideo, status: call.status },
            'Missed WhatsApp call recorded; dispatching notification'
          );

          const rawEvent: RawWhatsAppInboundEvent = {
            eventId: `call-${call.id}`,
            messageId: `call-${call.id}`,
            chatId: remoteJid,
            senderId: remoteJid,
            senderName: null,
            fromMe: false,
            timestampMs,
            messageContent: {
              conversation: callText,
            },
          };

          for (const handler of this.inboundHandlers) {
            Promise.resolve(handler(rawEvent)).catch((err: unknown) => {
              this.logger.error(
                { err: (err as Error).message, callId: call.id },
                'Error processing missed call inbound event'
              );
            });
          }
        }
      }
    });
  }

  public async sendTextMessage(chatId: string, text: string): Promise<SendMessageResult> {
    const isWildcard = this.options.targetChatId === '*';
    const targetNormalized = isWildcard ? '*' : jidNormalizedUser(this.options.targetChatId);
    const destinationNormalized = jidNormalizedUser(chatId);

    // Group chat safeguard
    if (isGroupWhatsAppChat(destinationNormalized)) {
      throw new PermanentDeliveryError(
        'Attempted to send WhatsApp message to group chat destination',
        'UNAUTHORIZED_WHATSAPP_DESTINATION'
      );
    }

    // Destination safeguard (Section 8.3)
    if (!isWildcard && destinationNormalized !== targetNormalized) {
      throw new PermanentDeliveryError(
        'Attempted to send WhatsApp message to non-configured chat destination',
        'UNAUTHORIZED_WHATSAPP_DESTINATION'
      );
    }

    if (this.connectionState === 'auth_failed') {
      throw new AuthDeliveryError(
        'WhatsApp session is not authenticated',
        'WHATSAPP_AUTH_FAILED'
      );
    }

    if (!this.isReadyForSend() || !this.socket) {
      throw new TransientDeliveryError(
        'WhatsApp connection is not currently open',
        'WHATSAPP_DISCONNECTED'
      );
    }

    try {
      const response = await this.socket.sendMessage(chatId, { text });
      const sentId = response?.key?.id;
      if (!sentId) {
        throw new AmbiguousDeliveryError(
          'WhatsApp sendMessage returned without a message identifier',
          'WHATSAPP_MISSING_MESSAGE_ID'
        );
      }

      // Track outbound message ID to prevent loop re-ingestion
      this.sentMessageIds.add(sentId);
      if (this.sentMessageIds.size > 5000) {
        const oldest = this.sentMessageIds.values().next().value;
        if (oldest) {
          this.sentMessageIds.delete(oldest);
        }
      }

      // FR-07: Initial acceptance of a WhatsApp send must not be presented as proof of recipient delivery
      return {
        providerMessageId: sentId,
        status: 'submitted',
      };
    } catch (err) {
      if (
        err instanceof AmbiguousDeliveryError ||
        err instanceof AuthDeliveryError ||
        err instanceof PermanentDeliveryError ||
        err instanceof TransientDeliveryError
      ) {
        throw err;
      }

      const error = err as { message?: string; code?: string; output?: { statusCode?: number } };
      const message = error.message ?? 'Unknown WhatsApp send error';
      const statusCode = error.output?.statusCode;

      if (statusCode === 401 || statusCode === DisconnectReason.loggedOut) {
        this.connectionState = 'auth_failed';
        throw new AuthDeliveryError(message, 'WHATSAPP_AUTH_FAILED', { cause: err });
      }

      if (
        error.code === 'ETIMEDOUT' ||
        message.toLowerCase().includes('timed out') ||
        message.toLowerCase().includes('timeout')
      ) {
        throw new AmbiguousDeliveryError(message, 'WHATSAPP_SEND_TIMEOUT', { cause: err });
      }

      throw new TransientDeliveryError(message, 'WHATSAPP_SEND_FAILED', { cause: err });
    }
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.end(undefined);
      } catch {
        // Ignore close error
      }
      this.socket = null;
    }
    this.connectionState = 'disconnected';
  }
}
