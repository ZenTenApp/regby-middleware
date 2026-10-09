/**
 * SQLite-backed code store. Maps an 8-digit code to the merchant's payment-request
 * URI, persisted so codes survive a server restart (the previous in-memory Map
 * lost every code on reboot - a restart used to make all codes unredeemable).
 *
 * Validity timestamps per row, both anchored to the merchant request's own
 * `created_at` (skew-clamped by the caller, passed in as `startedAt`):
 *   - `expires_at`   = startedAt + ttl     → code **validity** (1 min). Past it
 *     an unredeemed code reports `expired`, but the row is KEPT.
 *   - `retain_until` = startedAt + retain  → **answer window** (1 h). Until then
 *     a lapsed code still reports `expired` (clear UX: "the code was real but
 *     lapsed"); past it, `not-found`.
 *
 * Two more columns: `created_at` = the server wall-clock at mint, which never
 * decides validity but does decide when the number may be reused (below), and
 * `redeemed_at` = when the code was redeemed, NULL until then.
 *
 * **No reuse for 24 h**: a row is DELETED only `CODE_REUSE_SECONDS` (24 h) after
 * its `created_at`, so the primary key keeps that number out of every mint until
 * then. Past the answer window the row still exists but redeem reports
 * `not-found`, exactly as if it were gone. The 24 h is a constant, not config:
 * it is a guarantee to customers holding an old code, not a tuning knob.
 *
 * **Single-use**: the first successful redeem consumes the code - it stamps
 * `redeemed_at` and wipes `uri`. Any later redeem inside the answer window
 * reports `redeemed`, inside validity or past it: `redeemed_at` is what tells a
 * used code from a lapsed one, since both end with an empty `uri`. The sweep
 * also wipes the `uri` of every lapsed row and checkpoints the WAL, so the
 * plaintext invoice stays on disk at most one sweep interval past validity or
 * use: `secure_delete` zeroes the bytes in the main file, and the TRUNCATE
 * checkpoint drops the pre-wipe page images the `-wal` log would otherwise
 * keep. Only the code shell stays, for the 24 h reuse window. The consume is a compare-and-set on the row itself, so a
 * code is redeemed at most once even if the wall clock steps backward.
 * `node:sqlite`'s synchronous API matches this single-process, single-loop
 * server - no async driver, no extra dependency.
 *
 * `RotatingCodeStore` (below) wraps this with a new file per UTC day.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { nowSeconds } from './time.ts';
import { errorMessage, logger } from './logger.ts';

export interface MintResult {
  code: string;
  /** Unix seconds the code stops being valid. */
  expiresAt: number;
}

export type RedeemFailureReason = 'not-found' | 'expired' | 'redeemed';

export type RedeemResult = { ok: true; uri: string } | { ok: false; reason: RedeemFailureReason };

/** Shared surface of `CodeStore` and its rotating wrapper - the broker's seam. */
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
  redeemed_at: number | null;
}

/**
 * Daily files written before `redeemed_at` existed lack the column, and
 * `CREATE TABLE IF NOT EXISTS` never alters an existing table. Their rows read
 * as never redeemed: the old build marked a use only by pulling `expires_at` to
 * now, so a code consumed before the upgrade answers `expired`, not `redeemed`,
 * for the rest of its answer window.
 */
function addRedeemedAtColumn(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(codes)').all() as { name: string }[];
  if (columns.some((c) => c.name === 'redeemed_at')) return;
  db.exec('ALTER TABLE codes ADD COLUMN redeemed_at INTEGER');
}

/**
 * A code number is never issued again within this long of its last issue, so a
 * stale code in a customer's hands can never open someone else's invoice.
 */
export const CODE_REUSE_SECONDS = 86_400;

const CODE_SPACE = 100_000_000; // eight digits: 00000000–99999999
const MAX_MINT_ATTEMPTS = 20; // collision retries before giving up

export class CodeStore implements CodeStoreLike {
  private readonly db: DatabaseSync;
  private readonly insertStmt: StatementSync;
  private readonly selectStmt: StatementSync;
  private readonly consumeStmt: StatementSync;
  private readonly scrubStmt: StatementSync;
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
    // Wiped invoices are overwritten with zeros, not left readable in free pages.
    this.db.exec('PRAGMA secure_delete = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS codes (
        code         TEXT PRIMARY KEY,
        uri          TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL,
        retain_until INTEGER NOT NULL,
        redeemed_at  INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_codes_created ON codes(created_at);
      DROP INDEX IF EXISTS idx_codes_retain;
    `);
    addRedeemedAtColumn(this.db);
    // The scrub runs on every mint over a table holding a day of rows; only the
    // few still carrying an invoice are worth visiting.
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_codes_live ON codes(expires_at) WHERE uri != ''",
    );
    this.insertStmt = this.db.prepare(
      'INSERT OR IGNORE INTO codes (code, uri, created_at, expires_at, retain_until) VALUES (?, ?, ?, ?, ?)',
    );
    this.selectStmt = this.db.prepare(
      'SELECT uri, expires_at, retain_until, redeemed_at FROM codes WHERE code = ?',
    );
    // Guarded on the row, not on the caller's earlier read: only an unused,
    // unexpired row flips, so `changes` alone is the redeem verdict. `uri != ''`
    // also holds back a lapsed row the sweep already wiped, should the clock
    // step back below its `expires_at`.
    this.consumeStmt = this.db.prepare(
      "UPDATE codes SET uri = '', redeemed_at = ?1 WHERE code = ?2 AND redeemed_at IS NULL AND uri != '' AND expires_at > ?1",
    );
    this.scrubStmt = this.db.prepare(
      "UPDATE codes SET uri = '' WHERE expires_at <= ? AND uri != ''",
    );
    this.sweepStmt = this.db.prepare('DELETE FROM codes WHERE created_at <= ?');
    this.countStmt = this.db.prepare('SELECT COUNT(*) AS n FROM codes');
  }

  get size(): number {
    return (this.countStmt.get() as { n: number }).n;
  }

  /**
   * Mint a unique code for a URI, validity anchored to `startedAt`. Never a
   * number issued in the last 24 h: those rows still hold the primary key.
   * Returns null when the store is at capacity (codes issued in the last 24 h),
   * no free code was found, or the anchor is already past validity (all "try
   * again").
   */
  mint(uri: string, startedAt: number): MintResult | null {
    this.purge();
    if (this.size >= this.maxEntries) return null;

    const createdAt = this.now(); // wall-clock mint time, anchors the reuse window
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
   * Redeem a code. Valid → `ok`, and the code is consumed (single-use). Already
   * redeemed → `redeemed`, until retention lapses. Never redeemed and past
   * validity → `expired`, likewise. Unknown or past the answer window →
   * `not-found` (the row itself stays until the 24 h reuse window ends).
   */
  redeem(code: string): RedeemResult {
    const row = this.selectStmt.get(code) as CodeRow | undefined;
    if (!row) return { ok: false, reason: 'not-found' };

    const now = this.now();
    // Past the answer window: gone as far as the customer is concerned, though
    // the row stays to block reuse of the number.
    if (now >= row.retain_until) return { ok: false, reason: 'not-found' };
    if (row.redeemed_at !== null) return { ok: false, reason: 'redeemed' };
    if (Number(this.consumeStmt.run(now, code).changes) === 1) {
      return { ok: true, uri: row.uri };
    }
    // Never redeemed, and the guarded consume refused it: it has lapsed.
    return { ok: false, reason: 'expired' };
  }

  /** Wipe the invoice from lapsed rows; drop rows past the 24 h reuse window. */
  private purge(): void {
    const now = this.now();
    this.scrubStmt.run(now);
    this.sweepStmt.run(now - CODE_REUSE_SECONDS);
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
   * Copy the rows issued in the last 24 h from another day's file, as they
   * stand (invoice, expiry, redeemed state). Run when a new day's file opens,
   * so midnight neither frees those numbers for reuse nor cuts short a code
   * still inside its minute. The source keeps its invoices until the caller
   * wipes it: `retire` on rotation, `scrubArchives` on startup.
   * Idempotent: rows already here are left alone.
   */
  carryFrom(path: string): void {
    if (!existsSync(path)) return;
    this.db.prepare('ATTACH DATABASE ? AS prev').run(path);
    try {
      const columns = this.db.prepare('PRAGMA prev.table_info(codes)').all() as { name: string }[];
      if (columns.length === 0) return;
      // A file from before `redeemed_at` existed carries its codes as never redeemed.
      const redeemedAt = columns.some((c) => c.name === 'redeemed_at') ? 'redeemed_at' : 'NULL';
      this.db
        .prepare(
          `INSERT OR IGNORE INTO main.codes (code, uri, created_at, expires_at, retain_until, redeemed_at)
           SELECT code, uri, created_at, expires_at, retain_until, ${redeemedAt}
           FROM prev.codes WHERE created_at > ?`,
        )
        .run(this.now() - CODE_REUSE_SECONDS);
    } finally {
      this.db.exec('DETACH DATABASE prev');
    }
  }

  /**
   * Wipe every invoice, then close. For a file leaving service on day rotation:
   * its live codes were carried into the new day's file, and the archived file
   * must not keep their URIs.
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

// Prune the walk to the YYYY/MM layout; `dailyDbPath` stays the authority on
// which files inside it are ours.
const YEAR_RE = /^\d{4}$/;
const MONTH_RE = /^\d{2}$/;

/** Folder names under `dir`, or none if it doesn't exist yet. */
function subdirs(dir: string, pattern: RegExp): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && pattern.test(e.name))
    .map((e) => e.name);
}

/** Every daily file `dailyDbPath` can derive from `basePath`, any date. */
function dailyDbFiles(basePath: string): string[] {
  const { dir, name, ext } = parse(basePath);
  const root = dir || '.';
  const files: string[] = [];
  for (const year of subdirs(root, YEAR_RE)) {
    for (const month of subdirs(join(root, year), MONTH_RE)) {
      const monthDir = join(root, year, month);
      for (const file of readdirSync(monthDir)) {
        // Keep a file only if its date derives exactly this path back.
        const day = file.slice(name.length + 1, file.length - ext.length);
        const at = Date.parse(`${day}T00:00:00Z`) / 1000;
        const path = join(monthDir, file);
        if (Number.isFinite(at) && dailyDbPath(basePath, at) === path) files.push(path);
      }
    }
  }
  return files;
}

/**
 * Wipe every invoice left in an archived daily file. Rotation and the startup
 * carry clean the file they leave, but a server down across two or more
 * midnights never touched the older ones, and nothing else ever would.
 */
function scrubArchive(path: string): void {
  const db = new DatabaseSync(path);
  try {
    if (db.prepare('PRAGMA table_info(codes)').all().length === 0) return;
    db.exec('PRAGMA secure_delete = ON');
    db.exec("UPDATE codes SET uri = '' WHERE uri != ''");
  } finally {
    db.close();
  }
}

/**
 * A `CodeStore` that writes to a fresh SQLite file each UTC day, nested under
 * `YYYY/MM/regby-<date>.db`, and switches at 00:00 UTC. Old files are KEPT on
 * disk, never purged - a daily archive. The active store is the only one read
 * or written.
 *
 * **Midnight carries the last 24 h**: opening a day's file (on rotation, and on
 * startup) copies in the previous day's rows issued within the last 24 h. Without
 * it the new file starts empty, every number from before midnight is free to
 * mint again within minutes, and a code minted at 23:59:50 dies at midnight. The
 * 24 h window can never reach back past yesterday, so one file is enough. The
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
    const bootAt = this.now();
    this.currentDay = utcDayKey(bootAt);
    this.current = this.openCurrent();
    this.scrubArchives(dailyDbPath(this.basePath, bootAt));
  }

  /** Startup only: after the carry, no file but today's may hold an invoice. */
  private scrubArchives(today: string): void {
    for (const path of dailyDbFiles(this.basePath)) {
      if (path === today) continue;
      try {
        scrubArchive(path);
      } catch (err) {
        // An unreadable archive must not keep the server down; the wipe is
        // retried on the next start.
        logger.error('Archive scrub failed', {
          path,
          error: errorMessage(err),
        });
      }
    }
  }

  private openCurrent(): CodeStore {
    const now = this.now();
    const store = new CodeStore(
      this.ttlSeconds,
      this.retainSeconds,
      this.maxEntries,
      dailyDbPath(this.basePath, now),
      this.now,
    );
    try {
      store.carryFrom(dailyDbPath(this.basePath, now - CODE_REUSE_SECONDS));
    } catch (err) {
      store.close();
      throw err;
    }
    return store;
  }

  /** Roll to today's file if the UTC day changed since the last op. */
  private rotateIfNeeded(): void {
    const day = utcDayKey(this.now());
    if (day === this.currentDay) return;
    // Open (and carry into) the new file BEFORE retiring the old one: retire
    // wipes every invoice, and a code still inside its minute must cross over.
    let next: CodeStore;
    try {
      next = this.openCurrent();
    } catch (err) {
      // Stay on yesterday's file, which still holds every live code, and retry
      // on the next op. Opening today's without the carry would free the last
      // 24 h of numbers for reuse.
      logger.error('Day rotation failed - staying on the previous file', {
        error: errorMessage(err),
      });
      return;
    }
    this.current.retire();
    this.current = next;
    this.currentDay = day;
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
