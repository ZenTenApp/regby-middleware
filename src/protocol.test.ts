import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nprofileEncode } from 'nostr-tools/nip19';

import {
  extractIntent,
  parseInbound,
  isValidPaymentUri,
  REGBY_URI_PREFIXES,
} from './protocol.ts';

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

// A real npub, the hex it decodes to, and an nprofile for the same key. The
// shape check decodes `nostr=`, so a placeholder will not do.
const NPUB = 'npub1e2yuky03caw4ke3zy68lg0fz3r4gkt94hx4fjmlelacyljgyk79svn3eef';
const PUBKEY_HEX = 'ca89cb11f1c75d5b6622268ff43d2288ea8b2cb5b9aa996ff9ff704fc904b78b';
const NPROFILE = nprofileEncode({ pubkey: PUBKEY_HEX });

test('REGBY_URI_PREFIXES is exactly the pair the app mirrors', () => {
  // The lockstep with the app's `utils/regby.ts` is otherwise carried by prose
  // alone, and a silent edit on either side mints codes the other refuses.
  // This suite cannot see that repo, so pin what it can: these two, this order.
  assert.deepEqual([...REGBY_URI_PREFIXES], ['defito://', 'defifrom://']);
});

test('isValidPaymentUri accepts a request or a confirmation, single or multi-line', () => {
  assert.equal(isValidPaymentUri('defito://base/0xabc&amount=EURC:1.00&nostr=npub1x'), true);
  assert.equal(
    isValidPaymentUri('defito://base/0xabc&amount=EURC:1.00\ndefito://tron/T...&amount=USDT:1.18'),
    true,
  );
  // A code stands in for either direction: a merchant's request the customer
  // redeems, or a customer's confirmation the merchant redeems.
  assert.equal(
    isValidPaymentUri('defifrom://base/0xabc&amount=USDT:1&tx=0xdead&nostr=npub1x'),
    true,
  );
  // Case-insensitive, like the app's own check.
  assert.equal(isValidPaymentUri('DeFiTo://base/0xabc&amount=USDT:1'), true);
  // CRLF is a line break, not a trailing character on line one.
  assert.equal(isValidPaymentUri('defito://a\r\ndefito://b'), true);
  // A blank line between options is not an empty line that fails the rule.
  assert.equal(isValidPaymentUri('defito://a\n\n  \ndefito://b'), true);
});

test('isValidPaymentUri refuses a payload that mixes the two schemes', () => {
  // A request and a confirmation mean opposite things. Refusing here means we
  // never store one code that redeems as both, rather than leaving the wallet
  // as the only thing standing between them.
  assert.equal(isValidPaymentUri('defito://base/0xabc\ndefifrom://base/0xabc'), false);
  // Both orders: picking the scheme off line ONE and testing the rest against
  // it is the implementation that gets exactly one of these wrong.
  assert.equal(isValidPaymentUri('defifrom://base/0xabc\ndefito://base/0xabc'), false);
});

test('isValidPaymentUri splits on every line terminator, not just \\n', () => {
  // Regression: with a `\r?\n` split a lone `\r` was ordinary in-line text, so a
  // second differently-schemed line rode inside what this file counted as one
  // line and the scheme-agreement rule never saw it. That is the exact payload
  // the rule exists to refuse, and the server is the untrusted hop holding it.
  assert.equal(isValidPaymentUri('defito://base/0xabc\rdefifrom://base/0xdead'), false);
  assert.equal(isValidPaymentUri('defito://base/0xabc\rhttps://evil.test'), false);
  assert.equal(isValidPaymentUri('defito://a\u2028https://evil.test'), false);
});

test('isValidPaymentUri refuses a line that is only the scheme', () => {
  // Minting it burns a code and a round trip on something the wallet is certain
  // to reject at redeem, leaving the merchant a failure they cannot explain.
  assert.equal(isValidPaymentUri('defito://'), false);
  assert.equal(isValidPaymentUri('defifrom://'), false);
  assert.equal(isValidPaymentUri('defito://a\ndefito://'), false);
});

test('isValidPaymentUri rejects the scheme defito replaced', () => {
  // Not aliased: the app stopped emitting it, so anything still sending one is
  // stale or hostile.
  assert.equal(isValidPaymentUri('defipay://base/0xabc&amount=USDT:1'), false);
});

test('isValidPaymentUri rejects a foreign scheme or empty', () => {
  assert.equal(isValidPaymentUri('https://evil.test'), false);
  assert.equal(isValidPaymentUri('defito://ok\nhttps://evil.test'), false);
  // `payto://` is a foreign scheme here: it was removed from the app, but this
  // server never accepted it, so it carries no rename history of its own.
  assert.equal(isValidPaymentUri('payto://base/0xabc&amount=USDT:1'), false);
  assert.equal(isValidPaymentUri(''), false);
  assert.equal(isValidPaymentUri('   '), false);
});

test('parseInbound: request_code returns the raw uri', () => {
  const uri = `defito://base/0xabc&amount=USDT:1&nostr=${NPUB}`;
  assert.deepEqual(parseInbound('request_code', uri), {
    ok: true,
    message: { intent: 'request_code', uri },
  });
  // The stored value is the plaintext verbatim — we never normalise a payload
  // we hand back to a wallet that will parse it strictly.
  const mixedCase = `DeFiTo://base/0xAbC&Amount=USDT:1&NOSTR=${NPUB}`;
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
});

test('parseInbound: a missing required field is malformed, NOT malicious', () => {
  // The verdicts differ by what they cost the sender: `malicious` is a 24 h
  // blacklist, `malformed` is a reply. A POS that builds a bad string is a
  // broken client, and locking it out for a day makes a bug look like an
  // outage. Only aiming a foreign scheme at us earns the block.
  const malformed = (uri: string) =>
    assert.deepEqual(parseInbound('request_code', uri), { ok: false, reason: 'malformed' }, uri);

  malformed(`defito://base/0xabc&amount=USDT:1`); // no nostr
  malformed(`defito://base/0xabc&nostr=${NPUB}`); // no amount
  malformed(`defito://base&amount=USDT:1&nostr=${NPUB}`); // no recipient segment
  malformed(`defito://base/&amount=USDT:1&nostr=${NPUB}`); // empty recipient
  malformed(`defito:///0xabc&amount=USDT:1&nostr=${NPUB}`); // empty network
  malformed(`defito://base/0xabc`); // no params at all
  // A confirmation says nothing without the on-chain hash it is confirming.
  malformed(`defifrom://base/0xabc&amount=USDT:1&nostr=${NPUB}`);
  // Only ONE line has to be short for the payload to be refused.
  malformed(`defito://base/0xabc&amount=USDT:1&nostr=${NPUB}\ndefito://tron/Tabc&amount=USDT:1`);
});

test('parseInbound: nostr must be a decodable identity key', () => {
  const malformed = (npub: string) =>
    assert.deepEqual(
      parseInbound('request_code', `defito://base/0xabc&amount=USDT:1&nostr=${npub}`),
      { ok: false, reason: 'malformed' },
      npub,
    );
  malformed('npub1x'); // truncated
  malformed(`${NPUB.slice(0, -1)}q`); // bad checksum
  malformed('office@coffeeshop.com'); // a recipient to look up, not a key
  malformed(PUBKEY_HEX); // bare hex has a tx hash's shape
  // `nprofile` carries a key too and the app accepts it, so we must as well or
  // we would refuse a payload the wallet built.
  assert.deepEqual(
    parseInbound('request_code', `defito://base/0xabc&amount=USDT:1&nostr=${NPROFILE}`),
    {
      ok: true,
      message: {
        intent: 'request_code',
        uri: `defito://base/0xabc&amount=USDT:1&nostr=${NPROFILE}`,
      },
    },
  );
});

test('parseInbound: a complete confirmation passes', () => {
  const uri = `defifrom://base/0xabc&amount=USDT:1&tx=0xdead&nostr=${NPUB}`;
  assert.deepEqual(parseInbound('request_code', uri), {
    ok: true,
    message: { intent: 'request_code', uri },
  });
});

test('parseInbound: whitespace-only request_code is silent, not malicious', () => {
  // `malicious` costs the sender a 24 h blacklist. Three spaces from a buggy
  // client is noise; the empty-content guard already treats "no payload" that
  // way, and a payload that is only whitespace is the same thing.
  assert.deepEqual(parseInbound('request_code', '   '), { ok: false, reason: 'silent' });
  assert.deepEqual(parseInbound('request_code', '\n\n'), { ok: false, reason: 'silent' });
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
  assert.deepEqual(parseInbound('request_code', 'defito://a/b&amount=x&nostr=' + 'a'.repeat(5000)), {
    ok: false,
    reason: 'silent',
  });
});
