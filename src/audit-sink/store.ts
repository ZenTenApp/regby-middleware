/**
 * The permanent audit history, in a managed Postgres the sink alone connects
 * to: the broker reaches it only through the sink's token-guarded intake, so
 * a compromised broker can append records but never read or delete them. It
 * holds full invoices and full pubkeys, so it is bounded in time
 * (`retainDays`) and size (`maxRows`).
 */
import pg from 'pg';
import type { AuditRecord } from '../audit.ts';
import type { AuditSink } from './server.ts';
import { errorMessage, logger } from '../logger.ts';
import { nowSeconds } from '../time.ts';

const DAY_SECONDS = 86_400;

type ColumnValue = string | number | boolean | null;

interface Column {
  name: string;
  type: 'uuid' | 'bigint' | 'integer' | 'text' | 'boolean';
  required: boolean;
  value: (r: AuditRecord) => ColumnValue;
  /** Shown in pgAdmin and `\d+ events`; the full reference is docs/audit-events.md. */
  comment: string;
}

/** One entry per stored record field: drives the table DDL and the batch insert, so they can't drift. */
const COLUMNS: readonly Column[] = [
  { name: 'id', type: 'uuid', required: true, value: (r) => r.id,
    comment: 'Random UUID from the broker. A retried batch reuses it, so a record is never stored twice.' },
  { name: 'ts', type: 'bigint', required: true, value: (r) => r.ts,
    comment: 'Broker time (unix seconds) when the request was answered. to_timestamp(ts) for a date.' },
  { name: 'event', type: 'text', required: true, value: (r) => r.event,
    comment: 'code_issued | regby_busy | redeem | redeem_refused | blacklisted | merchant_notified (older history may also hold invalid_request). See docs/audit-events.md.' },
  { name: 'pubkey', type: 'text', required: true, value: (r) => r.pubkey,
    comment: 'Full hex pubkey: the merchant for code_issued, regby_busy, merchant_notified; the customer for redeem, redeem_refused, blacklisted/guessing.' },
  { name: 'request_event', type: 'text', required: true, value: (r) => r.requestEvent,
    comment: 'Id of the inbound Nostr event this record answers (the merchant or customer request).' },
  { name: 'code', type: 'text', required: false, value: (r) => r.code,
    comment: 'The 8-digit code: issued (code_issued) or presented by the customer (redeem, redeem_refused, blacklisted/guessing). Null otherwise.' },
  { name: 'content', type: 'text', required: false, value: (r) => r.content,
    comment: 'Full content as sent (any text, empty included), only for served requests: code_issued, regby_busy, redeem.' },
  { name: 'reason', type: 'text', required: false, value: (r) => r.reason,
    comment: 'Why the request was refused. redeem_refused: expired | redeemed | not-found. blacklisted: guessing (older history: malicious). invalid_request (older history): malformed. Null for the rest.' },
  { name: 'delivered', type: 'boolean', required: false, value: (r) => r.delivered,
    comment: 'Did the reply reach at least one relay. false on redeem means the code was used up but the customer never got the content. Null when no reply was sent (blacklisted/guessing).' },
];

const COLUMN_NAMES = COLUMNS.map((c) => c.name).join(', ');

const RECEIVED_AT_COMMENT =
  'Sink time (unix seconds) when the record was stored. Far after ts means the sink or database was down and the broker retried.';

const TABLE_COMMENT =
  'ReGBY audit history: one row per request the broker answered (or a code guesser it blacklisted), plus one per merchant redeem notice. Full reference: docs/audit-events.md.';

/**
 * Columns an older table spells differently, as [old, new]: `uri` held an
 * invoice before content became opaque, `detail` was the refusal reason.
 */
const RENAMED_COLUMNS: readonly (readonly [string, string])[] = [
  ['uri', 'content'],
  ['detail', 'reason'],
];

/** Columns an older table has that nothing writes any more. */
const DROPPED_COLUMNS: readonly string[] = ['valid_until', 'payload_hmac', 'payload_length'];

const hasColumnSql = (name: string): string =>
  `EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema() AND table_name = 'events' AND column_name = '${name}')`;

/**
 * Rename a column only while the table still has its old name: safe to run on
 * every start. A table holding BOTH names was edited by hand; renaming would
 * fail and silently picking one could lose the other's data, so stop with a
 * message that says which.
 */
const renameColumnSql = (from: string, to: string): string => `DO $$ BEGIN
    IF ${hasColumnSql(from)} AND ${hasColumnSql(to)} THEN
      RAISE EXCEPTION 'events has both % and %: merge them by hand, then drop %', '${from}', '${to}', '${from}';
    ELSIF ${hasColumnSql(from)} THEN
      ALTER TABLE events RENAME COLUMN ${from} TO ${to};
    END IF;
  END $$;`;

const quote = (text: string): string => `'${text.replaceAll("'", "''")}'`;

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS events (
    ${COLUMNS.map((c) => `${c.name} ${c.type}${c.required ? ' NOT NULL' : ''}`).join(',\n    ')},
    received_at bigint NOT NULL,
    PRIMARY KEY (id)
  );
  ${RENAMED_COLUMNS.map(([from, to]) => renameColumnSql(from, to)).join('\n  ')}
  ALTER TABLE events ${DROPPED_COLUMNS.map((c) => `DROP COLUMN IF EXISTS ${c}`).join(', ')};
  CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
  CREATE INDEX IF NOT EXISTS idx_events_code ON events(code);
  CREATE INDEX IF NOT EXISTS idx_events_pubkey ON events(pubkey);
  COMMENT ON TABLE events IS ${quote(TABLE_COMMENT)};
  ${COLUMNS.map((c) => `COMMENT ON COLUMN events.${c.name} IS ${quote(c.comment)};`).join('\n  ')}
  COMMENT ON COLUMN events.received_at IS ${quote(RECEIVED_AT_COMMENT)};
`;

/**
 * The whole batch is one statement (one array parameter per column), so it is
 * atomic and costs one round trip to the remote database however big it is.
 */
const INSERT_SQL = `
  INSERT INTO events (${COLUMN_NAMES}, received_at)
  SELECT ${COLUMN_NAMES}, $1 FROM unnest(${COLUMNS.map((c, i) => `$${i + 2}::${c.type}[]`).join(', ')})
    AS t(${COLUMN_NAMES})
  ON CONFLICT (id) DO NOTHING
`;

/**
 * Pool settings for the audit database. TLS is always verified against `ca`
 * (the provider's project CA); query parameters on the URL such as `sslmode`
 * are ignored, so a pasted `sslmode=require` can't weaken that.
 */
export function poolConfig(databaseUrl: string, ca: string): pg.PoolConfig {
  const url = new URL(databaseUrl);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`Audit database URL must be postgres://, got ${url.protocol}`);
  }
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    ssl: { ca, rejectUnauthorized: true },
    max: 4,
  };
}

export class AuditStore implements AuditSink {
  /** Trims run one at a time: two at once would each delete the same excess, twice. */
  private trimming: Promise<void> = Promise.resolve();

  private constructor(
    private readonly pool: pg.Pool,
    private readonly retainDays: number,
    private readonly maxRows: number,
    private readonly now: () => number,
    /** Kept in memory: `COUNT(*)` over millions of rows on every batch is not cheap. Assumes one sink per table. */
    private rows: number,
  ) {}

  /** Create the table if missing, count it and apply retention once before serving. */
  static async open(
    config: pg.PoolConfig,
    retainDays: number,
    maxRows: number,
    now: () => number = nowSeconds,
  ): Promise<AuditStore> {
    const pool = new pg.Pool(config);
    // An idle client dropped by the server emits here; unhandled, it kills the process.
    pool.on('error', (err) => logger.warn('Audit database connection lost', { error: errorMessage(err) }));
    try {
      await pool.query(CREATE_SQL);
      const { rows } = await pool.query<{ n: string }>('SELECT COUNT(*) AS n FROM events');
      const store = new AuditStore(pool, retainDays, maxRows, now, Number(rows[0]?.n ?? 0));
      await store.prune();
      return store;
    } catch (err) {
      await pool.end();
      throw err;
    }
  }

  get size(): number {
    return this.rows;
  }

  async insert(records: readonly AuditRecord[]): Promise<number> {
    const columns = COLUMNS.map((c) => records.map(c.value));
    const result = await this.pool.query(INSERT_SQL, [this.now(), ...columns]);
    const added = result.rowCount ?? 0;
    this.rows += added;
    if (this.rows > this.maxRows) await this.trim();
    return added;
  }

  /**
   * Drop records past retention, then trim to the row cap. Run on a timer.
   * Deleted rows linger in dead tuples until autovacuum and in the provider's
   * backups for their retention window.
   */
  async prune(): Promise<void> {
    const cutoff = this.now() - this.retainDays * DAY_SECONDS;
    const result = await this.pool.query('DELETE FROM events WHERE ts < $1', [cutoff]);
    this.rows -= result.rowCount ?? 0;
    await this.trim();
  }

  close(): Promise<void> {
    return this.pool.end();
  }

  private trim(): Promise<void> {
    // Recomputed inside the queue, so a trim waiting behind another sees what that one already deleted.
    const run = async (): Promise<void> => {
      const excess = this.rows - this.maxRows;
      if (excess <= 0) return;
      const result = await this.pool.query(
        'DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY ts, id LIMIT $1)',
        [excess],
      );
      this.rows -= result.rowCount ?? 0;
    };
    // A failed trim rejects its own caller only; the next one still runs.
    const next = this.trimming.then(run);
    this.trimming = next.catch(() => {});
    return next;
  }
}
