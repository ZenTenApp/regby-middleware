/**
 * Runs against a real Postgres: set REGBY_AUDIT_TEST_DATABASE_URL and
 * REGBY_AUDIT_TEST_DATABASE_CA (a CA PEM path). Each test gets its own
 * throwaway schema, dropped afterwards. Skipped when the URL is unset.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { AuditStore, poolConfig } from './store.ts';
import type { AuditRecord } from '../audit.ts';
import { auditRecord } from '../audit.fixture.ts';

const DAY = 86_400;
const url = process.env.REGBY_AUDIT_TEST_DATABASE_URL;
const caPath = process.env.REGBY_AUDIT_TEST_DATABASE_CA;
const skip = url && caPath ? false : 'REGBY_AUDIT_TEST_DATABASE_URL / _CA not set';

function clock(start = 100 * DAY): { now: () => number; tick: (s: number) => void } {
  let t = start;
  return { now: () => t, tick: (s) => (t += s) };
}

type Open = (retainDays: number, maxRows: number, now?: () => number) => Promise<AuditStore>;

/** A row as pg returns it: bigint columns arrive as strings. */
interface StoredRow {
  id: string;
  ts: string;
  event: AuditRecord['event'];
  pubkey: string;
  request_event: string;
  code: string | null;
  uri: string | null;
  valid_until: string | null;
  payload_hmac: string | null;
  payload_length: number | null;
  detail: string | null;
  delivered: boolean | null;
}

const toRecord = (r: StoredRow): AuditRecord => ({
  id: r.id,
  ts: Number(r.ts),
  event: r.event,
  pubkey: r.pubkey,
  requestEvent: r.request_event,
  code: r.code,
  uri: r.uri,
  validUntil: r.valid_until === null ? null : Number(r.valid_until),
  payloadHmac: r.payload_hmac,
  payloadLength: r.payload_length,
  detail: r.detail,
  delivered: r.delivered,
});

/**
 * Run `fn` in a fresh schema (every store it opens is closed after), then drop
 * the schema. `stored` reads the rows back, oldest first, as records.
 */
async function withSchema(fn: (open: Open, stored: () => Promise<AuditRecord[]>) => Promise<void>): Promise<void> {
  const base = poolConfig(url ?? '', readFileSync(caPath ?? '', 'utf8'));
  const schema = `regby_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client(base);
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const opened: AuditStore[] = [];
  try {
    await fn(async (retainDays, maxRows, now) => {
      const store = await AuditStore.open({ ...base, options: `-c search_path=${schema}` }, retainDays, maxRows, now);
      opened.push(store);
      return store;
    }, async () => {
      const { rows } = await admin.query<StoredRow>(`SELECT * FROM ${schema}.events ORDER BY ts, id`);
      return rows.map(toRecord);
    });
  } finally {
    await Promise.all(opened.map((store) => store.close()));
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

test('a retried batch is stored once', { skip }, async () => {
  await withSchema(async (open) => {
    const store = await open(365, 100);
    const batch = [auditRecord({ id: randomUUID() }), auditRecord({ id: randomUUID() })];
    assert.equal(await store.insert(batch), 2);
    assert.equal(await store.insert(batch), 0);
    assert.equal(store.size, 2);
  });
});

test('every field round-trips, nulls included', { skip }, async () => {
  const c = clock();
  await withSchema(async (open, stored) => {
    const store = await open(365, 100, c.now);
    const full = auditRecord({ id: randomUUID(), ts: c.now() - 2, validUntil: c.now() + 600 });
    const sparse = auditRecord({
      id: randomUUID(),
      ts: c.now() - 1,
      event: 'invalid_request',
      code: null,
      uri: null,
      validUntil: null,
      payloadHmac: 'b'.repeat(64),
      payloadLength: 42,
      detail: 'malformed',
      delivered: null,
    });
    assert.equal(await store.insert([full, sparse]), 2);
    assert.deepEqual(await stored(), [full, sparse]);
  });
});

test('records past retention are pruned; newer ones stay', { skip }, async () => {
  const c = clock();
  await withSchema(async (open) => {
    const store = await open(30, 100, c.now);
    await store.insert([
      auditRecord({ id: randomUUID(), ts: c.now() - 31 * DAY }),
      auditRecord({ id: randomUUID(), ts: c.now() - 29 * DAY }),
    ]);
    await store.prune();
    assert.equal(store.size, 1);
    c.tick(2 * DAY);
    await store.prune();
    assert.equal(store.size, 0);
  });
});

test('the row cap holds on every insert, dropping the oldest first', { skip }, async () => {
  const c = clock();
  await withSchema(async (open, stored) => {
    const store = await open(365, 3, c.now);
    await store.insert([1, 2, 3, 4, 5].map((n) => auditRecord({ id: randomUUID(), ts: c.now() - 10 + n, code: `0000000${n}` })));
    assert.equal(store.size, 3);
    assert.deepEqual((await stored()).map((r) => r.code), ['00000003', '00000004', '00000005']);
  });
});

test('reopening counts the rows already stored and applies the cap', { skip }, async () => {
  const c = clock();
  await withSchema(async (open) => {
    const first = await open(365, 100, c.now);
    await first.insert([1, 2, 3].map((n) => auditRecord({ id: randomUUID(), ts: c.now() - n })));
    assert.equal((await open(365, 100, c.now)).size, 3);
    assert.equal((await open(365, 2, c.now)).size, 2);
  });
});
