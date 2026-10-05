import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from './rate-limit.ts';

test('allows up to max then blocks within the window', () => {
  let t = 100;
  const limiter = new RateLimiter(3, 60, () => t);
  assert.equal(limiter.allow('k'), true);
  assert.equal(limiter.allow('k'), true);
  assert.equal(limiter.allow('k'), true);
  assert.equal(limiter.allow('k'), false);
});

test('window slides - old hits age out', () => {
  let t = 100;
  const limiter = new RateLimiter(2, 60, () => t);
  assert.equal(limiter.allow('k'), true);
  assert.equal(limiter.allow('k'), true);
  assert.equal(limiter.allow('k'), false);
  t += 61;
  assert.equal(limiter.allow('k'), true);
});

test('limits are per-key', () => {
  const limiter = new RateLimiter(1, 60, () => 100);
  assert.equal(limiter.allow('a'), true);
  assert.equal(limiter.allow('b'), true);
  assert.equal(limiter.allow('a'), false);
});
