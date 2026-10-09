/**
 * Audit sink configuration. Separate from the broker's `config.ts`: the sink
 * runs on its own machine and never holds the broker's Nostr key.
 */
import 'dotenv/config';
import { intEnv, optional } from '../env.ts';
import { loadAuditToken } from '../audit.ts';

export interface SinkConfig {
  /** Shared with the broker's `REGBY_AUDIT_TOKEN`. */
  token: string;
  dbPath: string;
  /** Plain http: put a TLS-terminating proxy in front, or bind it to a tunnel. */
  host: string;
  port: number;
  /** Records older than this are deleted. */
  retainDays: number;
  /** Hard row cap; past it the oldest records go first. */
  maxRows: number;
  logLevel: string | undefined;
}

export function loadSinkConfig(): SinkConfig {
  return {
    token: loadAuditToken(),
    dbPath: optional('REGBY_AUDIT_DB_PATH') ?? 'audit.db',
    host: optional('REGBY_AUDIT_HOST') ?? '127.0.0.1',
    port: intEnv('REGBY_AUDIT_PORT', 8787),
    retainDays: intEnv('REGBY_AUDIT_RETAIN_DAYS', 365),
    maxRows: intEnv('REGBY_AUDIT_MAX_ROWS', 10_000_000),
    logLevel: process.env.REGBY_LOG_LEVEL,
  };
}
