import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AuditStore } from './store.ts';
import { auditRecord } from '../audit.fixture.ts';

const DAY = 86_400;

function clock(start = 100 * DAY): { now: () => number; tick: (s: number) => void } {
  let t = start;
  return { now: () => t, tick: (s) => (t += s) };
}

test('a retried batch is stored once', () => {
  const store = new AuditStore(':memory:', 365, 100);
  const batch = [auditRecord({ id: randomUUID() }), auditRecord({ id: randomUUID() })];
  assert.equal(store.insert(batch), 2);
  assert.equal(store.insert(batch), 0);
  assert.equal(store.size, 2);
  store.close();
});

test('records past retention are pruned; newer ones stay', () => {
  const c = clock();
  const store = new AuditStore(':memory:', 30, 100, c.now);
  store.insert([
    auditRecord({ id: randomUUID(), ts: c.now() - 31 * DAY }),
    auditRecord({ id: randomUUID(), ts: c.now() - 29 * DAY }),
  ]);
  store.prune();
  assert.equal(store.size, 1);
  c.tick(2 * DAY);
  store.prune();
  assert.equal(store.size, 0);
  store.close();
});

test('the row cap holds on every insert, dropping the oldest first', () => {
  const store = new AuditStore(':memory:', 365, 3);
  const at = 100 * DAY;
  store.insert([1, 2, 3, 4, 5].map((n) => auditRecord({ id: randomUUID(), ts: at + n, code: `0000000${n}` })));
  assert.equal(store.size, 3);
  store.close();
});

test('the history is readable by its owner only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'regby-audit-'));
  try {
    const nested = join(dir, 'audit');
    const path = join(nested, 'audit.db');
    const store = new AuditStore(path, 365, 100);
    store.close();
    assert.equal(statSync(nested).mode & 0o777, 0o700);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
