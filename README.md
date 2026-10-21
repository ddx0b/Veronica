# `veronica` (v0.1.0)

Self-hosted bidirectional bridge between WhatsApp and Email, powered by Node.js, TypeScript, SQLite, Baileys, and standard SMTP + IMAP IDLE.

Built specifically for older phones (BlackBerry, Symbian, Palm, classic feature phones) and low-distraction workflows: each WhatsApp conversation appears as an **organized, threaded conversation in your phone's native email client**.

---

## Why Email?

* **Native Conversation Threads:** Every WhatsApp chat becomes its own threaded email conversation on your phone (`Message-ID`, `In-Reply-To`, and `References` RFC headers are automatically managed).
* **Zero Per-Message Cost:** No SMS segments, Twilio number rentals, or carrier fees ($0/month).
* **No Public Webhook or Port Forwarding Required:** Uses **IMAP IDLE** (push email). The bridge maintains a secure outbound TLS connection to your email provider (such as Gmail), receiving your replies **instantly (sub-second latency)** without needing a domain, static IP, or open firewall ports.
* **Universal Compatibility:** Works with any device that has a standard POP3/IMAP email client.
* **Attachments:** Pictures and documents from WhatsApp arrive as standard email attachments.

---

## Architecture Overview

```text
WhatsApp Web (Baileys) <---> Message Normalizer <---> Router Policy <---> SQLite (WAL) <---> Delivery Worker <---> Email (SMTP / IMAP IDLE)
```

- **Threaded Outbox (SMTP):** Inbound WhatsApp messages are formatted and sent to your phone's email address with threading references so replies stay grouped per contact.
- **Push Inbox (IMAP IDLE):** When you reply to an email from your phone, Veronica detects the incoming email instantly via IMAP IDLE, strips the quoted text (`On ... wrote:` / `> ...`), extracts the target WhatsApp chat, and dispatches your message back to WhatsApp.
- **Transactional Outbox & Deduplication:** Incoming events and outbound jobs are persisted atomically in SQLite (`inbound_events`, `messages`, `delivery_jobs`) with `UNIQUE(source_channel, source_event_id)` deduplication.
- **Ambiguity Protection:** If a network timeout or crash occurs mid-flight, jobs transition to `unknown` rather than being blindly resent.

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

2. Generate an **App Password** for your email account:
   * **If using Gmail:** Go to your Google Account → Security → 2-Step Verification → [App Passwords](https://myaccount.google.com/apppasswords), create an app password (e.g. named `Veronica`), and copy the 16-character code.
   * Place your email password in `./secrets/email_password.txt` (no trailing newline):
     ```bash
     printf "%s" "your-16-char-app-password" > ./secrets/email_password.txt
     chmod 0600 ./secrets/email_password.txt
     ```

3. Edit `config.json`:
   ```json
   {
     "whatsapp": {
       "enabled": true,
       "targetChatId": "15551234567@s.whatsapp.net",
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
       "maxBackoffMs": 60000
     },
     "http": {
       "host": "0.0.0.0",
       "port": 3000
     }
   }
   ```

---

### 2. Initial WhatsApp Authentication & Chat Discovery

QR codes and authentication secrets are **never** written to application JSON logs.

1. **Start in Pairing Mode:**
   ```bash
   WHATSAPP_PAIRING_MODE=true docker compose up --build
   ```
2. **Scan the ASCII QR Code:**
   * Scan the QR code rendered directly in your terminal using **WhatsApp → Settings / Menu → Linked Devices → Link a Device**.
   * Wait for `[WHATSAPP CONNECTED SUCCESSFULLY!]`.
3. **Verify Chat ID:**
   * Send a test message in the WhatsApp conversation you want to bridge.
   * The terminal prints:
     ```text
     [PAIRING MODE — CHAT DISCOVERY]
       Chat ID:    67474053709896@lid
       Sender:     Alice (fromMe=false)
       Snippet:    "Hello"
     ```
   * Ensure `whatsapp.targetChatId` in `config.json` matches this Chat ID (both `@lid` and `@s.whatsapp.net` formats are supported).
4. **Switch to Background Service:**
   * Press `Ctrl + C` to stop interactive pairing.
   * Set `WHATSAPP_PAIRING_MODE=false` in `.env`.
   * Start in daemon mode:
     ```bash
     docker compose up -d
     ```
   * Your WhatsApp session is stored in the `bridge_auth` Docker volume (`/auth`, mode `0700`) and persists across container restarts.

---

### 3. How Messaging Works

1. **When someone sends you a WhatsApp message:**
   * You receive an email from `Alice <your-bridge-account+67474053709896@gmail.com>` with subject `WhatsApp: Alice`.
   * The message body contains the clean text (and media placeholders or attachments).
2. **Replying from your older phone:**
   * Simply hit **Reply** in your email app and type your message.
   * Veronica automatically strips the quoted email history (`On Oct 21 ... wrote:`, `> ...`, mobile signatures like `Sent from my iPhone` / `Enviado do meu BlackBerry`) and sends only your new text to WhatsApp!

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

---

## License

Released under the [MIT License](./LICENSE).
