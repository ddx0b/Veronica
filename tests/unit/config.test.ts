import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, validateConfigObject } from '../../src/config/loader.js';

const VALID_EMAIL_PASSWORD = 'super-secret-password-123';

const VALID_RAW_CONFIG = {
  whatsapp: {
    enabled: true,
    targetChatId: '15551234567@s.whatsapp.net',
    authDirectory: '/auth',
  },
  email: {
    smtp: {
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      user: 'bridge@example.com',
      fromAddress: 'bridge@example.com',
    },
    imap: {
      host: 'imap.example.com',
      port: 993,
      secure: true,
      user: 'bridge@example.com',
      enabled: true,
    },
    userEmail: 'user@example.com',
    replyDomain: 'bridge.local',
  },
  routing: {
    whatsappToEmail: true,
    emailToWhatsapp: true,
    allowedEmailSenders: ['user@example.com'],
  },
  database: {
    path: '/data/bridge.sqlite',
  },
  worker: {
    pollIntervalMs: 1000,
    maxAttempts: 5,
    baseBackoffMs: 1000,
    maxBackoffMs: 60000,
  },
  http: {
    host: '0.0.0.0',
    port: 3000,
  },
};

describe('Configuration Validation', () => {
  it('accepts valid configuration and secret', () => {
    const cfg = validateConfigObject(VALID_RAW_CONFIG, {
      emailPassword: VALID_EMAIL_PASSWORD,
    });
    assert.equal(cfg.whatsapp.targetChatId, '15551234567@s.whatsapp.net');
    assert.equal(cfg.secrets.emailPassword, VALID_EMAIL_PASSWORD);
  });

  it('accepts wildcard "*" targetChatId for multi-chat bridging', () => {
    const cfg = validateConfigObject(
      {
        ...VALID_RAW_CONFIG,
        whatsapp: {
          ...VALID_RAW_CONFIG.whatsapp,
          targetChatId: '*',
        },
      },
      { emailPassword: VALID_EMAIL_PASSWORD }
    );
    assert.equal(cfg.whatsapp.targetChatId, '*');
  });

  it('fails fast when WhatsApp targetChatId is a group chat (@g.us)', () => {
    assert.throws(
      () =>
        validateConfigObject(
          {
            ...VALID_RAW_CONFIG,
            whatsapp: {
              ...VALID_RAW_CONFIG.whatsapp,
              targetChatId: '120363025555@g.us',
            },
          },
          { emailPassword: VALID_EMAIL_PASSWORD }
        ),
      /Group or broadcast WhatsApp chats/
    );
  });

  it('fails fast when email addresses are invalid or secrets are missing', () => {
    assert.throws(
      () =>
        validateConfigObject(
          {
            ...VALID_RAW_CONFIG,
            email: {
              ...VALID_RAW_CONFIG.email,
              userEmail: 'not-an-email',
            },
          },
          { emailPassword: VALID_EMAIL_PASSWORD }
        ),
      /userEmail must be a valid email address/
    );

    assert.throws(
      () => validateConfigObject(VALID_RAW_CONFIG, { emailPassword: '' }),
      /Secret validation failed/
    );
  });

  it('loads secrets from a Docker secret file via EMAIL_PASSWORD_FILE', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-email-cfg-'));
    try {
      const cfgPath = path.join(tmpDir, 'config.json');
      const secretPath = path.join(tmpDir, 'email_password');
      fs.writeFileSync(cfgPath, JSON.stringify(VALID_RAW_CONFIG), 'utf8');
      fs.writeFileSync(secretPath, `${VALID_EMAIL_PASSWORD}\n`, 'utf8');

      const loaded = loadConfig({
        configPath: cfgPath,
        env: {
          EMAIL_PASSWORD_FILE: secretPath,
        },
      });
      assert.equal(loaded.secrets.emailPassword, VALID_EMAIL_PASSWORD);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
