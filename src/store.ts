/**
 * SQLite-backed code store. Maps an 8-digit code to the merchant's content (a
 * payment-request URI, or empty) and who asked for it, persisted so codes
 * survive a server restart (the previous in-memory Map lost every code on
 * reboot - a restart used to make all codes unredeemable).
 *
 * Validity timestamps per row, both anchored to the merchant request's own
 * `created_at` (skew-clamped by the caller, passed in as `startedAt`):
 *   - `expires_at`   = startedAt + ttl     → code **validity** (1 min).
 *   - `retain_until` = startedAt + retain  → **answer window** (1 h).
 *
 * **One state at a time, by age**, each later one overriding the earlier, so
 * whether a code was ever redeemed matters only inside its minute:
 *   - inside validity: unused → served and consumed; used → `redeemed`.
 *   - past validity, inside the answer window → `expired`, used or not.
 *   - past the answer window, row still held → `locked`.
 *   - no row (never issued, or deleted after 72 h) → `not-found`.
 *
 * More columns: `created_at` = the server wall-clock at mint, which never
 * decides validity but does decide when the number may be reused (below),
 * `redeemed_at` = when the code was redeemed, NULL until then, and the code's
 * origin (`merchant_pubkey`, `request_event`): who asked for it and with which
 * event, so a redeem can name the merchant to the customer and notify the
 * merchant on their own request thread.
 *
 * **No reuse for 72 h**: a row is DELETED only `CODE_REUSE_SECONDS` (72 h) after
 * its `created_at`, so the primary key keeps that number out of every mint until
 * then, and redeem reports `locked` meanwhile. The 72 h is a constant, not
 * config: it is a guarantee to customers holding an old code, not a tuning knob.
 *
 * **Single-use**: the first successful redeem consumes the code - it stamps
 * `redeemed_at`. A later redeem inside validity reports `redeemed`; past it,
 * the age decides (above). The consume is a compare-and-set on the row
 * itself, so a code is redeemed at most once, and the store reads time through
 * `monotonic`, so a wall clock stepping backward can't revive a lapsed code
 * either (within one process).
 *
 * **Content stays for debugging**: a row keeps its content and origin until it is
 * deleted with the row, 72 h after issue, so the live file shows what every
 * recent code was for. Deleted rows are zeroed (`secure_delete`) and the sweep
 * checkpoints the WAL so their page images leave the `-wal` log too. Archived
 * daily files keep neither: rotation and startup wipe them (below).
 *
 * `node:sqlite`'s synchronous API matches this single-process, single-loop
 * server - no async driver, no extra dependency.
 *
 * `RotatingCodeStore` (below) wraps this with a new file per UTC day.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { monotonic, nowSeconds } from './time.ts';
import { errorMessage, logger } from './logger.ts';

export interface MintResult {
  code: string;
  /** Unix seconds the code stops being valid. */
  expiresAt: number;
}

/** Who asked for a code: the merchant, by signed pubkey, and their request event. */
export interface CodeOrigin {
  /** Hex pubkey that signed the `request_regby_code`, never the invoice's own claim. */
  merchantPubkey: string;
  requestEvent: string;
}

export type RedeemFailureReason = 'not-found' | 'locked' | 'expired' | 'redeemed';

/** `origin` is null only for a code minted before origins were stored. */
export type RedeemResult =
  | { ok: true; content: string; origin: CodeOrigin | null }
  | { ok: false; reason: RedeemFailureReason };

/** Shared surface of `CodeStore` and its rotating wrapper - the broker's seam. */
export interface CodeStoreLike {
  mint(content: string, startedAt: number, origin: CodeOrigin): MintResult | null;
  redeem(code: string): RedeemResult;
  sweep(): void;
  readonly size: number;
  close(): void;
}

interface CodeRow {
  /** The opaque content; the column predates content being more than a URI. */
  content: string;
  created_at: number;
  expires_at: number;
  retain_until: number;
  redeemed_at: number | null;
  merchant_pubkey: string | null;
  request_event: string | null;
}

/**
 * Nullable columns added after the table first shipped. `CREATE TABLE IF NOT
 * EXISTS` never alters an existing daily file, so each is added on open, and a
 * file copied from (`carryFrom`) may still lack them. Old rows read NULL:
 *   - `redeemed_at`: never redeemed. The old build marked a use only by pulling
 *     `expires_at` to now, so a code consumed before the upgrade answers
 *     `expired`, not `redeemed`, for the rest of its answer window.
 *   - origin: unknown, so its redeem names no merchant and notifies none.
 */
const LATE_COLUMNS = {
  redeemed_at: 'INTEGER',
  merchant_pubkey: 'TEXT',
  request_event: 'TEXT',
} as const;

function columnNames(db: DatabaseSync, schema: string): Set<string> {
  const rows = db.prepare(`PRAGMA ${schema}.table_info(codes)`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

/**
 * Bring an existing daily file to the current schema: `uri` (from when content
 * was always an invoice) becomes `content`, and any late column is added.
 * Idempotent, and a no-op on a file this build created.
 */
function upgradeSchema(db: DatabaseSync): void {
  const have = columnNames(db, 'main');
  if (have.has('uri')) {
    // Both names means a hand-edited file; every mint would then fail on the
    // NOT NULL `uri`. Refuse to open it instead of failing request by request.
    if (have.has('content')) throw new Error('codes has both uri and content columns; fix the file by hand');
    db.exec('ALTER TABLE codes RENAME COLUMN uri TO content');
  }
  for (const [name, type] of Object.entries(LATE_COLUMNS)) {
    if (!have.has(name)) db.exec(`ALTER TABLE codes ADD COLUMN ${name} ${type}`);
  }
}

const DAY_SECONDS = 86_400;

/**
 * A code number is never issued again within this long of its last issue, so a
 * stale code in a customer's hands can never open someone else's invoice.
 */
export const CODE_REUSE_SECONDS = 3 * DAY_SECONDS;

/** A row knows who asked for it: both origin columns are set (they are written together). */
const HAS_ORIGIN_SQL = 'merchant_pubkey IS NOT NULL AND request_event IS NOT NULL';

/** Empties every content and origin in a file leaving service (rotation, startup scrub). */
const WIPE_SQL = `UPDATE codes SET content = '', merchant_pubkey = NULL, request_event = NULL
  WHERE content != '' OR merchant_pubkey IS NOT NULL OR request_event IS NOT NULL`;

const CODE_SPACE = 100_000_000; // eight digits: 00000000–99999999
const MAX_MINT_ATTEMPTS = 20; // collision retries before giving up

export class CodeStore implements CodeStoreLike {
  private readonly db: DatabaseSync;
  private readonly insertStmt: StatementSync;
  private readonly selectStmt: StatementSync;
  private readonly consumeStmt: StatementSync;
  private readonly sweepStmt: StatementSync;
  private readonly countStmt: StatementSync;
  private readonly now: () => number;

  constructor(
    private readonly ttlSeconds: number,
    private readonly retainSeconds: number,
    private readonly maxEntries: number,
    dbPath: string,
    clock: () => number = nowSeconds,
  ) {
    this.now = monotonic(clock);
    // SQLite won't create missing parent dirs; the daily path nests YYYY/MM.
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    // WAL keeps reads/writes from blocking each other and survives a hard crash.
    this.db.exec('PRAGMA journal_mode = WAL');
    // Deleted rows (and archive wipes) are zeroed, not left readable in free pages.
    this.db.exec('PRAGMA secure_delete = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS codes (
        code         TEXT PRIMARY KEY,
        content      TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL,
        retain_until INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_codes_created ON codes(created_at);
      DROP INDEX IF EXISTS idx_codes_retain;
      -- Served the old per-mint invoice scrub.
      DROP INDEX IF EXISTS idx_codes_live;
    `);
    upgradeSchema(this.db);
    this.insertStmt = this.db.prepare(
      `INSERT OR IGNORE INTO codes (code, content, created_at, expires_at, retain_until, merchant_pubkey, request_event)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.selectStmt = this.db.prepare(
      'SELECT content, created_at, expires_at, retain_until, redeemed_at, merchant_pubkey, request_event FROM codes WHERE code = ?',
    );
    // Guarded on the row, not on the caller's earlier read: only an unused,
    // unexpired row flips, so `changes` alone is the redeem verdict. A row from
    // a wiped archive has neither content nor origin and is never served; a
    // live row with empty content still has its origin, so it redeems.
    this.consumeStmt = this.db.prepare(
      `UPDATE codes SET redeemed_at = ?1 WHERE code = ?2 AND redeemed_at IS NULL
         AND (content != '' OR ${HAS_ORIGIN_SQL}) AND expires_at > ?1`,
    );
    this.sweepStmt = this.db.prepare('DELETE FROM codes WHERE created_at <= ?');
    this.countStmt = this.db.prepare('SELECT COUNT(*) AS n FROM codes');
  }

  get size(): number {
    return (this.countStmt.get() as { n: number }).n;
  }

  /**
   * Mint a unique code for a URI, validity anchored to `startedAt`. Never a
   * number issued in the last 72 h: those rows still hold the primary key.
   * Returns null when the store is at capacity (codes issued in the last 72 h),
   * no free code was found, or the anchor is already past validity (all "try
   * again").
   */
  mint(content: string, startedAt: number, origin: CodeOrigin): MintResult | null {
    this.purge();
    if (this.size >= this.maxEntries) return null;

    const createdAt = this.now(); // wall-clock mint time, anchors the reuse window
    const expiresAt = startedAt + this.ttlSeconds;
    if (expiresAt <= createdAt) return null;
    const retainUntil = startedAt + this.retainSeconds;

    for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS; attempt++) {
      const code = randomInt(0, CODE_SPACE).toString().padStart(8, '0');
      // INSERT OR IGNORE → changes 0 means the code already exists (collision).
      const result = this.insertStmt.run(
        code,
        content,
        createdAt,
        expiresAt,
        retainUntil,
        origin.merchantPubkey,
        origin.requestEvent,
      );
      if (Number(result.changes) === 1) return { code, expiresAt };
    }
    return null;
  }

  /**
   * Redeem a code: the state its age puts it in (see the header). Valid and
   * unused → `ok`, and the code is consumed (single-use).
   */
  redeem(code: string): RedeemResult {
    const row = this.selectStmt.get(code) as CodeRow | undefined;
    const now = this.now();
    // A row past the reuse window is gone, even before the sweep deletes it.
    if (!row || now >= row.created_at + CODE_REUSE_SECONDS) return { ok: false, reason: 'not-found' };
    if (now >= row.retain_until) return { ok: false, reason: 'locked' };
    if (now >= row.expires_at) return { ok: false, reason: 'expired' };
    if (row.redeemed_at !== null) return { ok: false, reason: 'redeemed' };
    if (Number(this.consumeStmt.run(now, code).changes) === 1) {
      const origin =
        row.merchant_pubkey !== null && row.request_event !== null
          ? { merchantPubkey: row.merchant_pubkey, requestEvent: row.request_event }
          : null;
      return { ok: true, content: row.content, origin };
    }
    // Inside its minute, unused, yet the guarded consume refused it: a wiped
    // archive row, which has nothing left to serve.
    return { ok: false, reason: 'expired' };
  }

  /** Drop rows, content included, past the 72 h reuse window. */
  private purge(): void {
    this.sweepStmt.run(this.now() - CODE_REUSE_SECONDS);
  }

  /**
   * Periodic hygiene: purge, then checkpoint so deleted invoices leave the
   * `-wal` log too. Kept off the mint path - one fsync per sweep tick, not per
   * mint.
   */
  sweep(): void {
    this.purge();
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  /**
   * Purge, then close (call on shutdown). Codes and their invoices survive the
   * restart. Closing the last connection checkpoints the WAL.
   */
  close(): void {
    this.purge();
    this.db.close();
  }

  /**
   * Copy the rows issued within the reuse window from another day's file, as they
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
      const have = columnNames(this.db, 'prev');
      if (have.size === 0) return;
      // Read as the older file spells it: `uri` before the rename, and NULL
      // for a late column it lacks (see LATE_COLUMNS).
      const content = have.has('content') ? 'content' : 'uri';
      const late = Object.keys(LATE_COLUMNS);
      const select = late.map((c) => (have.has(c) ? c : 'NULL')).join(', ');
      // A code already here keeps its row, but a redeem recorded in ANY copy
      // wins: carries run one file at a time and a later one can follow a
      // failed rotation, so the result must not depend on which copy came first.
      this.db
        .prepare(
          `INSERT INTO main.codes (code, content, created_at, expires_at, retain_until, ${late.join(', ')})
           SELECT code, ${content}, created_at, expires_at, retain_until, ${select}
           FROM prev.codes WHERE created_at > ?
           ON CONFLICT(code) DO UPDATE SET redeemed_at = COALESCE(main.codes.redeemed_at, excluded.redeemed_at)`,
        )
        .run(this.now() - CODE_REUSE_SECONDS);
    } finally {
      this.db.exec('DETACH DATABASE prev');
    }
  }

  /**
   * Wipe every invoice and origin, then close. For a file leaving service on day
   * rotation: its live codes were carried into the new day's file, and the
   * archived file must not keep their URIs or who asked for them.
   */
  retire(): void {
    this.db.exec(WIPE_SQL);
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
 * Wipe every invoice and origin left in an archived daily file. Rotation and the startup
 * carry clean the file they leave, but a server down across two or more
 * midnights never touched the older ones, and nothing else ever would.
 */
function scrubArchive(path: string): void {
  const db = new DatabaseSync(path);
  try {
    if (columnNames(db, 'main').size === 0) return;
    db.exec('PRAGMA secure_delete = ON');
    // `WIPE_SQL` names the origin columns, so an archive from before they
    // existed gains them (idempotent: a no-op once added).
    upgradeSchema(db);
    db.exec(WIPE_SQL);
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
 * **Midnight carries the reuse window**: opening a day's file (on rotation, and
 * on startup) copies in the rows issued within `CODE_REUSE_SECONDS` from every
 * earlier day file that window reaches. Without it the new file starts empty,
 * every number from before midnight is free to mint again within minutes, and a
 * code minted at 23:59:50 dies at midnight. Yesterday's file already carries the
 * day before, but after downtime it may not exist, so every day file the window
 * reaches is read; a code redeemed in any of them stays redeemed. A file in the
 * window that cannot be read fails the open on purpose: skipping it would free
 * its numbers for reuse. The switch is checked lazily on every op, and the
 * broker's 60 s sweep timer calls `sweep()`, so rotation happens within ~60 s
 * of midnight even with no traffic.
 */
export class RotatingCodeStore implements CodeStoreLike {
  private current: CodeStore;
  private currentDay: string;
  // Monotonic: a clock stepping back across midnight must not roll into
  // yesterday's file, which was already wiped, and retire today's live one.
  private readonly now: () => number;

  constructor(
    private readonly ttlSeconds: number,
    private readonly retainSeconds: number,
    private readonly maxEntries: number,
    private readonly basePath: string,
    clock: () => number = nowSeconds,
  ) {
    this.now = monotonic(clock);
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
      // Every day the window can reach, rounding up for a window that is not a whole number of days.
      const carryDays = Math.ceil(CODE_REUSE_SECONDS / DAY_SECONDS);
      for (let daysBack = 1; daysBack <= carryDays; daysBack++) {
        store.carryFrom(dailyDbPath(this.basePath, now - daysBack * DAY_SECONDS));
      }
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
      // on the next op. Opening today's without the carry would free every
      // number still inside the reuse window.
      logger.error('Day rotation failed - staying on the previous file', {
        error: errorMessage(err),
      });
      return;
    }
    this.current.retire();
    this.current = next;
    this.currentDay = day;
  }

  mint(content: string, startedAt: number, origin: CodeOrigin): MintResult | null {
    this.rotateIfNeeded();
    return this.current.mint(content, startedAt, origin);
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
