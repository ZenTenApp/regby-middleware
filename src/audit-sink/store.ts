/**
 * The permanent audit history: one SQLite file the sink owns. It holds full
 * invoices and full pubkeys, so it is bounded in time (`retainDays`) and size
 * (`maxRows`), and readable only by the sink's user: the folder is forced to
 * 0700 and the file to 0600 (the process umask covers the WAL sidecars).
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuditRecord } from '../audit.ts';
import { nowSeconds } from '../time.ts';

const DAY_SECONDS = 86_400;

export class AuditStore {
  private readonly db: DatabaseSync;
  private readonly insertStmt: StatementSync;
  private readonly expireStmt: StatementSync;
  private readonly trimStmt: StatementSync;
  /** Kept in memory: `COUNT(*)` over millions of rows on every batch is not cheap. */
  private rows: number;

  constructor(
    dbPath: string,
    private readonly retainDays: number,
    private readonly maxRows: number,
    private readonly now: () => number = nowSeconds,
  ) {
    const onDisk = dbPath !== ':memory:';
    if (onDisk) {
      const dir = dirname(dbPath);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      // mkdir leaves an existing folder's mode alone; this one must not be.
      chmodSync(dir, 0o700);
    }
    this.db = new DatabaseSync(dbPath);
    if (onDisk) chmodSync(dbPath, 0o600);
    this.db.exec('PRAGMA journal_mode = WAL');
    // Expired records are overwritten, not left readable in free pages.
    this.db.exec('PRAGMA secure_delete = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id             TEXT PRIMARY KEY,
        ts             INTEGER NOT NULL,
        received_at    INTEGER NOT NULL,
        event          TEXT NOT NULL,
        pubkey         TEXT NOT NULL,
        request_event  TEXT NOT NULL,
        code           TEXT,
        uri            TEXT,
        valid_until    INTEGER,
        payload_hmac   TEXT,
        payload_length INTEGER,
        detail         TEXT,
        delivered      INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
      CREATE INDEX IF NOT EXISTS idx_events_code ON events(code);
      CREATE INDEX IF NOT EXISTS idx_events_pubkey ON events(pubkey);
    `);
    this.insertStmt = this.db.prepare(
      `INSERT OR IGNORE INTO events (id, ts, received_at, event, pubkey, request_event, code, uri,
         valid_until, payload_hmac, payload_length, detail, delivered)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.expireStmt = this.db.prepare('DELETE FROM events WHERE ts < ?');
    this.trimStmt = this.db.prepare(
      'DELETE FROM events WHERE rowid IN (SELECT rowid FROM events ORDER BY ts, rowid LIMIT ?)',
    );
    this.rows = (this.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
    this.prune();
  }

  get size(): number {
    return this.rows;
  }

  /** Store a batch atomically; a record id seen before is skipped (a retry). Returns the rows added (test seam). */
  insert(records: readonly AuditRecord[]): number {
    const receivedAt = this.now();
    let added = 0;
    this.db.exec('BEGIN');
    try {
      for (const r of records) {
        const result = this.insertStmt.run(
          r.id,
          r.ts,
          receivedAt,
          r.event,
          r.pubkey,
          r.requestEvent,
          r.code,
          r.uri,
          r.validUntil,
          r.payloadHmac,
          r.payloadLength,
          r.detail,
          r.delivered === null ? null : Number(r.delivered),
        );
        added += Number(result.changes);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    this.rows += added;
    if (this.rows > this.maxRows) this.trim();
    return added;
  }

  /** Drop records past retention, then trim to the row cap. Run on a timer. */
  prune(): void {
    const cutoff = this.now() - this.retainDays * DAY_SECONDS;
    this.rows -= Number(this.expireStmt.run(cutoff).changes);
    this.trim();
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  close(): void {
    this.db.close();
  }

  private trim(): void {
    const excess = this.rows - this.maxRows;
    if (excess <= 0) return;
    this.rows -= Number(this.trimStmt.run(excess).changes);
  }
}
