import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractIntent, parseInbound, isValidPaymentUri } from './protocol.ts';

test('extractIntent reads a known i tag', () => {
  assert.equal(
    extractIntent([['p', 'x'], ['i', 'request_code'], ['e', 'y']]),
    'request_code',
  );
  assert.equal(extractIntent([['i', 'request_uri']]), 'request_uri');
});

test('extractIntent rejects unknown / absent', () => {
  assert.equal(extractIntent([['i', 'bogus']]), null);
  assert.equal(extractIntent([['p', 'x'], ['t', 'regby']]), null);
  assert.equal(extractIntent([]), null);
});

test('isValidPaymentUri accepts single and multi-line', () => {
  assert.equal(isValidPaymentUri('defito://base/0xabc&amount=EURC:1.00&nostr=npub1x'), true);
  assert.equal(
    isValidPaymentUri('defito://base/0xabc&amount=EURC:1.00\ndefito://tron/T...&amount=USDT:1.18'),
    true,
  );
  // Case-insensitive, like the app's own check.
  assert.equal(isValidPaymentUri('DeFiTo://base/0xabc&amount=USDT:1'), true);
});

test('isValidPaymentUri accepts a confirmation as well as a request', () => {
  // A code stands in for either half of the protocol.
  assert.equal(
    isValidPaymentUri('defifrom://base/0xabc&amount=USDT:1&tx=0xdead&nostr=npub1x'),
    true,
  );
});

test('isValidPaymentUri refuses a payload that mixes the two schemes', () => {
  // A request and a confirmation mean opposite things. Refusing here means we
  // never store one code that redeems as both, rather than leaving the wallet
  // as the only thing standing between them.
  assert.equal(isValidPaymentUri('defito://base/0xabc\ndefifrom://base/0xabc'), false);
  assert.equal(isValidPaymentUri('defifrom://base/0xabc\ndefito://base/0xabc'), false);
});

test('isValidPaymentUri rejects the schemes defito replaced', () => {
  // Not aliased: the app stopped emitting these, so anything still sending one
  // is stale or hostile.
  assert.equal(isValidPaymentUri('defipay://base/0xabc&amount=USDT:1'), false);
  assert.equal(isValidPaymentUri('payto://base/0xabc&amount=USDT:1'), false);
});

test('isValidPaymentUri rejects a foreign scheme or empty', () => {
  assert.equal(isValidPaymentUri('https://evil.test'), false);
  assert.equal(isValidPaymentUri('defito://ok\nhttps://evil.test'), false);
  assert.equal(isValidPaymentUri(''), false);
  assert.equal(isValidPaymentUri('   '), false);
});

test('parseInbound: request_code returns the raw uri', () => {
  const uri = 'defito://base/0xabc&amount=USDT:1&nostr=npub1x';
  assert.deepEqual(parseInbound('request_code', uri), {
    ok: true,
    message: { intent: 'request_code', uri },
  });
  // The stored value is the plaintext verbatim — we never normalise a payload
  // we hand back to a wallet that will parse it strictly.
  const mixedCase = 'DeFiTo://base/0xAbC&amount=USDT:1';
  assert.deepEqual(parseInbound('request_code', mixedCase), {
    ok: true,
    message: { intent: 'request_code', uri: mixedCase },
  });
});

test('parseInbound: request_code with a non-payment payload is malicious', () => {
  assert.deepEqual(parseInbound('request_code', 'https://evil.test'), {
    ok: false,
    reason: 'malicious',
  });
  // Including the scheme we used to accept.
  assert.deepEqual(parseInbound('request_code', 'defipay://base/0xabc&amount=USDT:1'), {
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
  assert.deepEqual(parseInbound('request_code', 'defito://' + 'a'.repeat(5000)), {
    ok: false,
    reason: 'silent',
  });
});
