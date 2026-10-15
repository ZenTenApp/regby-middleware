import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractIntent, parseInbound, MAX_CONTENT_LENGTH, FAILURE_INTENT } from './protocol.ts';

test('extractIntent reads a known i tag', () => {
  assert.equal(
    extractIntent([['p', 'x'], ['i', 'request_regby_code'], ['e', 'y']]),
    'request_regby_code',
  );
  assert.equal(extractIntent([['i', 'request_regby_content']]), 'request_regby_content');
});

test('extractIntent rejects unknown / absent', () => {
  assert.equal(extractIntent([['i', 'bogus']]), null);
  assert.equal(extractIntent([['p', 'x'], ['t', 'regby']]), null);
  assert.equal(extractIntent([]), null);
});

test('extractIntent rejects the outbound intents echoed back at us', () => {
  // Reply intents must never be processed inbound, so extractIntent (the sole
  // inbound gate) drops them before parseInbound.
  for (const outbound of ['regby_code', 'regby_content', 'regby_content_delivered']) {
    assert.equal(extractIntent([['i', outbound]]), null, outbound);
  }
});

test('extractIntent rejects the pre-rename intents', () => {
  // Renamed, not aliased: a stale client gets no reply rather than a half-
  // understood one.
  for (const old of ['request_code', 'request_uri', 'code', 'uri']) {
    assert.equal(extractIntent([['i', old]]), null, old);
  }
});

test('parseInbound: request_regby_code carries any text, verbatim', () => {
  // The content is opaque: judging it (a defito invoice or anything else) is
  // the recipient's job, so nothing here is refused for what it says.
  const texts = [
    'defito://base/0xabc&amount=USDT:1',
    'https://example.com/pay?x=1',
    'javascript:alert(1)',
    'plain text, any language: café ☕',
    'line one\r\nline two\n',
    '  padded  ',
    '   ',
    '',
  ];
  for (const content of texts) {
    assert.deepEqual(
      parseInbound('request_regby_code', content),
      { ok: true, message: { intent: 'request_regby_code', content } },
      JSON.stringify(content),
    );
  }
});

test('parseInbound: content up to the cap is carried, past it dropped silently', () => {
  const atCap = 'x'.repeat(MAX_CONTENT_LENGTH);
  assert.equal(parseInbound('request_regby_code', atCap).ok, true);
  assert.deepEqual(parseInbound('request_regby_code', `${atCap}x`), { ok: false, reason: 'silent' });
});

test('parseInbound: request_regby_content accepts an 8-digit code, trims', () => {
  assert.deepEqual(parseInbound('request_regby_content', ' 42891337 '), {
    ok: true,
    message: { intent: 'request_regby_content', code: '42891337' },
  });
});

test('parseInbound: request_regby_content rejects bad code shapes silently', () => {
  // 7 digits (short), 9 digits (long), 8 chars with a letter, empty, has a dot.
  for (const code of ['4289133', '428913377', '42a91337', '', '1234567.']) {
    assert.deepEqual(
      parseInbound('request_regby_content', code),
      { ok: false, reason: 'silent' },
      `code ${JSON.stringify(code)} rejected`,
    );
  }
});

// What NIP-04 decrypt hands us for encrypted BYTES: nostr-tools decodes the
// plaintext with a non-fatal UTF-8 decoder, so bytes arrive as a string.
function asDecrypted(bytes: readonly number[]): string {
  return new TextDecoder().decode(Uint8Array.from(bytes));
}
const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d];

test('binary content is the one thing refused, on both intents', () => {
  const png = asDecrypted(PNG_HEADER);
  assert.deepEqual(parseInbound('request_regby_code', png), { ok: false, reason: 'binary' });
  assert.deepEqual(parseInbound('request_regby_content', png), { ok: false, reason: 'binary' });
  // Bytes behind text are still bytes: no reply, no audit.
  assert.deepEqual(parseInbound('request_regby_code', 'hello\u0000\u0001'), {
    ok: false,
    reason: 'binary',
  });
  // An invalid UTF-8 sequence surfaces as U+FFFD.
  const withBadByte = 'hello' + asDecrypted([0xc3, 0x28]);
  assert.ok(withBadByte.includes('�'));
  assert.deepEqual(parseInbound('request_regby_code', withBadByte), { ok: false, reason: 'binary' });
  assert.deepEqual(parseInbound('request_regby_content', '4289\u00001337'), {
    ok: false,
    reason: 'binary',
  });
});

test('real text is never read as binary', () => {
  // Whitespace controls, non-ASCII text and an ESCAPED NUL are all text.
  for (const content of ['a\r\nb\t\u000B\u000C', 'café ☕ 日本', 'x=%00']) {
    assert.equal(parseInbound('request_regby_code', content).ok, true, JSON.stringify(content));
  }
});

// Cross-repo parity for failure intents: the same list, in the same order, as
// the app's failure intents in `__tests__/protocol-parity.test.ts`. A failure
// intent this server sends that the app does not know never matches the app's
// pending request, so the user waits out a timeout instead of seeing the error.
const PARITY_FAILURE_INTENTS: readonly string[] = [
  'regby_code_not_found',
  'regby_code_expired',
  'regby_code_already_redeemed',
  'regby_code_locked',
  'regby_code_busy',
];

test('parity: every failure intent this server sends is known to the app', () => {
  assert.deepEqual(Object.values(FAILURE_INTENT), PARITY_FAILURE_INTENTS);
});
