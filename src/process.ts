/**
 * Process lifecycle shared by the broker and the audit sink entry points.
 */
import { errorMessage, logger } from './logger.ts';

/** Run `main`; a throw at boot is logged and exits non-zero. */
export function runMain(main: () => void): void {
  try {
    main();
  } catch (err) {
    logger.error('Fatal on boot', { message: errorMessage(err) });
    process.exit(1);
  }
}

/**
 * Stop once on SIGINT/SIGTERM, then exit. A second signal during an async
 * stop (the audit's last flush, a server draining) must not close twice.
 */
export function onShutdown(stop: () => Promise<void>): void {
  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info('Shutting down', { signal });
    void stop()
      .then(
        () => 0,
        (err: unknown) => {
          logger.error('Shutdown failed', { message: errorMessage(err) });
          return 1;
        },
      )
      .then((code) => process.exit(code));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
