import { loadConfig } from './config/loader.js';
import { createLogger } from './observability/logger.js';
import { BridgeApplication } from './app.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(`[FATAL] ${(err as Error).message}\n`);
    process.exit(1);
  }

  const logger = createLogger({ level: config.logLevel });
  const app = new BridgeApplication(config, { logger });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'Received shutdown signal; stopping bridge gracefully');
    try {
      await app.stop();
      logger.info('Graceful shutdown completed');
      process.exit(0);
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'Error during graceful shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await app.start();
    logger.info('veronica v0.1.0 started');
  } catch (err) {
    logger.fatal({ err: (err as Error).message }, 'Failed to start veronica');
    process.exit(1);
  }
}

void main();
