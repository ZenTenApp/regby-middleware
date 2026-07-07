/**
 * SQLite-backed code store. Maps an 8-digit code to the merchant's payment-request
 * URI, persisted so codes survive a server restart (the previous in-memory Map
 * lost every code on reboot — a restart used to make all codes unredeemable).
 *
 * Validity timestamps per row, both anchored to the merchant request's
 * `created_at` (skew-clamped by the caller):
 *   - `expires_at`   = startedAt + ttl     → code **validity** (5 min). Past this
 *     a redeem returns `expired`, but the row is KEPT.
 *   - `retain_until` = startedAt + retain  → row **retention** (1 h). A redeem
 *     between expiry and retention still reports `expired` (clear UX: "the code
 *     was real but lapsed"); only past retention is it `not-found`.
 * Plus `created_at` = the server wall-clock at mint, an audit column not used in
 * any validity decision.
 *
 * **Multi-use** while valid: redeem does NOT consume the row. `node:sqlite`'s
 * synchronous API matches this single-process, single-loop server — no async
 * driver, no extra dependency.
 *
 * `RotatingCodeStore` (below) wraps this with a new file per UTC day.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { randomInt } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { nowSeconds } from './time.ts';

export interface MintResult {
  code: string;
  /** Unix seconds the code stops being valid. */
  expiresAt: number;
}

export type RedeemResult =
  | { ok: true; uri: string }
  | { ok: false; reason: 'not-found' | 'expired' };

/** Shared surface of `CodeStore` and its rotating wrapper — the broker's seam. */
export interface CodeStoreLike {
  mint(uri: string, startedAt: number): MintResult | null;
  redeem(code: string): RedeemResult;
  sweep(): void;
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
  private readonly sweepStmt: StatementSync;
  private readonly countStmt: StatementSync;

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
    this.sweepStmt = this.db.prepare('DELETE FROM codes WHERE retain_until <= ?');
    this.countStmt = this.db.prepare('SELECT COUNT(*) AS n FROM codes');
  }

  get size(): number {
    return (this.countStmt.get() as { n: number }).n;
  }

  /**
   * Mint a unique code for a URI, validity anchored to `startedAt`. Returns null
   * when the store is at capacity, no free code was found, or the anchor is
   * already past validity (all "try again").
   */
  mint(uri: string, startedAt: number): MintResult | null {
    this.sweep();
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
   * Redeem a code. Valid → `ok` (multi-use, row kept). Past validity but within
   * retention → `expired` (row kept until retention lapses). Unknown or past
   * retention → `not-found`.
   */
  redeem(code: string): RedeemResult {
    const row = this.selectStmt.get(code) as CodeRow | undefined;
    if (!row) return { ok: false, reason: 'not-found' };

    const now = this.now();
    if (now >= row.retain_until) {
      // Past retention but the sweep hasn't run yet — drop it and report gone.
      this.deleteStmt.run(code);
      return { ok: false, reason: 'not-found' };
    }
    if (now >= row.expires_at) return { ok: false, reason: 'expired' };
    return { ok: true, uri: row.uri };
  }

  /** Drop rows past their retention window. Called on mint and a periodic timer. */
  sweep(): void {
    this.sweepStmt.run(this.now());
  }

  /** Close the database handle (call on shutdown). */
  close(): void {
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
 * disk, never purged — a daily
 * archive. The active store is the only one read or written.
 *
 * **Current-day-only**: a code lives solely in the file of the day it was minted.
 * A code minted just before midnight becomes unreachable once the day rolls over,
 * even though its retention window hasn't lapsed — a deliberate trade (chosen over
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
    this.current.close();
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

  // No rotateIfNeeded() here: `size` is read only right after a mint/redeem that
  // already rotated this tick, and a property read shouldn't swap db files.
  get size(): number {
    return this.current.size;
  }

  close(): void {
    this.current.close();
  }
}
