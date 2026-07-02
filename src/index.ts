/**
 * Entry point: load config, start the broker, handle graceful shutdown.
 */
import { loadConfig } from './config.ts';
import { configureLogger, logger } from './logger.ts';
import { ReGBYBroker } from './server.ts';

function main(): void {
  const config = loadConfig();
  configureLogger(config.logLevel);

  logger.info('regby-middleware booting', {
    pubkey: config.publicKey,
    relays: config.relays,
    codeTtlSeconds: config.codeTtlSeconds,
  });

  const broker = new ReGBYBroker(config);
  broker.start();

  const shutdown = (signal: string): void => {
    logger.info('Shutting down', { signal });
    broker.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

try {
  main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  logger.error('Fatal on boot', { message });
  process.exit(1);
}
