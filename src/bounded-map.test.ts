import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoundedMap } from './bounded-map.ts';

test('evicts the oldest-inserted key when a new key overflows capacity', () => {
  const m = new BoundedMap<string, number>(2);
  m.set('a', 1);
  m.set('b', 2);
  m.set('c', 3); // 'a' (oldest) is evicted
  assert.equal(m.size, 2);
  assert.equal(m.has('a'), false);
  assert.equal(m.get('b'), 2);
  assert.equal(m.get('c'), 3);
});

test('re-setting an existing key does not evict and does not grow', () => {
  const m = new BoundedMap<string, number>(2);
  m.set('a', 1);
  m.set('b', 2);
  m.set('a', 9); // update in place - 'b' must survive
  assert.equal(m.size, 2);
  assert.equal(m.get('a'), 9);
  assert.equal(m.has('b'), true);
});
