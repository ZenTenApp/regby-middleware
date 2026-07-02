import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Blacklist } from './blacklist.ts';

test('blocked is true within the window, false before/after', () => {
  let t = 100;
  const bl = new Blacklist(86_400, () => t);
  assert.equal(bl.blocked('k'), false);
  bl.block('k');
  assert.equal(bl.blocked('k'), true);
  t += 86_400; // exactly at expiry → lapsed
  assert.equal(bl.blocked('k'), false);
});

test('block is per-key', () => {
  const bl = new Blacklist(60, () => 100);
  bl.block('a');
  assert.equal(bl.blocked('a'), true);
  assert.equal(bl.blocked('b'), false);
});

test('re-block refreshes the window', () => {
  let t = 100;
  const bl = new Blacklist(60, () => t);
  bl.block('k');
  t += 50;
  bl.block('k'); // refresh → expiry now 210
  t += 50; // 200 < 210, still blocked
  assert.equal(bl.blocked('k'), true);
});

test('sweep drops lapsed entries', () => {
  let t = 100;
  const bl = new Blacklist(60, () => t);
  bl.block('k');
  t += 61;
  bl.sweep();
  // After sweep the entry is gone; blocked stays false.
  assert.equal(bl.blocked('k'), false);
});
