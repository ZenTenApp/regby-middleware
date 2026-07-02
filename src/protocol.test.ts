import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractIntent, parseInbound, isValidDefipay } from './protocol.ts';

test('extractIntent reads a known i tag', () => {
  assert.equal(
    extractIntent([['p', 'x'], ['i', 'request_code'], ['e', 'y']]),
    'request_code',
  );
  assert.equal(extractIntent([['i', 'request_uri']]), 'request_uri');
});

test('extractIntent rejects unknown / absent', () => {
  assert.equal(extractIntent([['i', 'bogus']]), null);
  assert.equal(extractIntent([['p', 'x'], ['t', 'plink']]), null);
  assert.equal(extractIntent([]), null);
});

test('isValidDefipay accepts single and multi-line', () => {
  assert.equal(isValidDefipay('defipay://base/0xabc&amount=EURC:1.00'), true);
  assert.equal(
    isValidDefipay('defipay://base/0xabc&amount=EURC:1.00\ndefipay://tron/T...&amount=USDT:1.18'),
    true,
  );
});

test('isValidDefipay rejects non-defipay or empty', () => {
  assert.equal(isValidDefipay('https://evil.test'), false);
  assert.equal(isValidDefipay('defipay://ok\nhttps://evil.test'), false);
  assert.equal(isValidDefipay(''), false);
  assert.equal(isValidDefipay('   '), false);
});

test('parseInbound: request_code returns the raw uri', () => {
  const result = parseInbound('request_code', 'defipay://base/0xabc&amount=USDT:1');
  assert.deepEqual(result, {
    ok: true,
    message: { intent: 'request_code', uri: 'defipay://base/0xabc&amount=USDT:1' },
  });
});

test('parseInbound: request_code with a non-defipay payload is malicious', () => {
  assert.deepEqual(parseInbound('request_code', 'https://evil.test'), {
    ok: false,
    reason: 'malicious',
  });
});

test('parseInbound: request_uri accepts an 8-digit code, trims', () => {
  assert.deepEqual(parseInbound('request_uri', ' 42891337 '), {
    ok: true,
    message: { intent: 'request_uri', code: '42891337' },
  });
});

test('parseInbound: request_uri rejects bad code shapes silently', () => {
  // 7 digits (short), 9 digits (long), 8 chars with a letter, empty, has a dot.
  for (const code of ['4289133', '428913377', '42a91337', '', '1234567.']) {
    assert.deepEqual(
      parseInbound('request_uri', code),
      { ok: false, reason: 'silent' },
      `code ${JSON.stringify(code)} rejected`,
    );
  }
});

test('extractIntent rejects the outbound intents echoed back at us', () => {
  // `code`/`uri` are reply intents — the server must never process them inbound,
  // so extractIntent (the sole inbound gate) drops them before parseInbound.
  assert.equal(extractIntent([['i', 'code']]), null);
  assert.equal(extractIntent([['i', 'uri']]), null);
});

test('parseInbound: oversized content dropped silently', () => {
  // Silent regardless of intent (no blacklist on a size flood).
  assert.deepEqual(parseInbound('request_code', 'defipay://' + 'a'.repeat(5000)), {
    ok: false,
    reason: 'silent',
  });
});
