/**
 * Audit sink configuration. Separate from the broker's `config.ts`: the sink
 * runs as its own process and never holds the broker's Nostr key.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { intEnv, optional, required } from '../env.ts';
import { loadAuditToken } from '../audit.ts';

export interface SinkConfig {
  /** Shared with the broker's `REGBY_AUDIT_TOKEN`. */
  token: string;
  /** `postgres://user:password@host:port/database`; only the sink holds it. */
  databaseUrl: string;
  /** PEM of the CA the database's TLS certificate must chain to. */
  databaseCa: string;
  /** Plain http: bind only where the broker alone can reach it (see docker-compose.audit.yml). */
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
    databaseUrl: required('REGBY_AUDIT_DATABASE_URL'),
    databaseCa: readFileSync(required('REGBY_AUDIT_DATABASE_CA'), 'utf8'),
    host: optional('REGBY_AUDIT_HOST') ?? '127.0.0.1',
    port: intEnv('REGBY_AUDIT_PORT', 8787),
    retainDays: intEnv('REGBY_AUDIT_RETAIN_DAYS', 365),
    maxRows: intEnv('REGBY_AUDIT_MAX_ROWS', 10_000_000),
    logLevel: process.env.REGBY_LOG_LEVEL,
  };
}
