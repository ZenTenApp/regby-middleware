import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeStore, RotatingCodeStore, dailyDbPath } from './store.ts';

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

test('redeem is single-use: a second redeem within validity reports expired', () => {
  const clock = fixedClock();
  const store = memStore(clock);
  const minted = store.mint('defito://base/0xabc', clock.now());
  assert.ok(minted);
  clock.tick(30);
  assert.deepEqual(store.redeem(minted.code), { ok: true, uri: 'defito://base/0xabc' });
  assert.deepEqual(store.redeem(minted.code), { ok: false, reason: 'expired' });
  assert.equal(store.size, 1); // shell kept for retention, so it reads expired, not a guess
});

test('sweep wipes the uri of consumed and lapsed rows, not of valid ones', () => {
  withTempDb('scrub', (path) => {
    const clock = fixedClock();
    const store = new CodeStore(TTL, RETAIN, 100, path, clock.now);
    const used = store.mint('defito://used', clock.now());
    const lapsed = store.mint('defito://lapsed', clock.now());
    const valid = store.mint('defito://valid', clock.now() + 1);
    assert.ok(used && lapsed && valid);
    assert.ok(store.redeem(used.code).ok);
    clock.tick(TTL); // `lapsed` hits expiry, `valid` has one second left
    store.sweep();
    store.close();
    const uris = urisOnDisk(path);
    assert.equal(uris.get(used.code), '');
    assert.equal(uris.get(lapsed.code), '');
    assert.equal(uris.get(valid.code), 'defito://valid');
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

test('past retention reports not-found and purges the row', () => {
  const clock = fixedClock();
  const store = memStore(clock);
  const minted = store.mint('defito://base/0xabc', clock.now());
  assert.ok(minted);
  clock.tick(RETAIN); // at retention boundary
  assert.deepEqual(store.redeem(minted.code), { ok: false, reason: 'not-found' });
  assert.equal(store.size, 0);
});

test('redeem of unknown code reports not-found', () => {
  assert.deepEqual(memStore().redeem('00000000'), { ok: false, reason: 'not-found' });
});

test('mint returns null when at capacity', () => {
  const store = memStore(fixedClock(), 1);
  assert.ok(store.mint('defito://a', 1000));
  assert.equal(store.mint('defito://b', 1000), null);
});

test('sweep frees capacity taken by rows past retention', () => {
  const clock = fixedClock();
  const store = memStore(clock, 1);
  assert.ok(store.mint('defito://a', clock.now()));
  clock.tick(RETAIN);
  // mint() sweeps first, so the retained-then-expired entry is reclaimed.
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
    // Next UTC day → a fresh, empty file; yesterday's code is unreachable
    // (current-day-only, by design). The redeem is the op that triggers the
    // lazy rotation; `size` then reflects the new (empty) file.
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
