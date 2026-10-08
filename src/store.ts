/**
 * SQLite-backed code store. Maps an 8-digit code to the merchant's payment-request
 * URI, persisted so codes survive a server restart (the previous in-memory Map
 * lost every code on reboot - a restart used to make all codes unredeemable).
 *
 * Validity timestamps per row, both anchored to the merchant request's
 * `created_at` (skew-clamped by the caller):
 *   - `expires_at`   = startedAt + ttl     → code **validity** (2 min). Past this
 *     a redeem returns `expired`, but the row is KEPT.
 *   - `retain_until` = startedAt + retain  → row **retention** (1 h). A redeem
 *     between expiry and retention still reports `expired` (clear UX: "the code
 *     was real but lapsed"); only past retention is it `not-found`.
 * Plus `created_at` = the server wall-clock at mint, an audit column not used in
 * any validity decision.
 *
 * **Single-use**: the first successful redeem consumes the code - its `uri` is
 * wiped and `expires_at` pulled to now, so a second redeem reports `expired`
 * exactly like a lapsed code. The sweep also wipes the `uri` of every lapsed
 * row and checkpoints the WAL, so the `codes` table holds the plaintext invoice
 * at most one sweep interval past validity or use: `secure_delete` zeroes the
 * bytes in the main file, and the TRUNCATE checkpoint drops the pre-wipe page
 * images the `-wal` log would otherwise keep. Only the code shell stays for the
 * retention window. The same file also carries the append-only `events` table
 * (`audit.ts`), which keeps every invoice for good - the wipe governs what can
 * still be redeemed, not what is on record. The consume is a compare-and-set
 * on the row itself, so a code is served at most once even if the wall clock
 * steps backward.
 * `node:sqlite`'s synchronous API matches this single-process, single-loop
 * server - no async driver, no extra dependency.
 *
 * `RotatingCodeStore` (below) wraps this with a new file per UTC day.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { randomInt } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { nowSeconds } from './time.ts';
import { AuditLog, type AuditEntry } from './audit.ts';

export interface MintResult {
  code: string;
  /** Unix seconds the code stops being valid. */
  expiresAt: number;
}

export type RedeemFailure = 'not-found' | 'expired';

export type RedeemResult = { ok: true; uri: string } | { ok: false; reason: RedeemFailure };

/** Shared surface of `CodeStore` and its rotating wrapper - the broker's seam. */
export interface CodeStoreLike {
  mint(uri: string, startedAt: number): MintResult | null;
  redeem(code: string): RedeemResult;
  sweep(): void;
  /** Append to the permanent audit trail in the current day's file. */
  record(entry: AuditEntry): void;
  readonly size: number;
  close(): void;
}

interface CodeRow {
  uri: string;
  expires_at: number;
  retain_until: number;
}

const CODE_SPACE = 100_000_000; // eight digits: 00000000–99999999
const MAX_MINT_ATTEMPTS = 20; // collision retries before giving up

export class CodeStore implements CodeStoreLike {
  private readonly db: DatabaseSync;
  private readonly insertStmt: StatementSync;
  private readonly selectStmt: StatementSync;
  private readonly deleteStmt: StatementSync;
  private readonly consumeStmt: StatementSync;
  private readonly scrubStmt: StatementSync;
  private readonly sweepStmt: StatementSync;
  private readonly countStmt: StatementSync;
  private readonly audit: AuditLog;

  constructor(
    private readonly ttlSeconds: number,
    private readonly retainSeconds: number,
    private readonly maxEntries: number,
    dbPath: string,
    private readonly now: () => number = nowSeconds,
  ) {
    // SQLite won't create missing parent dirs; the daily path nests YYYY/MM.
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    // WAL keeps reads/writes from blocking each other and survives a hard crash.
    this.db.exec('PRAGMA journal_mode = WAL');
    // Wiped invoices are overwritten with zeros, not left readable in free pages.
    this.db.exec('PRAGMA secure_delete = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS codes (
        code         TEXT PRIMARY KEY,
        uri          TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL,
        retain_until INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_codes_retain ON codes(retain_until);
    `);
    this.insertStmt = this.db.prepare(
      'INSERT OR IGNORE INTO codes (code, uri, created_at, expires_at, retain_until) VALUES (?, ?, ?, ?, ?)',
    );
    this.selectStmt = this.db.prepare(
      'SELECT uri, expires_at, retain_until FROM codes WHERE code = ?',
    );
    this.deleteStmt = this.db.prepare('DELETE FROM codes WHERE code = ?');
    // Guarded on the row, not on the caller's earlier read: only an unused,
    // unexpired row flips, so `changes` alone is the redeem verdict.
    this.consumeStmt = this.db.prepare(
      "UPDATE codes SET uri = '', expires_at = ?1 WHERE code = ?2 AND uri != '' AND expires_at > ?1",
    );
    this.scrubStmt = this.db.prepare(
      "UPDATE codes SET uri = '' WHERE expires_at <= ? AND uri != ''",
    );
    this.sweepStmt = this.db.prepare('DELETE FROM codes WHERE retain_until <= ?');
    this.countStmt = this.db.prepare('SELECT COUNT(*) AS n FROM codes');
    this.audit = new AuditLog(this.db, this.now);
  }

  get size(): number {
    return (this.countStmt.get() as { n: number }).n;
  }

  record(entry: AuditEntry): void {
    this.audit.record(entry);
  }

  /**
   * Mint a unique code for a URI, validity anchored to `startedAt`. Returns null
   * when the store is at capacity, no free code was found, or the anchor is
   * already past validity (all "try again").
   */
  mint(uri: string, startedAt: number): MintResult | null {
    this.purge();
    if (this.size >= this.maxEntries) return null;

    const createdAt = this.now(); // wall-clock mint time (audit column)
    const expiresAt = startedAt + this.ttlSeconds;
    if (expiresAt <= createdAt) return null;
    const retainUntil = startedAt + this.retainSeconds;

    for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS; attempt++) {
      const code = randomInt(0, CODE_SPACE).toString().padStart(8, '0');
      // INSERT OR IGNORE → changes 0 means the code already exists (collision).
      const result = this.insertStmt.run(code, uri, createdAt, expiresAt, retainUntil);
      if (Number(result.changes) === 1) return { code, expiresAt };
    }
    return null;
  }

  /**
   * Redeem a code. Valid → `ok`, and the code is consumed (single-use). Used or
   * past validity but within retention → `expired` (row kept until retention
   * lapses). Unknown or past retention → `not-found`.
   */
  redeem(code: string): RedeemResult {
    const row = this.selectStmt.get(code) as CodeRow | undefined;
    if (!row) return { ok: false, reason: 'not-found' };

    const now = this.now();
    if (now >= row.retain_until) {
      // Past retention but the sweep hasn't run yet - drop it and report gone.
      this.deleteStmt.run(code);
      return { ok: false, reason: 'not-found' };
    }
    if (Number(this.consumeStmt.run(now, code).changes) === 1) {
      return { ok: true, uri: row.uri };
    }
    return { ok: false, reason: 'expired' };
  }

  /** Wipe the invoice from lapsed rows and drop rows past retention. */
  private purge(): void {
    const now = this.now();
    this.scrubStmt.run(now);
    this.sweepStmt.run(now);
  }

  /**
   * Periodic hygiene: purge, then checkpoint so wiped invoices leave the `-wal`
   * log too. Kept off the mint path - one fsync per sweep tick, not per mint.
   */
  sweep(): void {
    this.purge();
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  /**
   * Purge, then close (call on shutdown). Lapsed invoices are wiped so a
   * decommissioned server's last file holds none; valid codes are untouched
   * and survive the restart. Closing the last connection checkpoints the WAL.
   */
  close(): void {
    this.purge();
    this.db.close();
  }

  /**
   * Wipe every invoice, then close. For a file leaving service on day rotation:
   * its codes become unreachable, and the archived file must not keep their URIs.
   */
  retire(): void {
    this.scrubStmt.run(Number.MAX_SAFE_INTEGER);
    this.db.close();
  }
}

/** UTC calendar day, e.g. `2026-06-29`. The rotation key. */
function utcDayKey(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${mm}-${dd}`;
}

/**
 * Nest the daily file under year/month folders, day key in the name:
 * `regby.db` → `2026/06/regby-2026-06-29.db`. Folders are relative to the base
 * path's directory (empty for a bare filename).
 */
export function dailyDbPath(basePath: string, epochSeconds: number): string {
  const { dir, name, ext } = parse(basePath);
  const d = new Date(epochSeconds * 1000);
  const year = String(d.getUTCFullYear());
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const file = `${name}-${utcDayKey(epochSeconds)}${ext}`;
  return join(dir, year, month, file);
}

/**
 * A `CodeStore` that writes to a fresh SQLite file each UTC day, nested under
 * `YYYY/MM/regby-<date>.db`, and switches at 00:00 UTC. Old files are KEPT on
 * disk, never purged - a daily
 * archive. The active store is the only one read or written.
 *
 * **Current-day-only**: a code lives solely in the file of the day it was minted.
 * A code minted just before midnight becomes unreachable once the day rolls over,
 * even though its retention window hasn't lapsed - a deliberate trade (chosen over
 * reading the previous day's file) for simple, self-contained daily files. The
 * switch is checked lazily on every op, and the broker's 60 s sweep timer calls
 * `sweep()`, so rotation happens within ~60 s of midnight even with no traffic.
 */
export class RotatingCodeStore implements CodeStoreLike {
  private current: CodeStore;
  private currentDay: string;

  constructor(
    private readonly ttlSeconds: number,
    private readonly retainSeconds: number,
    private readonly maxEntries: number,
    private readonly basePath: string,
    private readonly now: () => number = nowSeconds,
  ) {
    this.currentDay = utcDayKey(this.now());
    this.current = this.openCurrent();
  }

  private openCurrent(): CodeStore {
    return new CodeStore(
      this.ttlSeconds,
      this.retainSeconds,
      this.maxEntries,
      dailyDbPath(this.basePath, this.now()),
      this.now,
    );
  }

  /** Roll to today's file if the UTC day changed since the last op. */
  private rotateIfNeeded(): void {
    const day = utcDayKey(this.now());
    if (day === this.currentDay) return;
    this.current.retire();
    this.currentDay = day;
    this.current = this.openCurrent();
  }

  mint(uri: string, startedAt: number): MintResult | null {
    this.rotateIfNeeded();
    return this.current.mint(uri, startedAt);
  }

  redeem(code: string): RedeemResult {
    this.rotateIfNeeded();
    return this.current.redeem(code);
  }

  sweep(): void {
    this.rotateIfNeeded();
    this.current.sweep();
  }

  record(entry: AuditEntry): void {
    this.rotateIfNeeded();
    this.current.record(entry);
  }

  // No rotateIfNeeded() here: `size` is read only right after a mint/redeem that
  // already rotated this tick, and a property read shouldn't swap db files.
  get size(): number {
    return this.current.size;
  }

  close(): void {
    this.current.close();
  }
}
