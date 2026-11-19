import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CODE_REUSE_SECONDS,
  CodeStore,
  RotatingCodeStore,
  dailyDbPath,
  type CodeOrigin,
  type RedeemResult,
} from './store.ts';

const TTL = 120; // 2-min validity
const RETAIN = 3600; // 1-h retention

/** The merchant behind every code these tests mint. */
const ORIGIN: CodeOrigin = { merchantPubkey: 'a'.repeat(64), requestEvent: 'b'.repeat(64) };

/** The customer who redeems first; the others arrive once the code is used. */
const CUSTOMER = 'e'.repeat(64);
const SECOND = 'f'.repeat(64);
const THIRD = '1'.repeat(64);
const FOURTH = '2'.repeat(64);

/** A winning redeem at `at`, its merchant notice stamped then. */
function served(content: string, at: number, origin: CodeOrigin = ORIGIN): RedeemResult {
  return { ok: true, content, origin, notice: { origin, at }, repeat: false };
}

/** The winner asking again inside the minute: served again, no second notice. */
function again(content: string, origin: CodeOrigin | null = ORIGIN): RedeemResult {
  return { ok: true, content, origin, notice: null, repeat: true };
}

/** A win on a row with no origin (a legacy file): served, nobody to notify. */
function servedLegacy(content: string): RedeemResult {
  return { ok: true, content, origin: null, notice: null, repeat: false };
}

/** Another customer refused as `redeemed`, counted for the first time, its notice stamped `at`. */
function refused(at: number): RedeemResult {
  return { ok: false, reason: 'redeemed', notice: { origin: ORIGIN, at } };
}

/** A customer refused as `redeemed` already counted (or on a code with no origin): no notice. */
const REFUSED_QUIET: RedeemResult = { ok: false, reason: 'redeemed', notice: null };

function fixedClock(start = 1000): { now: () => number; tick: (s: number) => void } {
  let t = start;
  return { now: () => t, tick: (s) => (t += s) };
}

/** Remove a SQLite file and its WAL sidecars. */
function rmDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
}

/** Run `fn` against a throwaway on-disk DB path, cleaned up afterwards. */
function withTempDb(name: string, fn: (path: string) => void): void {
  const path = join(tmpdir(), `regby-${name}-${process.pid}.db`);
  try {
    fn(path);
  } finally {
    rmDb(path);
  }
}

/** Every row's content keyed by code, read straight from the file (store closed). */
function contentOnDisk(path: string): Map<string, string> {
  const db = new DatabaseSync(path);
  const rows = db.prepare('SELECT code, content FROM codes').all() as { code: string; content: string }[];
  db.close();
  return new Map(rows.map((r) => [r.code, r.content]));
}

/** In-memory DB store with an injectable clock - isolated per test. */
function memStore(clock = fixedClock(), max = 100): CodeStore {
  return new CodeStore(TTL, RETAIN, max, ':memory:', clock.now);
}

test('mint then redeem returns the content', () => {
  const store = memStore();
  const minted = store.mint('defito://base/0xabc', 1000, ORIGIN);
  assert.ok(minted);
  assert.match(minted.code, /^\d{8}$/);
  assert.deepEqual(store.redeem(minted.code, CUSTOMER), served('defito://base/0xabc', 1000));
});

test('expiry is anchored to startedAt, not server now', () => {
  const clock = fixedClock();
  const store = memStore(clock);
  // Merchant event created 100s before the server received it.
  const minted = store.mint('defito://base/0xabc', clock.now() - 100, ORIGIN);
  assert.ok(minted);
  assert.equal(minted.expiresAt, clock.now() - 100 + TTL);
});

test('mint rejects an already-expired anchor', () => {
  const clock = fixedClock();
  const store = memStore(clock);
  assert.equal(store.mint('defito://base/0xabc', clock.now() - TTL, ORIGIN), null);
});

test('redeem is single-use: another customer reports redeemed, the winner is served again', () => {
  const clock = fixedClock();
  const store = memStore(clock);
  const minted = store.mint('defito://base/0xabc', clock.now(), ORIGIN);
  assert.ok(minted);
  clock.tick(30);
  assert.deepEqual(store.redeem(minted.code, CUSTOMER), served('defito://base/0xabc', clock.now()));
  assert.deepEqual(store.redeem(minted.code, SECOND), refused(clock.now() + 1));
  // The winner's retry (a lost reply, a reload) is not a second use.
  assert.deepEqual(store.redeem(minted.code, CUSTOMER), again('defito://base/0xabc'));
  assert.deepEqual(store.redeem(minted.code, SECOND), REFUSED_QUIET);
  assert.equal(store.size, 1); // row kept for retention, so it reads redeemed, not a guess
});

test('a redeemed code reads redeemed inside its minute, then by age like any other', () => {
  const clock = fixedClock();
  const store = memStore(clock);
  const minted = store.mint('defito://base/0xabc', clock.now(), ORIGIN);
  assert.ok(minted);
  assert.ok(store.redeem(minted.code, CUSTOMER).ok);
  clock.tick(TTL - 1);
  assert.deepEqual(store.redeem(minted.code, SECOND), refused(clock.now()));
  assert.deepEqual(store.redeem(minted.code, CUSTOMER), again('defito://base/0xabc'));
  clock.tick(1); // at the validity boundary: the later state wins, for the winner too
  assert.deepEqual(store.redeem(minted.code, CUSTOMER), { ok: false, reason: 'expired' });
  assert.deepEqual(store.redeem(minted.code, SECOND), { ok: false, reason: 'expired' });
  clock.tick(RETAIN - TTL); // at the answer-window boundary
  assert.deepEqual(store.redeem(minted.code, CUSTOMER), { ok: false, reason: 'locked' });
  clock.tick(CODE_REUSE_SECONDS - RETAIN); // at the reuse boundary, before any sweep
  assert.deepEqual(store.redeem(minted.code, CUSTOMER), { ok: false, reason: 'not-found' });
});

test('a lapsed code stays expired when the clock steps back', () => {
  const clock = fixedClock();
  const store = memStore(clock);
  const minted = store.mint('defito://base/0xabc', clock.now(), ORIGIN);
  assert.ok(minted);
  clock.tick(TTL);
  store.sweep(); // the 60 s timer is what sees the time pass in production
  clock.tick(-10); // back inside the validity window
  assert.deepEqual(store.redeem(minted.code, CUSTOMER), { ok: false, reason: 'expired' });
});

test('an old daily file (uri column, no late columns) is upgraded and keeps its codes, origin unknown', () => {
  withTempDb('migrate', (path) => {
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE codes (
        code TEXT PRIMARY KEY, uri TEXT NOT NULL, created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, retain_until INTEGER NOT NULL
      );
      INSERT INTO codes VALUES ('12345678', 'defito://old', 1000, ${1000 + TTL}, ${1000 + RETAIN});
    `);
    old.close();
    const clock = fixedClock();
    const store = new CodeStore(TTL, RETAIN, 100, path, clock.now);
    assert.deepEqual(store.redeem('12345678', CUSTOMER), servedLegacy('defito://old'));
    assert.deepEqual(store.redeem('12345678', CUSTOMER), again('defito://old', null));
    assert.deepEqual(store.redeem('12345678', SECOND), REFUSED_QUIET);
    store.close();
  });
});

test('the live file keeps every invoice, used, lapsed or valid, for debugging', () => {
  withTempDb('keep', (path) => {
    const clock = fixedClock();
    const store = new CodeStore(TTL, RETAIN, 100, path, clock.now);
    const used = store.mint('defito://used', clock.now(), ORIGIN);
    const lapsed = store.mint('defito://lapsed', clock.now(), ORIGIN);
    const valid = store.mint('defito://valid', clock.now() + 1, ORIGIN);
    assert.ok(used && lapsed && valid);
    assert.ok(store.redeem(used.code, CUSTOMER).ok);
    clock.tick(TTL); // `lapsed` hits expiry, `valid` has one second left
    store.sweep();
    store.close(); // and a shutdown keeps them for the restart
    const stored = contentOnDisk(path);
    assert.equal(stored.get(used.code), 'defito://used');
    assert.equal(stored.get(lapsed.code), 'defito://lapsed');
    assert.equal(stored.get(valid.code), 'defito://valid');
  });
});

test('a consumed code stays consumed when the wall clock steps backward', () => {
  const clock = fixedClock();
  const store = memStore(clock);
  const minted = store.mint('defito://base/0xabc', clock.now(), ORIGIN);
  assert.ok(minted);
  clock.tick(60);
  assert.ok(store.redeem(minted.code, CUSTOMER).ok);
  clock.tick(-30); // NTP correction / VM restore lands before the consume
  assert.deepEqual(store.redeem(minted.code, SECOND), refused(1061));
});

test('content leaves the db and its -wal log with its row, at the end of the reuse window', () => {
  withTempDb('wal', (path) => {
    const clock = fixedClock();
    const store = new CodeStore(TTL, RETAIN, 100, path, clock.now);
    const sentinel = 'defito://wal-sentinel-0xfeed';
    const minted = store.mint(sentinel, clock.now(), ORIGIN);
    assert.ok(minted);
    assert.ok(store.redeem(minted.code, CUSTOMER).ok);
    clock.tick(CODE_REUSE_SECONDS);
    store.sweep();
    // Store still open: the WAL is live, exactly where a pre-delete frame hid.
    for (const file of [path, `${path}-wal`]) {
      if (!existsSync(file)) continue; // a removed -wal is as clean as it gets
      const bytes = readFileSync(file).toString('latin1');
      assert.ok(!bytes.includes(sentinel), `${file} still holds the invoice`);
    }
    store.close();
  });
});

test('past validity but within retention reports expired and KEEPS the row', () => {
  const clock = fixedClock();
  const store = memStore(clock);
  const minted = store.mint('defito://base/0xabc', clock.now(), ORIGIN);
  assert.ok(minted);
  clock.tick(TTL); // exactly at expiry
  // Reported expired repeatedly - the row survives for the whole retention window.
  assert.deepEqual(store.redeem(minted.code, CUSTOMER), { ok: false, reason: 'expired' });
  assert.equal(store.size, 1);
});

test('past the answer window: locked while the row holds its number for the reuse window', () => {
  const clock = fixedClock();
  const store = memStore(clock);
  const minted = store.mint('defito://base/0xabc', clock.now(), ORIGIN);
  assert.ok(minted);
  clock.tick(RETAIN - 1);
  assert.deepEqual(store.redeem(minted.code, CUSTOMER), { ok: false, reason: 'expired' });
  clock.tick(1); // at the answer-window boundary
  assert.deepEqual(store.redeem(minted.code, CUSTOMER), { ok: false, reason: 'locked' });
  assert.equal(store.size, 1); // still reserved
  clock.tick(CODE_REUSE_SECONDS - RETAIN - 1);
  store.sweep();
  assert.equal(store.size, 1); // one second short of the reuse window
  assert.deepEqual(store.redeem(minted.code, CUSTOMER), { ok: false, reason: 'locked' });
  clock.tick(1);
  store.sweep();
  assert.equal(store.size, 0); // end of the reuse window: the number is free again
});

test('redeem of unknown code reports not-found', () => {
  assert.deepEqual(memStore().redeem('00000000', CUSTOMER), { ok: false, reason: 'not-found' });
});

test('mint returns null when at capacity', () => {
  const store = memStore(fixedClock(), 1);
  assert.ok(store.mint('defito://a', 1000, ORIGIN));
  assert.equal(store.mint('defito://b', 1000, ORIGIN), null);
});

test('capacity counts every code issued within the reuse window', () => {
  const clock = fixedClock();
  const store = memStore(clock, 1);
  assert.ok(store.mint('defito://a', clock.now(), ORIGIN));
  clock.tick(RETAIN);
  assert.equal(store.mint('defito://b', clock.now(), ORIGIN), null); // still reserved
  clock.tick(CODE_REUSE_SECONDS - RETAIN);
  // mint() purges first, so the expired reservation is reclaimed.
  assert.ok(store.mint('defito://b', clock.now(), ORIGIN));
  assert.equal(store.size, 1);
});

test('mint records created_at = server now', () => {
  const now = 1_700_000_000;
  withTempDb('created', (path) => {
    const store = new CodeStore(TTL, RETAIN, 100, path, () => now);
    const minted = store.mint('defito://base/0xabc', now - 50, ORIGIN); // anchor before now
    assert.ok(minted);
    store.close();
    const db = new DatabaseSync(path);
    const row = db.prepare('SELECT created_at FROM codes WHERE code = ?').get(minted.code) as {
      created_at: number;
    };
    assert.equal(row.created_at, now); // wall-clock mint, not the startedAt anchor
    db.close();
  });
});

test('dailyDbPath nests the file under YYYY/MM folders', () => {
  // 1_700_000_000 = 2023-11-14T22:13:20Z
  assert.equal(dailyDbPath('regby.db', 1_700_000_000), '2023/11/regby-2023-11-14.db');
  assert.equal(dailyDbPath('/data/regby.db', 1_700_000_000), '/data/2023/11/regby-2023-11-14.db');
  assert.equal(dailyDbPath('regbydb', 1_700_000_000), '2023/11/regbydb-2023-11-14'); // no extension
});

test('RotatingCodeStore switches files at the UTC day boundary', () => {
  const clock = fixedClock(1_700_000_000);
  const base = join(tmpdir(), `regby-rot-${process.pid}.db`);
  const day1 = dailyDbPath(base, clock.now());
  try {
    const store = new RotatingCodeStore(TTL, RETAIN, 100, base, clock.now);
    const minted = store.mint('defito://base/0xabc', clock.now(), ORIGIN);
    const unused = store.mint('defito://unused', clock.now(), ORIGIN);
    assert.ok(minted && unused);
    assert.deepEqual(store.redeem(minted.code, CUSTOMER), served('defito://base/0xabc', clock.now()));
    // 24 h later, on the next UTC day: past the answer window, but the 72 h
    // reuse window still holds both numbers, so both are carried over. The
    // redeem is the op that triggers the lazy rotation.
    clock.tick(86_400);
    const day2 = dailyDbPath(base, clock.now());
    assert.notEqual(day2, day1);
    assert.deepEqual(store.redeem(minted.code, CUSTOMER), { ok: false, reason: 'locked' });
    assert.equal(store.size, 2);
    // No sweep ran before the roll; retire() alone left the archive with no content.
    assert.deepEqual([...contentOnDisk(day1).values()], ['', '']);
    // 48 h after issue, another day on: still inside the window, carried again.
    clock.tick(86_400);
    assert.deepEqual(store.redeem(minted.code, CUSTOMER), { ok: false, reason: 'locked' });
    assert.equal(store.size, 2);
    // Exactly 72 h after issue, on the day after: the reuse window has closed,
    // so the roll (triggered by a redeem, no sweep) carries nothing.
    clock.tick(86_400);
    assert.deepEqual(store.redeem('00000000', CUSTOMER), { ok: false, reason: 'not-found' });
    assert.equal(store.size, 0);
    store.close();
  } finally {
    rmDb(day1);
    rmDb(dailyDbPath(base, 1_700_000_000 + 86_400));
    rmDb(dailyDbPath(base, 1_700_000_000 + 2 * 86_400));
    rmDb(dailyDbPath(base, clock.now()));
  }
});

test('codes persist across a restart (reopen the same file)', () => {
  const now = 1_000_000;
  withTempDb('restart', (path) => {
    const first = new CodeStore(TTL, RETAIN, 100, path, () => now);
    const minted = first.mint('defito://base/0xabc', now, ORIGIN);
    assert.ok(minted);
    first.close();

    // Fresh instance over the same file - the prior code is still redeemable.
    const second = new CodeStore(TTL, RETAIN, 100, path, () => now);
    assert.deepEqual(second.redeem(minted.code, CUSTOMER), served('defito://base/0xabc', now));
    second.close();
  });
});

// 2023-11-14T23:59:30Z: thirty seconds before a UTC day boundary.
const BEFORE_MIDNIGHT = 1_700_006_370;

test('a code minted just before midnight still redeems after it, once', () => {
  const clock = fixedClock(BEFORE_MIDNIGHT);
  const base = join(tmpdir(), `regby-carry-${process.pid}.db`);
  const day1 = dailyDbPath(base, clock.now());
  try {
    const store = new RotatingCodeStore(TTL, RETAIN, 100, base, clock.now);
    const minted = store.mint('defito://base/0xabc', clock.now(), ORIGIN);
    assert.ok(minted);
    clock.tick(40); // 00:00:10 next day, still inside the code's minute
    assert.notEqual(dailyDbPath(base, clock.now()), day1);
    assert.deepEqual(store.redeem(minted.code, CUSTOMER), served('defito://base/0xabc', clock.now()));
    assert.deepEqual(store.redeem(minted.code, SECOND), refused(clock.now() + 1));
    store.close();
    // The archived file kept no invoice; the live copy crossed over.
    assert.deepEqual([...contentOnDisk(day1).values()], ['']);
  } finally {
    rmDb(day1);
    rmDb(dailyDbPath(base, clock.now()));
  }
});

test('a restart on a new day carries yesterday\'s reservations, then frees them at the end of the window', () => {
  const clock = fixedClock(BEFORE_MIDNIGHT);
  const base = join(tmpdir(), `regby-carry-restart-${process.pid}.db`);
  const day1 = dailyDbPath(base, clock.now());
  try {
    const first = new RotatingCodeStore(TTL, RETAIN, 100, base, clock.now);
    const minted = first.mint('defito://base/0xabc', clock.now(), ORIGIN);
    assert.ok(minted);
    first.close();

    clock.tick(2 * 3600); // server comes back two hours later, on the next day
    const second = new RotatingCodeStore(TTL, RETAIN, 100, base, clock.now);
    assert.equal(second.size, 1); // the number is still reserved in today's file
    assert.deepEqual(second.redeem(minted.code, CUSTOMER), { ok: false, reason: 'locked' });
    clock.tick(CODE_REUSE_SECONDS - 2 * 3600);
    second.sweep();
    assert.equal(second.size, 0);
    second.close();
  } finally {
    rmDb(day1);
    rmDb(dailyDbPath(base, BEFORE_MIDNIGHT + 2 * 3600));
    rmDb(dailyDbPath(base, clock.now()));
  }
});

test('a startup carry from a pre-redeemed_at file keeps its codes and wipes the source', () => {
  const clock = fixedClock(BEFORE_MIDNIGHT);
  const base = join(tmpdir(), `regby-carry-legacy-${process.pid}.db`);
  const day1 = dailyDbPath(base, clock.now());
  try {
    // Yesterday's file, written by the old build and never retired (the server
    // was down across midnight), still holding a live invoice.
    mkdirSync(dirname(day1), { recursive: true });
    const old = new DatabaseSync(day1);
    const at = clock.now();
    old.exec(`
      CREATE TABLE codes (
        code TEXT PRIMARY KEY, uri TEXT NOT NULL, created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, retain_until INTEGER NOT NULL
      );
      INSERT INTO codes VALUES ('12345678', 'defito://old', ${at}, ${at + TTL}, ${at + RETAIN});
    `);
    old.close();

    clock.tick(40); // 00:00:10 next day, still inside the code's minute
    const store = new RotatingCodeStore(TTL, RETAIN, 100, base, clock.now);
    assert.equal(contentOnDisk(day1).get('12345678'), '');
    assert.deepEqual(store.redeem('12345678', CUSTOMER), servedLegacy('defito://old'));
    assert.deepEqual(store.redeem('12345678', SECOND), REFUSED_QUIET);
    store.close();
  } finally {
    rmDb(day1);
    rmDb(dailyDbPath(base, clock.now()));
  }
});

test('a startup after several midnights wipes every older archive, not only yesterday\'s', () => {
  const clock = fixedClock(BEFORE_MIDNIGHT);
  const base = join(tmpdir(), `regby-scrub-${process.pid}.db`);
  const day1 = dailyDbPath(base, clock.now());
  const day2 = dailyDbPath(base, clock.now() + CODE_REUSE_SECONDS);
  try {
    // Two days, each shut down holding a live invoice that no roll ever retired.
    for (const path of [day1, day2]) {
      const day = new CodeStore(TTL, RETAIN, 100, path, clock.now);
      assert.ok(day.mint('defito://left', clock.now(), ORIGIN));
      day.close();
      clock.tick(CODE_REUSE_SECONDS);
    }
    assert.deepEqual([...contentOnDisk(day1).values()], ['defito://left']);

    clock.tick(CODE_REUSE_SECONDS); // back three days after day1, past yesterday's carry
    const store = new RotatingCodeStore(TTL, RETAIN, 100, base, clock.now);
    store.close();
    assert.deepEqual([...contentOnDisk(day1).values()], ['']);
    assert.deepEqual([...contentOnDisk(day2).values()], ['']);
  } finally {
    rmDb(day1);
    rmDb(day2);
    rmDb(dailyDbPath(base, clock.now()));
  }
});

test('a clock stepping back across midnight stays on today\'s file and keeps its invoices', () => {
  const clock = fixedClock(BEFORE_MIDNIGHT);
  const base = join(tmpdir(), `regby-stepback-${process.pid}.db`);
  const day1 = dailyDbPath(base, clock.now());
  try {
    const store = new RotatingCodeStore(TTL, RETAIN, 100, base, clock.now);
    clock.tick(40); // 00:00:10 next day
    const day2 = dailyDbPath(base, clock.now());
    const minted = store.mint('defito://today', clock.now(), ORIGIN);
    assert.ok(minted);
    clock.tick(-60); // NTP steps back to 23:59:10 yesterday
    // Still today's file: the code is live and its invoice intact.
    assert.deepEqual(store.redeem(minted.code, CUSTOMER), served('defito://today', BEFORE_MIDNIGHT + 40));
    store.close();
    assert.equal(contentOnDisk(day2).get(minted.code), 'defito://today');
  } finally {
    rmDb(day1);
    rmDb(dailyDbPath(base, BEFORE_MIDNIGHT + 40));
  }
});

/** Every row's origin keyed by code, read straight from the file (store closed). */
function originsOnDisk(path: string): Map<string, [string | null, string | null]> {
  const db = new DatabaseSync(path);
  const rows = db.prepare('SELECT code, merchant_pubkey, request_event FROM codes').all() as {
    code: string;
    merchant_pubkey: string | null;
    request_event: string | null;
  }[];
  db.close();
  return new Map(rows.map((r) => [r.code, [r.merchant_pubkey, r.request_event]]));
}

test('a redeem returns who asked for the code, again on the winner\'s retry', () => {
  const clock = fixedClock();
  const store = memStore(clock);
  const other: CodeOrigin = { merchantPubkey: 'c'.repeat(64), requestEvent: 'd'.repeat(64) };
  const mine = store.mint('defito://mine', clock.now(), ORIGIN);
  const theirs = store.mint('defito://theirs', clock.now(), other);
  assert.ok(mine && theirs);
  assert.deepEqual(store.redeem(theirs.code, CUSTOMER), served('defito://theirs', clock.now(), other));
  assert.deepEqual(store.redeem(mine.code, CUSTOMER), served('defito://mine', clock.now()));
  assert.deepEqual(store.redeem(mine.code, CUSTOMER), again('defito://mine'));
  assert.deepEqual(store.redeem(theirs.code, CUSTOMER), again('defito://theirs', other));
});

test('rotation wipes each archived code\'s origin along with its invoice', () => {
  const clock = fixedClock(BEFORE_MIDNIGHT);
  const base = join(tmpdir(), `regby-origin-wipe-${process.pid}.db`);
  const day1 = dailyDbPath(base, clock.now());
  try {
    const store = new RotatingCodeStore(TTL, RETAIN, 100, base, clock.now);
    const minted = store.mint('defito://base/0xabc', clock.now(), ORIGIN);
    assert.ok(minted);
    clock.tick(40); // next UTC day, inside the code's minute
    // The live copy crossed over with its origin; the archive kept neither.
    assert.deepEqual(store.redeem(minted.code, CUSTOMER), served('defito://base/0xabc', clock.now()));
    store.close();
    assert.deepEqual(originsOnDisk(day1).get(minted.code), [null, null]);
  } finally {
    rmDb(day1);
    rmDb(dailyDbPath(base, clock.now()));
  }
});

test('a startup scrub wipes origins from an archive no roll retired', () => {
  const clock = fixedClock(BEFORE_MIDNIGHT);
  const base = join(tmpdir(), `regby-origin-scrub-${process.pid}.db`);
  const day1 = dailyDbPath(base, clock.now());
  try {
    const day = new CodeStore(TTL, RETAIN, 100, day1, clock.now);
    const minted = day.mint('defito://left', clock.now(), ORIGIN);
    assert.ok(minted);
    day.close();
    clock.tick(2 * CODE_REUSE_SECONDS); // back two days later: nothing to carry
    const store = new RotatingCodeStore(TTL, RETAIN, 100, base, clock.now);
    store.close();
    assert.deepEqual(originsOnDisk(day1).get(minted.code), [null, null]);
  } finally {
    rmDb(day1);
    rmDb(dailyDbPath(base, clock.now()));
  }
});

test('a code for empty content redeems once, like any other', () => {
  const clock = fixedClock();
  const store = memStore(clock);
  const minted = store.mint('', clock.now(), ORIGIN);
  assert.ok(minted);
  assert.deepEqual(store.redeem(minted.code, CUSTOMER), served('', clock.now()));
  assert.deepEqual(store.redeem(minted.code, SECOND), refused(clock.now() + 1));
  assert.deepEqual(store.redeem(minted.code, CUSTOMER), again(''));
});

test('a wiped row (no invoice, no origin) is never served, even inside its minute', () => {
  withTempDb('wiped', (path) => {
    const clock = fixedClock();
    const store = new CodeStore(TTL, RETAIN, 100, path, clock.now);
    const minted = store.mint('defito://base/0xabc', clock.now(), ORIGIN);
    assert.ok(minted);
    store.close();
    const db = new DatabaseSync(path);
    db.exec("UPDATE codes SET content = '', merchant_pubkey = NULL, request_event = NULL");
    db.close();
    const reopened = new CodeStore(TTL, RETAIN, 100, path, clock.now);
    assert.deepEqual(reopened.redeem(minted.code, CUSTOMER), { ok: false, reason: 'expired' });
    reopened.close();
  });
});

test('a carry from the last pre-rename schema (uri plus origin) keeps the origin and wipes the source', () => {
  const clock = fixedClock(BEFORE_MIDNIGHT);
  const base = join(tmpdir(), `regby-carry-uri-${process.pid}.db`);
  const day1 = dailyDbPath(base, clock.now());
  try {
    // Yesterday's file as the previous build wrote it: content still in `uri`,
    // origin and redeemed_at already there.
    mkdirSync(dirname(day1), { recursive: true });
    const old = new DatabaseSync(day1);
    const at = clock.now();
    old.exec(`
      CREATE TABLE codes (
        code TEXT PRIMARY KEY, uri TEXT NOT NULL, created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, retain_until INTEGER NOT NULL,
        redeemed_at INTEGER, merchant_pubkey TEXT, request_event TEXT
      );
      INSERT INTO codes VALUES ('12345678', 'defito://old', ${at}, ${at + TTL}, ${at + RETAIN},
        NULL, '${ORIGIN.merchantPubkey}', '${ORIGIN.requestEvent}');
    `);
    old.close();

    clock.tick(40); // 00:00:10 next day, still inside the code's minute
    const store = new RotatingCodeStore(TTL, RETAIN, 100, base, clock.now);
    assert.deepEqual(store.redeem('12345678', CUSTOMER), served('defito://old', clock.now()));
    store.close();
    // The startup scrub upgraded yesterday's file and wiped it.
    assert.equal(contentOnDisk(day1).get('12345678'), '');
    assert.deepEqual(originsOnDisk(day1).get('12345678'), [null, null]);
  } finally {
    rmDb(day1);
    rmDb(dailyDbPath(base, clock.now()));
  }
});

test('a daily file holding both uri and content refuses to open', () => {
  withTempDb('both-columns', (path) => {
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE codes (
        code TEXT PRIMARY KEY, uri TEXT NOT NULL, content TEXT, created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, retain_until INTEGER NOT NULL
      );
    `);
    db.close();
    assert.throws(() => new CodeStore(TTL, RETAIN, 100, path), /both uri and content/);
  });
});

test('after a day of downtime, a startup carries from the day before yesterday too', () => {
  const clock = fixedClock(BEFORE_MIDNIGHT);
  const base = join(tmpdir(), `regby-carry-gap-${process.pid}.db`);
  const day1 = dailyDbPath(base, clock.now());
  try {
    const first = new RotatingCodeStore(TTL, RETAIN, 100, base, clock.now);
    const minted = first.mint('defito://base/0xabc', clock.now(), ORIGIN);
    assert.ok(minted);
    first.close();
    // Down for all of the next UTC day: no file for it. Back on the day after,
    // still inside the 72 h window.
    clock.tick(86_400 + 3600);
    // Capacity 1: the carried reservation fills the store, so it is really held.
    const second = new RotatingCodeStore(TTL, RETAIN, 1, base, clock.now);
    assert.equal(second.size, 1);
    assert.equal(second.mint('defito://x', clock.now(), ORIGIN), null);
    second.close();
    assert.equal(contentOnDisk(dailyDbPath(base, clock.now())).get(minted.code), 'defito://base/0xabc');
  } finally {
    rmDb(day1);
    rmDb(dailyDbPath(base, clock.now()));
  }
});

test('a code redeemed in a later day file stays redeemed when an older copy is carried too', () => {
  const clock = fixedClock(BEFORE_MIDNIGHT);
  const base = join(tmpdir(), `regby-carry-order-${process.pid}.db`);
  const day1 = dailyDbPath(base, clock.now());
  const day2 = dailyDbPath(base, clock.now() + 86_400);
  try {
    const store = new RotatingCodeStore(TTL, RETAIN, 100, base, clock.now);
    const minted = store.mint('defito://base/0xabc', clock.now(), ORIGIN);
    assert.ok(minted);
    clock.tick(40); // next day: carried into day2
    assert.ok(store.redeem(minted.code, CUSTOMER).ok); // redeemed in day2 only
    store.close();
    // day1 was retired with a stale, unredeemed copy. Restart a day later: both
    // day1 and day2 are inside the window, and day2's redeemed state must win.
    clock.tick(86_400);
    new RotatingCodeStore(TTL, RETAIN, 100, base, clock.now).close();
    assert.deepEqual(redeemedOnDisk(dailyDbPath(base, clock.now()), minted.code), {
      at: BEFORE_MIDNIGHT + 40,
      by: CUSTOMER,
    });
  } finally {
    rmDb(day1);
    rmDb(day2);
    rmDb(dailyDbPath(base, clock.now()));
  }
});

/** When a row was redeemed and by whom, read straight from the file (store closed). */
function redeemedOnDisk(path: string, code: string): { at: number | null; by: string | null } {
  const db = new DatabaseSync(path);
  try {
    const row = db.prepare('SELECT redeemed_at, redeemed_by FROM codes WHERE code = ?').get(code) as
      | { redeemed_at: number | null; redeemed_by: string | null }
      | undefined;
    return { at: row?.redeemed_at ?? null, by: row?.redeemed_by ?? null };
  } finally {
    db.close();
  }
}

test('a redeem recorded in any carried copy wins, whatever order the copies land in', () => {
  withTempDb('carry-upsert', (path) => {
    const clock = fixedClock();
    // Today's file already holds a stale, unredeemed copy (a carry that ran
    // before a failed rotation); the source holds the same code, redeemed.
    const source = `${path}.src`;
    const at = clock.now();
    const src = new CodeStore(TTL, RETAIN, 100, source, clock.now);
    const minted = src.mint('defito://base/0xabc', at, ORIGIN);
    assert.ok(minted);
    const today = new CodeStore(TTL, RETAIN, 100, path, clock.now);
    today.carryFrom(source); // stale copy
    assert.ok(src.redeem(minted.code, CUSTOMER).ok);
    src.close();
    today.carryFrom(source); // same code again, now redeemed, its winner with it
    assert.deepEqual(today.redeem(minted.code, SECOND), refused(at + 1));
    assert.deepEqual(today.redeem(minted.code, CUSTOMER), again('defito://base/0xabc'));
    today.close();
    rmDb(source);
  });
});

/** Every counted customer as `code:pubkey`, lowest notice first, read straight from the file (store closed). */
function redeemersOnDisk(path: string): string[] {
  const db = new DatabaseSync(path);
  try {
    const rows = db.prepare('SELECT code, pubkey FROM redeemers ORDER BY notice_at').all() as {
      code: string;
      pubkey: string;
    }[];
    return rows.map((r) => `${r.code}:${r.pubkey}`);
  } finally {
    db.close();
  }
}

test('each distinct customer inside the minute gets one notice, the winner stamped first', () => {
  const clock = fixedClock();
  const store = memStore(clock);
  const minted = store.mint('defito://base/0xabc', clock.now(), ORIGIN);
  assert.ok(minted);
  clock.tick(5);
  assert.deepEqual(store.redeem(minted.code, CUSTOMER), served('defito://base/0xabc', 1005));
  // Same second: refused, but stamped a second after the winner so the two never tie.
  assert.deepEqual(store.redeem(minted.code, SECOND), refused(1006));
  assert.deepEqual(store.redeem(minted.code, THIRD), refused(1007));
  // Past the last stamp: stamped at its own time.
  clock.tick(20);
  assert.deepEqual(store.redeem(minted.code, FOURTH), refused(1025));
  // A refused customer already counted is refused again with no second notice;
  // the winner is served again, with none either.
  for (const pubkey of [SECOND, THIRD, FOURTH]) {
    assert.deepEqual(store.redeem(minted.code, pubkey), REFUSED_QUIET, pubkey);
  }
  assert.deepEqual(store.redeem(minted.code, CUSTOMER), again('defito://base/0xabc'));
});

test('notices are counted per code: another code\'s customers do not shift the stamps', () => {
  const clock = fixedClock();
  const store = memStore(clock);
  const first = store.mint('defito://first', clock.now(), ORIGIN);
  const second = store.mint('defito://second', clock.now(), ORIGIN);
  assert.ok(first && second);
  assert.deepEqual(store.redeem(first.code, CUSTOMER), served('defito://first', 1000));
  assert.deepEqual(store.redeem(first.code, SECOND), refused(1001));
  // The same two customers on the other code, in the other order, same second.
  assert.deepEqual(store.redeem(second.code, SECOND), served('defito://second', 1000));
  assert.deepEqual(store.redeem(second.code, CUSTOMER), refused(1001));
});

test('a customer past the minute, or on an unknown code, is neither served nor counted', () => {
  withTempDb('redeemers-late', (path) => {
    const clock = fixedClock();
    const store = new CodeStore(TTL, RETAIN, 100, path, clock.now);
    const minted = store.mint('defito://base/0xabc', clock.now(), ORIGIN);
    assert.ok(minted);
    assert.deepEqual(store.redeem('00000000', CUSTOMER), { ok: false, reason: 'not-found' });
    clock.tick(TTL);
    assert.deepEqual(store.redeem(minted.code, CUSTOMER), { ok: false, reason: 'expired' });
    clock.tick(RETAIN);
    assert.deepEqual(store.redeem(minted.code, SECOND), { ok: false, reason: 'locked' });
    store.close();
    assert.deepEqual(redeemersOnDisk(path), []);
  });
});

test('a legacy code with no origin is served but counts nobody, having no merchant to notify', () => {
  withTempDb('redeemers-legacy', (path) => {
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE codes (
        code TEXT PRIMARY KEY, uri TEXT NOT NULL, created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, retain_until INTEGER NOT NULL
      );
      INSERT INTO codes VALUES ('12345678', 'defito://old', 1000, ${1000 + TTL}, ${1000 + RETAIN});
    `);
    old.close();
    const store = new CodeStore(TTL, RETAIN, 100, path, fixedClock().now);
    assert.deepEqual(store.redeem('12345678', CUSTOMER), servedLegacy('defito://old'));
    assert.deepEqual(store.redeem('12345678', SECOND), REFUSED_QUIET);
    store.close();
    assert.deepEqual(redeemersOnDisk(path), []);
  });
});

test('redeemers leave with their code at the end of the reuse window, so a reissued number starts clean', () => {
  withTempDb('redeemers-purge', (path) => {
    const clock = fixedClock();
    const store = new CodeStore(TTL, RETAIN, 100, path, clock.now);
    const minted = store.mint('defito://base/0xabc', clock.now(), ORIGIN);
    assert.ok(minted);
    assert.ok(store.redeem(minted.code, CUSTOMER).ok);
    assert.deepEqual(store.redeem(minted.code, SECOND), refused(1001));
    clock.tick(CODE_REUSE_SECONDS - 1);
    store.sweep();
    store.close();
    assert.equal(redeemersOnDisk(path).length, 2); // one second short: still held
    const reopened = new CodeStore(TTL, RETAIN, 100, path, clock.now);
    clock.tick(1);
    reopened.sweep();
    reopened.close();
    assert.deepEqual(redeemersOnDisk(path), []);
  });
});

test('a customer counted before midnight is not counted again after it, and the archive keeps no pubkey', () => {
  const clock = fixedClock(BEFORE_MIDNIGHT);
  const base = join(tmpdir(), `regby-redeemers-carry-${process.pid}.db`);
  const day1 = dailyDbPath(base, clock.now());
  try {
    const store = new RotatingCodeStore(TTL, RETAIN, 100, base, clock.now);
    const minted = store.mint('defito://base/0xabc', clock.now(), ORIGIN);
    assert.ok(minted);
    clock.tick(5);
    assert.deepEqual(store.redeem(minted.code, CUSTOMER), served('defito://base/0xabc', BEFORE_MIDNIGHT + 5));
    assert.deepEqual(store.redeem(minted.code, SECOND), refused(BEFORE_MIDNIGHT + 6));
    clock.tick(35); // 00:00:10 next day, still inside the code's minute
    assert.notEqual(dailyDbPath(base, clock.now()), day1);
    assert.deepEqual(store.redeem(minted.code, CUSTOMER), again('defito://base/0xabc'));
    assert.deepEqual(store.redeem(minted.code, SECOND), REFUSED_QUIET);
    assert.deepEqual(store.redeem(minted.code, THIRD), refused(BEFORE_MIDNIGHT + 40));
    store.close();
    assert.deepEqual(redeemersOnDisk(day1), []);
    assert.deepEqual(redeemedOnDisk(day1, minted.code), { at: BEFORE_MIDNIGHT + 5, by: null });
  } finally {
    rmDb(day1);
    rmDb(dailyDbPath(base, clock.now()));
  }
});

test('a startup scrub wipes redeemers from an archive no roll retired', () => {
  const clock = fixedClock(BEFORE_MIDNIGHT);
  const base = join(tmpdir(), `regby-redeemers-scrub-${process.pid}.db`);
  const day1 = dailyDbPath(base, clock.now());
  try {
    const day = new CodeStore(TTL, RETAIN, 100, day1, clock.now);
    const minted = day.mint('defito://left', clock.now(), ORIGIN);
    assert.ok(minted);
    assert.ok(day.redeem(minted.code, CUSTOMER).ok);
    day.close();
    assert.deepEqual(redeemersOnDisk(day1), [`${minted.code}:${CUSTOMER}`]);
    assert.equal(redeemedOnDisk(day1, minted.code).by, CUSTOMER);
    clock.tick(2 * CODE_REUSE_SECONDS); // back two days later: nothing to carry
    new RotatingCodeStore(TTL, RETAIN, 100, base, clock.now).close();
    assert.deepEqual(redeemersOnDisk(day1), []);
    assert.equal(redeemedOnDisk(day1, minted.code).by, null);
  } finally {
    rmDb(day1);
    rmDb(dailyDbPath(base, clock.now()));
  }
});
