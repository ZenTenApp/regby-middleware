/**
 * Audit sink entry point. Runs on the external machine, not beside the broker:
 * `node dist/audit-sink/index.js`.
 */
import { resolve } from 'node:path';
import { loadSinkConfig } from './config.ts';
import { AuditStore } from './store.ts';
import { createSinkServer } from './server.ts';
import { configureLogger, logger } from '../logger.ts';
import { onShutdown, runMain } from '../process.ts';

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

runMain(() => {
  // Owner-only for every file this process creates, WAL sidecars included.
  process.umask(0o077);
  const config = loadSinkConfig();
  configureLogger(config.logLevel);

  const store = new AuditStore(config.dbPath, config.retainDays, config.maxRows);
  const pruneTimer = setInterval(() => store.prune(), PRUNE_INTERVAL_MS);
  pruneTimer.unref();

  const server = createSinkServer(store, config.token);
  server.listen(config.port, config.host, () => {
    logger.info('Audit sink listening', {
      host: config.host,
      port: config.port,
      dbPath: resolve(config.dbPath),
      rows: store.size,
      retainDays: config.retainDays,
      maxRows: config.maxRows,
    });
  });

  onShutdown(
    () =>
      new Promise<void>((done) => {
        clearInterval(pruneTimer);
        server.close(() => {
          store.close();
          done();
        });
      }),
  );
});
