/**
 * Audit sink entry point. Its own container next to the broker, the only one
 * with the database credentials:
 * `node dist/audit-sink/index.js`.
 */
import { loadSinkConfig } from './config.ts';
import { AuditStore, poolConfig } from './store.ts';
import { createSinkServer } from './server.ts';
import { configureLogger, errorMessage, logger } from '../logger.ts';
import { onShutdown, runMain } from '../process.ts';

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

runMain(async () => {
  const config = loadSinkConfig();
  configureLogger(config.logLevel);

  const db = poolConfig(config.databaseUrl, config.databaseCa);
  const store = await AuditStore.open(db, config.retainDays, config.maxRows);
  const pruneTimer = setInterval(() => {
    store.prune().catch((err: unknown) => logger.error('Audit prune failed', { error: errorMessage(err) }));
  }, PRUNE_INTERVAL_MS);
  pruneTimer.unref();

  const server = createSinkServer(store, config.token);
  server.listen(config.port, config.host, () => {
    logger.info('Audit sink listening', {
      host: config.host,
      port: config.port,
      // Host only: the URL carries the database password.
      database: `${db.host}:${db.port}/${db.database}`,
      rows: store.size,
      retainDays: config.retainDays,
      maxRows: config.maxRows,
    });
  });

  onShutdown(async () => {
    clearInterval(pruneTimer);
    await new Promise<void>((done) => server.close(() => done()));
    await store.close();
  });
});
