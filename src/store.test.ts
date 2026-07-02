import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeStore, RotatingCodeStore, dailyDbPath } from './store.ts';

const TTL = 300; // 5-min validity
const RETAIN = 3600; // 1-h retention

function fixedClock(start = 1000): { now: () => number; tick: (s: number) => void } {
  let t = start;
  return { now: () => t, tick: (s) => (t += s) };
}

/** In-memory DB store with an injectable clock — isolated per test. */
function memStore(clock = fixedClock(), max = 100): CodeStore {
  return new CodeStore(TTL, RETAIN, max, ':memory:', clock.now);
}

test('mint then redeem returns the uri', () => {
  const store = memStore();
  const minted = store.mint('defipay://base/0xabc', 1000);
  assert.ok(minted);
  assert.match(minted.code, /^\d{8}$/);
  assert.deepEqual(store.redeem(minted.code), { ok: true, uri: 'defipay://base/0xabc' });
});

test('expiry is anchored to startedAt, not server now', () => {
  const clock = fixedClock();
  const store = memStore(clock);
  // Merchant event created 100s before the server received it.
  const minted = store.mint('defipay://base/0xabc', clock.now() - 100);
  assert.ok(minted);
  assert.equal(minted.expiresAt, clock.now() - 100 + TTL);
});

test('mint rejects an already-expired anchor', () => {
  const clock = fixedClock();
  const store = memStore(clock);
  assert.equal(store.mint('defipay://base/0xabc', clock.now() - TTL), null);
});

test('redeem is multi-use within validity', () => {
  const clock = fixedClock();
  const store = memStore(clock);
  const minted = store.mint('defipay://base/0xabc', clock.now());
  assert.ok(minted);
  for (let i = 0; i < 5; i++) {
    clock.tick(30);
    assert.deepEqual(store.redeem(minted.code), { ok: true, uri: 'defipay://base/0xabc' });
  }
  assert.equal(store.size, 1);
});

test('past validity but within retention reports expired and KEEPS the row', () => {
  const clock = fixedClock();
  const store = memStore(clock);
  const minted = store.mint('defipay://base/0xabc', clock.now());
  assert.ok(minted);
  clock.tick(TTL); // exactly at expiry
  // Reported expired repeatedly — the row survives for the whole retention window.
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(store.redeem(minted.code), { ok: false, reason: 'expired' });
  }
  assert.equal(store.size, 1);
});

test('past retention reports not-found and purges the row', () => {
  const clock = fixedClock();
  const store = memStore(clock);
  const minted = store.mint('defipay://base/0xabc', clock.now());
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
  assert.ok(store.mint('defipay://a', 1000));
  assert.equal(store.mint('defipay://b', 1000), null);
});

test('sweep frees capacity taken by rows past retention', () => {
  const clock = fixedClock();
  const store = memStore(clock, 1);
  assert.ok(store.mint('defipay://a', clock.now()));
  clock.tick(RETAIN);
  // mint() sweeps first, so the retained-then-expired entry is reclaimed.
  assert.ok(store.mint('defipay://b', clock.now()));
  assert.equal(store.size, 1);
});

test('mint records created_at = server now', () => {
  const path = join(tmpdir(), `regby-created-${process.pid}.db`);
  const now = 1_700_000_000;
  try {
    const store = new CodeStore(TTL, RETAIN, 100, path, () => now);
    const minted = store.mint('defipay://base/0xabc', now - 50); // anchor before now
    assert.ok(minted);
    store.close();
    const db = new DatabaseSync(path);
    const row = db.prepare('SELECT created_at FROM codes WHERE code = ?').get(minted.code) as {
      created_at: number;
    };
    assert.equal(row.created_at, now); // wall-clock mint, not the startedAt anchor
    db.close();
  } finally {
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
  }
});

test('dailyDbPath inserts the UTC day before the extension', () => {
  // 1_700_000_000 = 2023-11-14T22:13:20Z
  assert.equal(dailyDbPath('regby.db', 1_700_000_000), 'regby-2023-11-14.db');
  assert.equal(dailyDbPath('/data/regby.db', 1_700_000_000), '/data/regby-2023-11-14.db');
  assert.equal(dailyDbPath('regbydb', 1_700_000_000), 'regbydb-2023-11-14'); // no extension
});

test('RotatingCodeStore switches files at the UTC day boundary', () => {
  const clock = fixedClock(1_700_000_000);
  const base = join(tmpdir(), `regby-rot-${process.pid}.db`);
  const day1 = dailyDbPath(base, clock.now());
  try {
    const store = new RotatingCodeStore(TTL, RETAIN, 100, base, clock.now);
    const minted = store.mint('defipay://base/0xabc', clock.now());
    assert.ok(minted);
    assert.deepEqual(store.redeem(minted.code), { ok: true, uri: 'defipay://base/0xabc' });
    // Next UTC day → a fresh, empty file; yesterday's code is unreachable
    // (current-day-only, by design). The redeem is the op that triggers the
    // lazy rotation; `size` then reflects the new (empty) file.
    clock.tick(86_400);
    assert.notEqual(dailyDbPath(base, clock.now()), day1);
    assert.deepEqual(store.redeem(minted.code), { ok: false, reason: 'not-found' });
    assert.equal(store.size, 0);
    store.close();
  } finally {
    const day2 = dailyDbPath(base, clock.now());
    for (const p of [day1, day2]) {
      for (const suffix of ['', '-wal', '-shm']) rmSync(p + suffix, { force: true });
    }
  }
});

test('codes persist across a restart (reopen the same file)', () => {
  const path = join(tmpdir(), `regby-store-test-${process.pid}.db`);
  const now = 1_000_000;
  try {
    const first = new CodeStore(TTL, RETAIN, 100, path, () => now);
    const minted = first.mint('defipay://base/0xabc', now);
    assert.ok(minted);
    first.close();

    // Fresh instance over the same file — the prior code is still redeemable.
    const second = new CodeStore(TTL, RETAIN, 100, path, () => now);
    assert.deepEqual(second.redeem(minted.code), { ok: true, uri: 'defipay://base/0xabc' });
    second.close();
  } finally {
    for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
  }
});
