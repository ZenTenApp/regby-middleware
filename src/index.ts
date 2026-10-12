/**
 * Entry point: load config, start the broker, handle graceful shutdown.
 */
import { resolve } from 'node:path';
import { loadConfig } from './config.ts';
import { configureLogger, logger } from './logger.ts';
import { onShutdown, runMain } from './process.ts';
import { ReGBYBroker } from './server.ts';

runMain(() => {
  const config = loadConfig();
  configureLogger(config.logLevel);

  logger.info('regby-middleware booting', {
    pubkey: config.publicKey,
    relays: config.relays,
    codeTtlSeconds: config.codeTtlSeconds,
    // Host only: the path is the sink's business, the token never logged.
    auditSink: config.audit?.url.host ?? null,
    // Absolute, so a deploy can confirm the store sits on the mounted volume.
    dbPath: resolve(config.dbPath),
  });

  const broker = new ReGBYBroker(config);
  broker.start();
  onShutdown(() => broker.stop());
});
