import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CODE_REUSE_SECONDS, CodeStore, RotatingCodeStore, dailyDbPath } from './store.ts';

const TTL = 120; // 2-min validity
const RETAIN = 3600; // 1-h retention

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

/** Every row's uri keyed by code, read straight from the file (store closed). */
function urisOnDisk(path: string): Map<string, string> {
  const db = new DatabaseSync(path);
  const rows = db.prepare('SELECT code, uri FROM codes').all() as { code: string; uri: string }[];
  db.close();
  return new Map(rows.map((r) => [r.code, r.uri]));
}

/** In-memory DB store with an injectable clock - isolated per test. */
function memStore(clock = fixedClock(), max = 100): CodeStore {
  return new CodeStore(TTL, RETAIN, max, ':memory:', clock.now);
}

test('mint then redeem returns the uri', () => {
  const store = memStore();
  const minted = store.mint('defito://base/0xabc', 1000);
  assert.ok(minted);
  assert.match(minted.code, /^\d{8}$/);
  assert.deepEqual(store.redeem(minted.code), { ok: true, uri: 'defito://base/0xabc' });
});

test('expiry is anchored to startedAt, not server now', () => {
  const clock = fixedClock();
  const store = memStore(clock);
  // Merchant event created 100s before the server received it.
  const minted = store.mint('defito://base/0xabc', clock.now() - 100);
  assert.ok(minted);
  assert.equal(minted.expiresAt, clock.now() - 100 + TTL);
});

test('mint rejects an already-expired anchor', () => {
  const clock = fixedClock();
  const store = memStore(clock);
  assert.equal(store.mint('defito://base/0xabc', clock.now() - TTL), null);
});

test('redeem is single-use: a second redeem reports redeemed', () => {
  const clock = fixedClock();
  const store = memStore(clock);
  const minted = store.mint('defito://base/0xabc', clock.now());
  assert.ok(minted);
  clock.tick(30);
  assert.deepEqual(store.redeem(minted.code), { ok: true, uri: 'defito://base/0xabc' });
  assert.deepEqual(store.redeem(minted.code), { ok: false, reason: 'redeemed' });
  assert.equal(store.size, 1); // row kept for retention, so it reads redeemed, not a guess
});

test('a redeemed code reads redeemed for its whole retention, never expired', () => {
  const clock = fixedClock();
  const store = memStore(clock);
  const minted = store.mint('defito://base/0xabc', clock.now());
  assert.ok(minted);
  assert.ok(store.redeem(minted.code).ok);
  clock.tick(TTL - 1);
  assert.deepEqual(store.redeem(minted.code), { ok: false, reason: 'redeemed' });
  clock.tick(1); // at the validity boundary: used, not lapsed
  assert.deepEqual(store.redeem(minted.code), { ok: false, reason: 'redeemed' });
  store.sweep(); // a sweep must not turn a used code into a lapsed one
  clock.tick(RETAIN - TTL - 1);
  assert.deepEqual(store.redeem(minted.code), { ok: false, reason: 'redeemed' });
  clock.tick(1); // at the retention boundary: gone
  assert.deepEqual(store.redeem(minted.code), { ok: false, reason: 'not-found' });
});

test('a lapsed code stays expired when the clock steps back', () => {
  const clock = fixedClock();
  const store = memStore(clock);
  const minted = store.mint('defito://base/0xabc', clock.now());
  assert.ok(minted);
  clock.tick(TTL);
  store.sweep(); // the 60 s timer is what sees the time pass in production
  clock.tick(-10); // back inside the validity window
  assert.deepEqual(store.redeem(minted.code), { ok: false, reason: 'expired' });
});

test('a daily file from before redeemed_at gains the column and keeps its codes', () => {
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
    assert.deepEqual(store.redeem('12345678'), { ok: true, uri: 'defito://old' });
    assert.deepEqual(store.redeem('12345678'), { ok: false, reason: 'redeemed' });
    store.close();
  });
});

test('the live file keeps every invoice, used, lapsed or valid, for debugging', () => {
  withTempDb('keep', (path) => {
    const clock = fixedClock();
    const store = new CodeStore(TTL, RETAIN, 100, path, clock.now);
    const used = store.mint('defito://used', clock.now());
    const lapsed = store.mint('defito://lapsed', clock.now());
    const valid = store.mint('defito://valid', clock.now() + 1);
    assert.ok(used && lapsed && valid);
    assert.ok(store.redeem(used.code).ok);
    clock.tick(TTL); // `lapsed` hits expiry, `valid` has one second left
    store.sweep();
    store.close(); // and a shutdown keeps them for the restart
    const uris = urisOnDisk(path);
    assert.equal(uris.get(used.code), 'defito://used');
    assert.equal(uris.get(lapsed.code), 'defito://lapsed');
    assert.equal(uris.get(valid.code), 'defito://valid');
  });
});

test('a consumed code stays consumed when the wall clock steps backward', () => {
  const clock = fixedClock();
  const store = memStore(clock);
  const minted = store.mint('defito://base/0xabc', clock.now());
  assert.ok(minted);
  clock.tick(60);
  assert.ok(store.redeem(minted.code).ok);
  clock.tick(-30); // NTP correction / VM restore lands before the consume
  assert.deepEqual(store.redeem(minted.code), { ok: false, reason: 'redeemed' });
});

test('an invoice leaves the db and its -wal log with its row, 24 h after issue', () => {
  withTempDb('wal', (path) => {
    const clock = fixedClock();
    const store = new CodeStore(TTL, RETAIN, 100, path, clock.now);
    const sentinel = 'defito://wal-sentinel-0xfeed';
    const minted = store.mint(sentinel, clock.now());
    assert.ok(minted);
    assert.ok(store.redeem(minted.code).ok);
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
  const minted = store.mint('defito://base/0xabc', clock.now());
  assert.ok(minted);
  clock.tick(TTL); // exactly at expiry
  // Reported expired repeatedly - the row survives for the whole retention window.
  assert.deepEqual(store.redeem(minted.code), { ok: false, reason: 'expired' });
  assert.equal(store.size, 1);
});

test('past the answer window: not-found, but the row holds its number for 24 h', () => {
  const clock = fixedClock();
  const store = memStore(clock);
  const minted = store.mint('defito://base/0xabc', clock.now());
  assert.ok(minted);
  clock.tick(RETAIN); // at the answer-window boundary
  assert.deepEqual(store.redeem(minted.code), { ok: false, reason: 'not-found' });
  assert.equal(store.size, 1); // still reserved
  clock.tick(CODE_REUSE_SECONDS - RETAIN - 1);
  store.sweep();
  assert.equal(store.size, 1); // one second short of 24 h
  clock.tick(1);
  store.sweep();
  assert.equal(store.size, 0); // 24 h after issue: the number is free again
});

test('redeem of unknown code reports not-found', () => {
  assert.deepEqual(memStore().redeem('00000000'), { ok: false, reason: 'not-found' });
});

test('mint returns null when at capacity', () => {
  const store = memStore(fixedClock(), 1);
  assert.ok(store.mint('defito://a', 1000));
  assert.equal(store.mint('defito://b', 1000), null);
});

test('capacity counts every code issued in the last 24 h', () => {
  const clock = fixedClock();
  const store = memStore(clock, 1);
  assert.ok(store.mint('defito://a', clock.now()));
  clock.tick(RETAIN);
  assert.equal(store.mint('defito://b', clock.now()), null); // still reserved
  clock.tick(CODE_REUSE_SECONDS - RETAIN);
  // mint() purges first, so the 24-h-old reservation is reclaimed.
  assert.ok(store.mint('defito://b', clock.now()));
  assert.equal(store.size, 1);
});

test('mint records created_at = server now', () => {
  const now = 1_700_000_000;
  withTempDb('created', (path) => {
    const store = new CodeStore(TTL, RETAIN, 100, path, () => now);
    const minted = store.mint('defito://base/0xabc', now - 50); // anchor before now
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
    const minted = store.mint('defito://base/0xabc', clock.now());
    const unused = store.mint('defito://unused', clock.now());
    assert.ok(minted && unused);
    assert.deepEqual(store.redeem(minted.code), { ok: true, uri: 'defito://base/0xabc' });
    // Exactly 24 h later, on the next UTC day: the codes' reuse window has just
    // closed, so nothing is carried over and the new file starts empty. The
    // redeem is the op that triggers the lazy rotation.
    clock.tick(86_400);
    assert.notEqual(dailyDbPath(base, clock.now()), day1);
    assert.deepEqual(store.redeem(minted.code), { ok: false, reason: 'not-found' });
    assert.equal(store.size, 0);
    store.close();
    // No sweep ran before the roll; retire() alone left the archive with no invoice.
    assert.deepEqual([...urisOnDisk(day1).values()], ['', '']);
  } finally {
    rmDb(day1);
    rmDb(dailyDbPath(base, clock.now()));
  }
});

test('codes persist across a restart (reopen the same file)', () => {
  const now = 1_000_000;
  withTempDb('restart', (path) => {
    const first = new CodeStore(TTL, RETAIN, 100, path, () => now);
    const minted = first.mint('defito://base/0xabc', now);
    assert.ok(minted);
    first.close();

    // Fresh instance over the same file - the prior code is still redeemable.
    const second = new CodeStore(TTL, RETAIN, 100, path, () => now);
    assert.deepEqual(second.redeem(minted.code), { ok: true, uri: 'defito://base/0xabc' });
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
    const minted = store.mint('defito://base/0xabc', clock.now());
    assert.ok(minted);
    clock.tick(40); // 00:00:10 next day, still inside the code's minute
    assert.notEqual(dailyDbPath(base, clock.now()), day1);
    assert.deepEqual(store.redeem(minted.code), { ok: true, uri: 'defito://base/0xabc' });
    assert.deepEqual(store.redeem(minted.code), { ok: false, reason: 'redeemed' });
    store.close();
    // The archived file kept no invoice; the live copy crossed over.
    assert.deepEqual([...urisOnDisk(day1).values()], ['']);
  } finally {
    rmDb(day1);
    rmDb(dailyDbPath(base, clock.now()));
  }
});

test('a restart on a new day carries yesterday\'s reservations, then frees them at 24 h', () => {
  const clock = fixedClock(BEFORE_MIDNIGHT);
  const base = join(tmpdir(), `regby-carry-restart-${process.pid}.db`);
  const day1 = dailyDbPath(base, clock.now());
  try {
    const first = new RotatingCodeStore(TTL, RETAIN, 100, base, clock.now);
    const minted = first.mint('defito://base/0xabc', clock.now());
    assert.ok(minted);
    first.close();

    clock.tick(2 * 3600); // server comes back two hours later, on the next day
    const second = new RotatingCodeStore(TTL, RETAIN, 100, base, clock.now);
    assert.equal(second.size, 1); // the number is still reserved in today's file
    assert.deepEqual(second.redeem(minted.code), { ok: false, reason: 'not-found' });
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
    assert.equal(urisOnDisk(day1).get('12345678'), '');
    assert.deepEqual(store.redeem('12345678'), { ok: true, uri: 'defito://old' });
    assert.deepEqual(store.redeem('12345678'), { ok: false, reason: 'redeemed' });
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
      assert.ok(day.mint('defito://left', clock.now()));
      day.close();
      clock.tick(CODE_REUSE_SECONDS);
    }
    assert.deepEqual([...urisOnDisk(day1).values()], ['defito://left']);

    clock.tick(CODE_REUSE_SECONDS); // back three days after day1, past yesterday's carry
    const store = new RotatingCodeStore(TTL, RETAIN, 100, base, clock.now);
    store.close();
    assert.deepEqual([...urisOnDisk(day1).values()], ['']);
    assert.deepEqual([...urisOnDisk(day2).values()], ['']);
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
    const minted = store.mint('defito://today', clock.now());
    assert.ok(minted);
    clock.tick(-60); // NTP steps back to 23:59:10 yesterday
    // Still today's file: the code is live and its invoice intact.
    assert.deepEqual(store.redeem(minted.code), { ok: true, uri: 'defito://today' });
    store.close();
    assert.equal(urisOnDisk(day2).get(minted.code), 'defito://today');
  } finally {
    rmDb(day1);
    rmDb(dailyDbPath(base, BEFORE_MIDNIGHT + 40));
  }
});
