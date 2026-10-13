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
  content: string | null;
  reason: string | null;
  delivered: boolean | null;
}

const toRecord = (r: StoredRow): AuditRecord => ({
  id: r.id,
  ts: Number(r.ts),
  event: r.event,
  pubkey: r.pubkey,
  requestEvent: r.request_event,
  code: r.code,
  content: r.content,
  reason: r.reason,
  delivered: r.delivered,
});

/**
 * Run `fn` in a fresh schema (every store it opens is closed after), then drop
 * the schema. `stored` reads the rows back, oldest first, as records.
 */
/** Raw SQL inside the test schema, for setting up and inspecting a table by hand. */
type Sql = <R extends pg.QueryResultRow>(text: string) => Promise<pg.QueryResult<R>>;

async function withSchema(
  fn: (open: Open, stored: () => Promise<AuditRecord[]>, sql: Sql) => Promise<void>,
): Promise<void> {
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
    }, async <R extends pg.QueryResultRow>(text: string) => {
      await admin.query(`SET search_path = ${schema}`);
      return admin.query<R>(text);
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
    const full = auditRecord({ id: randomUUID(), ts: c.now() - 2, content: 'any text ☕\nline two' });
    const sparse = auditRecord({
      id: randomUUID(),
      ts: c.now() - 1,
      event: 'blacklisted',
      code: '12345678',
      content: null,
      reason: 'guessing',
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

/** The events table's columns, in order. */
async function columnsOf(sql: Sql): Promise<string[]> {
  const { rows } = await sql<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'events' ORDER BY ordinal_position`,
  );
  return rows.map((r) => r.column_name);
}

const OLD_COLUMNS = ['uri', 'detail', 'valid_until', 'payload_hmac', 'payload_length'];

test('a table from before content became opaque is upgraded in place, rows kept', { skip }, async () => {
  const c = clock();
  await withSchema(async (open, stored, sql) => {
    const id = randomUUID();
    await sql(`
      CREATE TABLE events (
        id uuid PRIMARY KEY, ts bigint NOT NULL, event text NOT NULL, pubkey text NOT NULL,
        request_event text NOT NULL, code text, uri text, valid_until bigint, payload_hmac text,
        payload_length integer, detail text, delivered boolean, received_at bigint NOT NULL
      );
      INSERT INTO events VALUES ('${id}', ${c.now() - 2}, 'code_issued', '${'a'.repeat(64)}',
        '${'a'.repeat(64)}', '12345678', 'old invoice', 1, NULL, NULL, 'expired', true, ${c.now()});
    `);
    await open(365, 100, c.now);
    const store = await open(365, 100, c.now); // twice: the upgrade is idempotent
    const columns = await columnsOf(sql);
    assert.ok(columns.includes('content') && columns.includes('reason'));
    for (const gone of OLD_COLUMNS) assert.ok(!columns.includes(gone), gone);
    // The upgraded table takes today's inserts, and the comments landed on the new names.
    const fresh = auditRecord({ id: randomUUID(), ts: c.now() - 1, content: 'new', reason: null });
    assert.equal(await store.insert([fresh]), 1);
    assert.deepEqual(
      (await stored()).map((r) => [r.id, r.content, r.reason]),
      [[id, 'old invoice', 'expired'], [fresh.id, 'new', null]],
    );
    const { rows } = await sql<{ comment: string | null }>(
      "SELECT col_description('events'::regclass, attnum) AS comment FROM pg_attribute WHERE attrelid = 'events'::regclass AND attname = 'content'",
    );
    assert.match(rows[0]?.comment ?? '', /Full content/);
  });
});

test('a half-upgraded table (renamed, old columns still there) finishes the upgrade', { skip }, async () => {
  const c = clock();
  await withSchema(async (open, _stored, sql) => {
    await sql(`
      CREATE TABLE events (
        id uuid PRIMARY KEY, ts bigint NOT NULL, event text NOT NULL, pubkey text NOT NULL,
        request_event text NOT NULL, code text, content text, payload_hmac text,
        detail text, delivered boolean, received_at bigint NOT NULL
      );
    `);
    await open(365, 100, c.now);
    const columns = await columnsOf(sql);
    assert.ok(columns.includes('content') && columns.includes('reason'));
    for (const gone of OLD_COLUMNS) assert.ok(!columns.includes(gone), gone);
  });
});

test('a table with both an old and a new column name refuses to start', { skip }, async () => {
  const c = clock();
  await withSchema(async (open, _stored, sql) => {
    await sql(`
      CREATE TABLE events (
        id uuid PRIMARY KEY, ts bigint NOT NULL, event text NOT NULL, pubkey text NOT NULL,
        request_event text NOT NULL, code text, uri text, content text, reason text,
        delivered boolean, received_at bigint NOT NULL
      );
    `);
    await assert.rejects(open(365, 100, c.now), /both uri and content/);
  });
});
