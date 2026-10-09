import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { AuditStore } from './store.ts';
import { createSinkServer } from './server.ts';
import { auditRecord } from '../audit.fixture.ts';

const TOKEN = 's'.repeat(32);

/** Run `fn` against a live sink on a free port, over an in-memory store. */
async function withSink(fn: (url: string, store: AuditStore) => Promise<void>): Promise<void> {
  const store = new AuditStore(':memory:', 365, 100);
  const server = createSinkServer(store, TOKEN);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, store);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
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
  });
});

test('a wrong or missing token stores nothing', async () => {
  await withSink(async (url, store) => {
    const body = JSON.stringify({ records: [auditRecord({ id: randomUUID() })] });
    assert.equal((await post(url, body, 'x'.repeat(32))).status, 401);
    const bare = await fetch(`${url}/events`, { method: 'POST', body });
    assert.equal(bare.status, 401);
    assert.equal(store.size, 0);
  });
});

test('malformed JSON, an off-contract batch and an oversized body are refused', async () => {
  await withSink(async (url, store) => {
    assert.equal((await post(url, '{nope')).status, 400);
    assert.equal((await post(url, JSON.stringify({ records: [{ id: 'x' }] }))).status, 400);
    // The sink stops reading at the cap, so the client sees a 413 or, mid-upload, a reset.
    const oversized = await post(url, 'x'.repeat(11_000_000)).then((r) => r.status, () => 'reset');
    assert.ok(oversized === 413 || oversized === 'reset', String(oversized));
    assert.equal(store.size, 0);
  });
});

test('unknown routes and methods are refused; health answers', async () => {
  await withSink(async (url) => {
    assert.equal((await fetch(`${url}/nope`)).status, 404);
    assert.equal((await fetch(`${url}/events`)).status, 405);
    assert.equal((await fetch(`${url}/health`)).status, 204);
  });
});
