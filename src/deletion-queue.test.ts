import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeletionQueue } from './deletion-queue.ts';

test('takeDue returns only ids past their deleteAt and drains them', () => {
  const q = new DeletionQueue();
  q.add('a', 100);
  q.add('b', 200);
  q.add('c', 300);
  assert.deepEqual(q.takeDue(200), ['a', 'b']);
  // 'c' was retained (still due later); draining it proves 'a'/'b' were removed.
  assert.deepEqual(q.takeDue(300), ['c']);
  assert.deepEqual(q.takeDue(300), []);
});

test('takeDue returns nothing when none are due, keeping the item queued', () => {
  const q = new DeletionQueue();
  q.add('a', 500);
  assert.deepEqual(q.takeDue(100), []);
  assert.deepEqual(q.takeDue(500), ['a']); // still queued, drains once due
});
