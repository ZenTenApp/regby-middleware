/**
 * Minimal structured (JSON-lines) logger. Levels gate output; the default is
 * `info`. SECURITY: never pass a decrypted `uri` or a live `code` into an
 * info/warn/error call - those belong at `debug` only, off in production.
 */

type Level = 'error' | 'warn' | 'info' | 'debug';

const ORDER: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };

function parseLevel(value: string | undefined): Level {
  if (value === 'error' || value === 'warn' || value === 'info' || value === 'debug') return value;
  return 'info';
}

let threshold: Level = 'info';

export function configureLogger(level: string | undefined): void {
  threshold = parseLevel(level);
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] > ORDER[threshold]) return;
  const line = { level, msg, ...fields };
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(JSON.stringify(line) + '\n');
}

export const logger = {
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
};
