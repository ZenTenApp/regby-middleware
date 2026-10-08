import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, rmSync } from 'node:fs';
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

test('a consumed code stays consumed when the wall clock steps backward', () => {
  const clock = fixedClock();
  const store = memStore(clock);
  const minted = store.mint('defito://base/0xabc', clock.now());
  assert.ok(minted);
  clock.tick(60);
  assert.ok(store.redeem(minted.code).ok);
  clock.tick(-30); // NTP correction / VM restore lands before the consume
  assert.deepEqual(store.redeem(minted.code), { ok: false, reason: 'expired' });
});

test('sweep leaves no consumed invoice in the db or its -wal log', () => {
  withTempDb('wal', (path) => {
    const clock = fixedClock();
    const store = new CodeStore(TTL, RETAIN, 100, path, clock.now);
    const sentinel = 'defito://wal-sentinel-0xfeed';
    const minted = store.mint(sentinel, clock.now());
    assert.ok(minted);
    assert.ok(store.redeem(minted.code).ok);
    store.sweep();
    // Store still open: the WAL is live, exactly where a pre-wipe frame hid.
    for (const file of [path, `${path}-wal`]) {
      if (!existsSync(file)) continue; // a removed -wal is as clean as it gets
      const bytes = readFileSync(file).toString('latin1');
      assert.ok(!bytes.includes(sentinel), `${file} still holds the invoice`);
    }
    store.close();
  });
});

test('close wipes lapsed invoices but keeps valid ones for the restart', () => {
  withTempDb('close', (path) => {
    const clock = fixedClock();
    const store = new CodeStore(TTL, RETAIN, 100, path, clock.now);
    const lapsed = store.mint('defito://lapsed', clock.now());
    const valid = store.mint('defito://valid', clock.now() + TTL / 2);
    assert.ok(lapsed && valid);
    clock.tick(TTL); // `lapsed` is at expiry, `valid` has half its window left
    store.close();
    const uris = urisOnDisk(path);
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

/** Every audit row, oldest first, read straight from the file (store closed). */
function eventsOnDisk(path: string): Record<string, unknown>[] {
  const db = new DatabaseSync(path);
  const rows = db
    .prepare('SELECT ts, event, pubkey, request_event, code, uri, valid_until, detail FROM events ORDER BY id')
    .all() as Record<string, unknown>[];
  db.close();
  return rows.map((r) => ({ ...r })); // sqlite rows are null-prototype objects
}

const MERCHANT = 'a'.repeat(64);
const CUSTOMER = 'b'.repeat(64);

test('audit rows keep the full invoice for good, past use, sweep and close', () => {
  withTempDb('audit', (path) => {
    const clock = fixedClock();
    const store = new CodeStore(TTL, RETAIN, 100, path, clock.now);
    const uri = 'defito://base/0xabc&amount=USDT:1&order_id=o1&valid_until=1795219200&nostr=npub1x';
    const minted = store.mint(uri, clock.now());
    assert.ok(minted);
    store.record({ event: 'mint', pubkey: MERCHANT, requestEvent: 'req1', code: minted.code, uri });
    clock.tick(30);
    const redeemed = store.redeem(minted.code);
    assert.ok(redeemed.ok);
    store.record({ event: 'redeem', pubkey: CUSTOMER, requestEvent: 'req2', code: minted.code, uri: redeemed.uri });
    store.record({ event: 'redeem_expired', pubkey: CUSTOMER, requestEvent: 'req3', code: minted.code });
    // Past retention: the code row is purged, the history is not.
    clock.tick(RETAIN);
    store.sweep();
    assert.equal(store.size, 0);
    store.close();

    assert.deepEqual(eventsOnDisk(path), [
      { ts: 1000, event: 'mint', pubkey: MERCHANT, request_event: 'req1', code: minted.code, uri, valid_until: 1795219200, detail: null },
      { ts: 1030, event: 'redeem', pubkey: CUSTOMER, request_event: 'req2', code: minted.code, uri, valid_until: 1795219200, detail: null },
      { ts: 1030, event: 'redeem_expired', pubkey: CUSTOMER, request_event: 'req3', code: minted.code, uri: null, valid_until: null, detail: null },
    ]);
  });
});

test('audit rows land in the file of the day they happen and survive rotation', () => {
  const clock = fixedClock(1_700_000_000);
  const base = join(tmpdir(), `regby-audit-rot-${process.pid}.db`);
  const day1 = dailyDbPath(base, clock.now());
  try {
    const store = new RotatingCodeStore(TTL, RETAIN, 100, base, clock.now);
    const uri = 'defito://base/0xabc&amount=USDT:1&order_id=o1&valid_until=1795219200&nostr=npub1x';
    store.record({ event: 'mint', pubkey: MERCHANT, requestEvent: 'req1', code: '12345678', uri });
    clock.tick(86_400);
    store.record({ event: 'redeem_not_found', pubkey: CUSTOMER, requestEvent: 'req2', code: '12345678' });
    store.close();
    // retire() wiped the codes table on the roll; the archived history kept its invoice.
    assert.deepEqual(eventsOnDisk(day1).map((r) => [r.event, r.uri]), [['mint', uri]]);
    assert.deepEqual(eventsOnDisk(dailyDbPath(base, clock.now())).map((r) => r.event), ['redeem_not_found']);
  } finally {
    rmDb(day1);
    rmDb(dailyDbPath(base, clock.now()));
  }
});
