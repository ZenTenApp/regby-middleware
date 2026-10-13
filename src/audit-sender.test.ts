import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpAuditSink, type AuditEntry } from './audit-sender.ts';
import { parseAuditBatch, type AuditRecord } from './audit.ts';

const URL_ = new URL('https://audit.example/events');
const TOKEN = 't'.repeat(32);
const HEX = 'b'.repeat(64);
const INVOICE =
  'defito://base/0xabc&amount=USDT:1&order_id=o1&valid_until=1795219200&nostr=npub1x';

interface Sent {
  auth: string | null;
  records: AuditRecord[];
}

/** A fetch that answers each call with the next status, recording what was sent. */
function fakeFetch(statuses: (number | 'down')[]): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fn = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const status = statuses.shift() ?? 204;
    if (status === 'down') throw new Error('ECONNREFUSED');
    const records = parseAuditBatch(JSON.parse(String(init?.body)));
    assert.ok(records, 'sender must only ever send on-contract batches');
    sent.push({ auth: new Headers(init?.headers).get('authorization'), records });
    return new Response(null, { status });
  };
  return { fetch: fn as typeof fetch, sent };
}

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return { event: 'code_issued', pubkey: HEX, requestEvent: HEX, code: '12345678', ...overrides };
}

function sink(f: typeof fetch, queueMax = 100): HttpAuditSink {
  return new HttpAuditSink({ url: URL_, token: TOKEN, queueMax, fetch: f, now: () => 1000 });
}

test('records ship with the bearer token and defaults filled', async () => {
  const { fetch, sent } = fakeFetch([204]);
  const s = sink(fetch);
  s.record(entry({ content: INVOICE, delivered: true }));
  await s.flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.auth, `Bearer ${TOKEN}`);
  const [record] = sent[0]?.records ?? [];
  assert.equal(record?.ts, 1000);
  assert.equal(record?.content, INVOICE);
  assert.equal(record?.reason, null);
  assert.equal(s.pending, 0);
  await s.close();
});

test('sink down or 5xx: the batch stays queued, in order, for the retry', async () => {
  const { fetch, sent } = fakeFetch(['down', 503, 204]);
  const s = sink(fetch);
  s.record(entry({ code: '00000001' }));
  s.record(entry({ code: '00000002' }));
  await s.flush();
  assert.equal(s.pending, 2);
  await s.flush();
  assert.equal(s.pending, 2);
  await s.flush();
  assert.equal(s.pending, 0);
  assert.deepEqual(sent[0]?.records.map((r) => r.code), ['00000001', '00000002']);
  await s.close();
});

test('a wrong token (401) keeps the batch queued for a fixed redeploy', async () => {
  const { fetch, sent } = fakeFetch([401, 204]);
  const s = sink(fetch);
  s.record(entry());
  await s.flush();
  assert.equal(s.pending, 1);
  await s.flush();
  assert.equal(s.pending, 0);
  assert.equal(sent.length, 2);
  await s.close();
});

test('a record arriving mid-send ships in the same drain', async () => {
  const { fetch, sent } = fakeFetch([204, 204]);
  const s = sink(fetch);
  s.record(entry({ code: '00000001' }));
  const done = s.flush(); // first batch is out; the next record must not wait for a third
  s.record(entry({ code: '00000002' }));
  await done;
  assert.deepEqual(sent.flatMap((b) => b.records.map((r) => r.code)), ['00000001', '00000002']);
  await s.close();
});

test('an off-contract rejection (400) drops the batch instead of blocking the queue on it', async () => {
  const { fetch, sent } = fakeFetch([400, 204]);
  const s = sink(fetch);
  s.record(entry({ code: '00000001' }));
  await s.flush();
  assert.equal(s.pending, 0);
  s.record(entry({ code: '00000002' }));
  await s.flush();
  // One attempt each: the rejected batch was never resent.
  assert.deepEqual(sent.map((b) => b.records.map((r) => r.code)), [['00000001'], ['00000002']]);
  await s.close();
});

test('a full queue drops the OLDEST records, keeping the newest', async () => {
  const { fetch, sent } = fakeFetch(['down', 204]);
  const s = sink(fetch, 3);
  s.record(entry({ code: '00000001' }));
  await s.flush(); // fails; record 1 goes back in the queue
  for (const code of ['00000002', '00000003', '00000004']) s.record(entry({ code }));
  assert.equal(s.pending, 3);
  await s.flush();
  assert.deepEqual(sent[0]?.records.map((r) => r.code), ['00000002', '00000003', '00000004']);
  await s.close();
});

test('close makes a last attempt at whatever is queued', async () => {
  const { fetch, sent } = fakeFetch([204]);
  const s = sink(fetch);
  s.record(entry());
  await s.close();
  assert.equal(sent.length, 1);
});
