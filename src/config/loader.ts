import fs from 'node:fs';
import { ConfigFileSchema, SecretsSchema, type AppConfig } from './schema.js';

export interface LoadConfigOptions {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}

function readSecretFromEnvOrFile(
  envVarName: string,
  fileEnvVarName: string,
  defaultSecretPath: string,
  env: NodeJS.ProcessEnv
): string | undefined {
  const filePath = env[fileEnvVarName] ?? (fs.existsSync(defaultSecretPath) ? defaultSecretPath : undefined);
  if (filePath) {
    try {
      return fs.readFileSync(filePath, 'utf8').trim();
    } catch (err) {
      throw new Error(
        `Failed to read secret file at '${filePath}' (configured via ${fileEnvVarName}): ${(err as Error).message}`
      );
    }
  }

  const directValue = env[envVarName];
  if (directValue !== undefined && directValue.trim().length > 0) {
    return directValue.trim();
  }

  return undefined;
}

export function validateConfigObject(
  rawConfig: unknown,
  rawSecrets: unknown,
  options?: { logLevel?: string; whatsappPairingMode?: boolean }
): AppConfig {
  const parsedConfig = ConfigFileSchema.safeParse(rawConfig);
  if (!parsedConfig.success) {
    const issues = parsedConfig.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(`Configuration validation failed: ${issues}`);
  }

  const parsedSecrets = SecretsSchema.safeParse(rawSecrets);
  if (!parsedSecrets.success) {
    const issues = parsedSecrets.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(`Secret validation failed: ${issues}`);
  }

  return {
    ...parsedConfig.data,
    secrets: parsedSecrets.data,
    logLevel: options?.logLevel ?? 'info',
    whatsappPairingMode: options?.whatsappPairingMode ?? false,
  };
}

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const env = options.env ?? process.env;
  const configPath = options.configPath ?? env.CONFIG_PATH ?? './config.json';

  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Configuration file not found at '${configPath}'. Provide a valid JSON config file or set CONFIG_PATH.`
    );
  }

  let rawJson: unknown;
  try {
    const fileContents = fs.readFileSync(configPath, 'utf8');
    rawJson = JSON.parse(fileContents);
  } catch (err) {
    throw new Error(`Failed to parse configuration file '${configPath}': ${(err as Error).message}`);
  }

  // Allow optional non-secret overrides from environment variables
  if (rawJson && typeof rawJson === 'object') {
    const cfg = rawJson as Record<string, unknown>;
    if (cfg.email && typeof cfg.email === 'object') {
      const emailCfg = cfg.email as Record<string, unknown>;
      if (env.SMTP_HOST && emailCfg.smtp && typeof emailCfg.smtp === 'object') {
        (emailCfg.smtp as Record<string, unknown>).host = env.SMTP_HOST.trim();
      }
      if (env.IMAP_HOST && emailCfg.imap && typeof emailCfg.imap === 'object') {
        (emailCfg.imap as Record<string, unknown>).host = env.IMAP_HOST.trim();
      }
      if (env.USER_EMAIL) {
        emailCfg.userEmail = env.USER_EMAIL.trim();
      }
    }
  }

  const emailPassword = readSecretFromEnvOrFile(
    'EMAIL_PASSWORD',
    'EMAIL_PASSWORD_FILE',
    '/run/secrets/email_password',
    env
  );

  return validateConfigObject(
    rawJson,
    { emailPassword },
    {
      logLevel: env.LOG_LEVEL ?? 'info',
      whatsappPairingMode: env.WHATSAPP_PAIRING_MODE === 'true',
    }
  );
}
