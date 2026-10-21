# `veronica` (v0.1.0)

Self-hosted bidirectional bridge between WhatsApp and Email, powered by Node.js, TypeScript, SQLite, Baileys, and standard SMTP + IMAP IDLE.

Built specifically for older phones (BlackBerry, Symbian, Palm, classic feature phones) and low-distraction workflows: each WhatsApp conversation appears as an **organized, threaded conversation in your phone's native email client**.

---

## Why Email?

* **Native Conversation Threads:** Every WhatsApp chat becomes its own threaded email conversation on your phone (`Message-ID`, `In-Reply-To`, and `References` RFC headers are automatically managed).
* **Zero Per-Message Cost:** No SMS segments, Twilio number rentals, or carrier fees ($0/month).
* **No Public Webhook or Port Forwarding Required:** Uses **IMAP IDLE** (push email). The bridge maintains a secure outbound TLS connection to your email provider (such as Gmail), receiving your replies **instantly (sub-second latency)** without needing a domain, static IP, or open firewall ports.
* **Universal Compatibility:** Works with any device that has a standard POP3/IMAP email client.
* **Voice Notes & Audio Attachments:** WhatsApp audio messages and voice notes arrive as playable audio attachments (`voice-message.mp3` or `.ogg`). Large voice notes (> 2MB) are automatically compressed via `ffmpeg` (24kbps mono MP3) so they load quickly on mobile networks. Photos, videos, and documents include descriptive placeholders (e.g. `[Image attached]` preserving captions).
* **Missed Call Notifications:** Missed WhatsApp voice and video calls trigger immediate notification emails (`[Missed Voice Call]`, `[Missed Video Call]`) so you never miss a call while away from a smartphone.

---

## Architecture Overview

```text
WhatsApp Web (Baileys) <---> Message Normalizer <---> Router Policy <---> SQLite (WAL) <---> Delivery Worker <---> Email (SMTP / IMAP IDLE)
```

```text
+-----------------------------------------------------------------------------------------+
|                                    EMAIL ARCHITECTURE                                   |
|                                                                                         |
|   +------------------------------------+       +------------------------------------+   |
|   |   Dedicated Bridge Account         |       |   Personal / Phone Account         |   |
|   |   (e.g. veronica-bridge@gmail.com) |       |   (e.g. your-phone@gmail.com)      |   |
|   |                                    |       |                                    |   |
|   |   - Used by Veronica server daemon |       |   - Configured on your phone       |   |
|   |   - SMTP outbound (sends to phone) | ----> |   - Reads messages in native inbox |   |
|   |   - IMAP IDLE (listens for replies)| <---- |   - Replies to bridge+chatId       |   |
|   |   - Generates Google App Password  |       |   - Authorized in allowedSenders   |   |
|   +------------------------------------+       +------------------------------------+   |
+-----------------------------------------------------------------------------------------+
```

- **Threaded Outbox (SMTP):** Inbound WhatsApp messages are formatted and sent to your phone's email address with threading references so replies stay grouped per contact.
- **Push Inbox (IMAP IDLE):** When you reply to an email from your phone, Veronica detects the incoming email instantly via IMAP IDLE, strips the quoted text (`On ... wrote:` / `> ...`), extracts the target WhatsApp chat, and dispatches your message back to WhatsApp.
- **Transactional Outbox & Deduplication:** Incoming events and outbound jobs are persisted atomically in SQLite (`inbound_events`, `messages`, `delivery_jobs`) with `UNIQUE(source_channel, source_event_id)` deduplication.
- **Ambiguity Protection:** If a network timeout or crash occurs mid-flight, jobs transition to `unknown` rather than being blindly resent.

---

> [!IMPORTANT]
> ### Two Different Email Accounts Are Required
>
> Veronica strictly requires **two distinct email accounts**:
>
> 1. **Bridge Email Account** (`email.smtp.user`, `email.smtp.fromAddress`, `email.imap.user`):
>    A dedicated email account created solely for the Veronica server (e.g., `my-veronica-bridge@gmail.com`). The bridge logs into this account to send outbound emails and monitor for incoming replies. **The Google App Password must be generated on this account.**
>
> 2. **Personal / Phone Email Account** (`email.userEmail`, `routing.allowedEmailSenders`):
>    Your personal email address configured on your phone's email app (e.g. `your-phone@example.com` or your personal Gmail). This is where you receive WhatsApp messages and from which you send replies.
>
> **Why you cannot use the same email account for both:**
> * **Infinite Loop Prevention:** If the bridge logs into your personal email and sends messages to itself, IMAP IDLE would detect its own outbound messages as new incoming mail, potentially creating an infinite delivery loop back to WhatsApp.
> * **Gmail Self-Threading Quirk:** In Gmail, sending an email to yourself bypasses normal inbox notifications and merges messages into existing threads in unexpected ways.
> * **Strict Sender Authorization:** Veronica verifies that incoming replies match `allowedEmailSenders`. Separating the accounts ensures that only emails from your authenticated personal device can dispatch messages to WhatsApp.
> * **Security Isolation:** Your personal email password / primary Google account credentials never need to be stored on the server.

---

## Quick Start (Docker Compose)

### 1. Prepare Configuration & Secrets

1. Copy the example configuration and environment files:
   ```bash
   cp config.example.json config.json
   cp .env.example .env
   mkdir -p secrets
   chmod 0700 secrets
   ```

2. Generate an **App Password** on your **Bridge Gmail account**:
   * Log into your **dedicated bridge Google Account** (not your personal account).
   * Navigate to Google Account → Security → 2-Step Verification → [App Passwords](https://myaccount.google.com/apppasswords).
   * Create an app password (e.g. named `Veronica`) and copy the 16-character code.
   * Place your app password in `./secrets/email_password.txt` (no trailing newline):
     ```bash
     printf "%s" "your-16-char-app-password" > ./secrets/email_password.txt
     chmod 0600 ./secrets/email_password.txt
     ```

3. Edit `config.json`:
   ```json
   {
     "whatsapp": {
       "enabled": true,
       "targetChatId": "*",
       "authDirectory": "/auth"
     },
     "email": {
       "smtp": {
         "host": "smtp.gmail.com",
         "port": 465,
         "secure": true,
         "user": "your-bridge-account@gmail.com",
         "fromAddress": "your-bridge-account@gmail.com"
       },
       "imap": {
         "host": "imap.gmail.com",
         "port": 993,
         "secure": true,
         "user": "your-bridge-account@gmail.com",
         "enabled": true
       },
       "userEmail": "your-phone-email@example.com",
       "replyDomain": "gmail.com"
     },
     "routing": {
       "whatsappToEmail": true,
       "emailToWhatsapp": true,
       "allowedEmailSenders": [
         "your-phone-email@example.com"
       ]
     },
     "database": {
       "path": "/data/bridge.sqlite",
       "retentionDays": 7
     },
     "worker": {
       "pollIntervalMs": 1000,
       "maxAttempts": 5,
       "baseBackoffMs": 1000,
       "maxBackoffMs": 60000,
       "processingTimeoutMs": 30000
     },
     "http": {
       "host": "0.0.0.0",
       "port": 3000
     }
   }
   ```

> [!TIP]
> **Single Chat vs. Multi-Chat Bridging:**
> - Set `"targetChatId": "*"` to bridge **all** your 1-on-1 WhatsApp conversations. Each contact automatically receives their own distinct email thread.
> - Or set `"targetChatId": "15551234567@s.whatsapp.net"` (or `@lid`) to bridge only a single specific contact.
> - Group chats (`@g.us`) and broadcast lists are automatically filtered out.

---

### 2. Initial WhatsApp Authentication & Chat Discovery

QR codes and authentication secrets are **never** written to application JSON logs.

1. **Start in Pairing Mode (Development / Local Build):**
   ```bash
   WHATSAPP_PAIRING_MODE=true docker compose -f docker-compose.dev.yml up --build
   ```
2. **Scan the ASCII QR Code:**
   * Scan the QR code rendered directly in your terminal using **WhatsApp → Settings / Menu → Linked Devices → Link a Device**.
   * Wait for `[WHATSAPP CONNECTED SUCCESSFULLY!]`.
3. **Verify Chat ID (Optional if using `"*"`):**
   * If you prefer locking down to a single contact instead of `"targetChatId": "*"`, send a test message in that WhatsApp chat.
   * The terminal prints:
     ```text
     [PAIRING MODE — CHAT DISCOVERY]
       Chat ID:    67474053709896@lid
       Sender:     Alice (fromMe=false)
       Snippet:    "Hello"
     ```
   * Set `whatsapp.targetChatId` in `config.json` to this Chat ID (both `@lid` and `@s.whatsapp.net` formats are supported).
4. **Switch to Production Background Service:**
   * Press `Ctrl + C` to stop interactive pairing.
   * Set `WHATSAPP_PAIRING_MODE=false` in `.env`.
   * Start the production service (uses the prebuilt GHCR image with automated Watchtower updates):
     ```bash
     docker compose up -d
     # or: docker compose -f docker-compose.prod.yml up -d
     ```
   * Your WhatsApp session is stored in the `bridge_auth` Docker volume (`/auth`, mode `0700`) and persists across container restarts.

---

### 3. How Messaging Works

1. **When someone sends you a WhatsApp message:**
   * You receive an email:
     * **From:** `Alice <your-bridge-account@gmail.com>`
     * **Reply-To:** `<your-bridge-account+67474053709896__lid@gmail.com>` (or `+15551234567__s.whatsapp.net@gmail.com`)
     * **Subject:** `WhatsApp: Alice`
   * *Why `__` in the reply address?* WhatsApp JIDs include `@`. To prevent invalid email addresses with two `@` symbols that mail providers like Gmail reject, Veronica encodes `@` as `__` in the plus-address tag and decodes it when parsing incoming replies.
   * If the sender sends a voice note, it is attached as a playable audio file (`voice-message.mp3` or `.ogg`).
2. **Replying from your older phone:**
   * Simply hit **Reply** in your email app and type your message.
   * Veronica resolves the destination chat using the plus-address or native `In-Reply-To` / `References` headers.
   * Veronica automatically strips quoted history and mobile signatures:
     * Quoted history: `On ... wrote:`, `Em ... escreveu:`, `No dia ... escreveu:`
     * Divider lines: `--- Original Message ---`, `--- Mensagem Original ---`, `--- Forwarded Message ---`
     * Standard RFC 3676 delimiters: `-- `
     * Mobile signatures: `Sent from my iPhone`, `Enviado do meu BlackBerry`, `Get Outlook for iOS`, etc.
   * Only your clean reply is forwarded back to WhatsApp!

---

## Health & Observability

- **`GET /health/live`**: Returns `200 OK` (`{"status":"ok"}`) when the process is alive.
- **`GET /health/ready`**: Returns `200 OK` when SQLite, WhatsApp, and the Email provider are healthy; returns `503` if any component is disconnected or failing authentication.
- **Queue and Metrics:** Health payloads include sanitized queue depths (`pending`, `processing`, `submitted`, `delivered`, `failed`, `dead_letter`, `unknown`) and operational metrics without exposing passwords, email addresses, or chat IDs.

---

## Local Development & Testing

```bash
# Install dependencies
npm ci

# Typecheck
npm run typecheck

# Run full test suite (unit, integration & E2E)
npm test

# Build production bundle
npm run build
```

> [!NOTE]
> If testing audio compression locally outside Docker, ensure `ffmpeg` is installed on your host system (`brew install ffmpeg` on macOS, or `apt install ffmpeg` on Debian/Ubuntu).

---

## License

Released under the [MIT License](./LICENSE).
