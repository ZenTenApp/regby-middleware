import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createSinkServer, type AuditSink } from './server.ts';
import type { AuditRecord } from '../audit.ts';
import { auditRecord } from '../audit.fixture.ts';

const TOKEN = 's'.repeat(32);

/** Stands in for the database: the intake only needs `insert`. */
class MemorySink implements AuditSink {
  private readonly ids = new Set<string>();

  get size(): number {
    return this.ids.size;
  }

  async insert(records: readonly AuditRecord[]): Promise<number> {
    const before = this.ids.size;
    for (const r of records) this.ids.add(r.id);
    return this.ids.size - before;
  }
}

/** Run `fn` against a live sink on a free port, over `store` (in-memory by default). */
async function withSink<S extends AuditSink>(fn: (url: string, store: S) => Promise<void>, store: S): Promise<void> {
  const server = createSinkServer(store, TOKEN);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, store);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function post(url: string, body: string, token = TOKEN): Promise<Response> {
  return fetch(`${url}/events`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body,
  });
}

test('a valid batch with the right token is stored', async () => {
  await withSink(async (url, store) => {
    const res = await post(url, JSON.stringify({ records: [auditRecord({ id: randomUUID() })] }));
    assert.equal(res.status, 204);
    assert.equal(store.size, 1);
  }, new MemorySink());
});

test('a wrong or missing token stores nothing', async () => {
  await withSink(async (url, store) => {
    const body = JSON.stringify({ records: [auditRecord({ id: randomUUID() })] });
    assert.equal((await post(url, body, 'x'.repeat(32))).status, 401);
    const bare = await fetch(`${url}/events`, { method: 'POST', body });
    assert.equal(bare.status, 401);
    assert.equal(store.size, 0);
  }, new MemorySink());
});

test('malformed JSON, an off-contract batch and an oversized body are refused', async () => {
  await withSink(async (url, store) => {
    assert.equal((await post(url, '{nope')).status, 400);
    assert.equal((await post(url, JSON.stringify({ records: [{ id: 'x' }] }))).status, 400);
    // The sink stops reading at the cap, so the client sees a 413 or, mid-upload, a reset.
    const oversized = await post(url, 'x'.repeat(11_000_000)).then((r) => r.status, () => 'reset');
    assert.ok(oversized === 413 || oversized === 'reset', String(oversized));
    assert.equal(store.size, 0);
  }, new MemorySink());
});

test('unknown routes and methods are refused; health answers', async () => {
  await withSink(async (url) => {
    assert.equal((await fetch(`${url}/nope`)).status, 404);
    assert.equal((await fetch(`${url}/events`)).status, 405);
    assert.equal((await fetch(`${url}/health`)).status, 204);
  }, new MemorySink());
});

test('a storage failure answers 5xx, so the broker retries the batch', async () => {
  const failing: AuditSink = { insert: () => Promise.reject(new Error('database down')) };
  await withSink(async (url) => {
    const res = await post(url, JSON.stringify({ records: [auditRecord({ id: randomUUID() })] }));
    assert.equal(res.status, 500);
  }, failing);
});
