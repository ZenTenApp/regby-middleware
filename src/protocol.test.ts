import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nprofileEncode } from 'nostr-tools/nip19';

import {
  extractIntent,
  parseInbound,
  isValidPaymentUri,
  DEFITO_PREFIX,
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
// 32 hex chars, no dashes - the shape the app mints. Opaque to this server.
const ORDER = '9f2c14ab7e5d4083b6a1cc90de3f7721';

test('DEFITO_PREFIX is the word the app builds against', () => {
  // The lockstep with the app is otherwise carried by prose alone, and a silent
  // edit on either side mints codes the other refuses. This suite cannot see
  // that repo, so pin what it can.
  assert.equal(DEFITO_PREFIX, 'defito://');
});

test('isValidPaymentUri accepts an invoice, single or multi-line', () => {
  assert.equal(isValidPaymentUri('defito://base/0xabc&amount=EURC:1.00&nostr=npub1x'), true);
  // Several lines are the merchant's ranked fallback rails for ONE order.
  assert.equal(
    isValidPaymentUri('defito://base/0xabc&amount=EURC:1.00\ndefito://tron/T...&amount=USDT:1.18'),
    true,
  );
  // Case-insensitive, like the app's own check.
  assert.equal(isValidPaymentUri('DeFiTo://base/0xabc&amount=USDT:1'), true);
  // CRLF is a line break, not a trailing character on line one.
  assert.equal(isValidPaymentUri('defito://a\r\ndefito://b'), true);
  // A blank line between options is not an empty line that fails the rule.
  assert.equal(isValidPaymentUri('defito://a\n\n  \ndefito://b'), true);
});

test('isValidPaymentUri refuses a confirmation, this broker never sees one', () => {
  // Confirmations go straight to the invoice's npub; see `DEFITO_PREFIX`.
  assert.equal(
    isValidPaymentUri('defifrom://base/0xabc&amount=USDT:1&tx=0xdead&nostr=npub1x'),
    false,
  );
});

test('isValidPaymentUri splits on every line terminator, not just \\n', () => {
  // Regression: with a `\r?\n` split a lone `\r` was ordinary in-line text, so a
  // second foreign-scheme line rode inside what this file counted as one line
  // and the every-line-is-an-invoice rule never saw it. That is the exact
  // payload the rule exists to refuse, and the server is the untrusted hop
  // holding it.
  assert.equal(isValidPaymentUri('defito://base/0xabc\rhttps://evil.test'), false);
  assert.equal(isValidPaymentUri('defito://a\u2028https://evil.test'), false);
});

test('isValidPaymentUri refuses a line that is only the scheme', () => {
  // Minting it burns a code and a round trip on something the wallet is certain
  // to reject at redeem, leaving the merchant a failure they cannot explain.
  assert.equal(isValidPaymentUri('defito://'), false);
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
  const uri = `defito://base/0xabc&amount=USDT:1&orderid=${ORDER}&nostr=${NPUB}`;
  assert.deepEqual(parseInbound('request_code', uri), {
    ok: true,
    message: { intent: 'request_code', uri },
  });
  // The stored value is the plaintext verbatim — we never normalise a payload
  // we hand back to a wallet that will parse it strictly.
  const mixedCase = `DeFiTo://base/0xAbC&Amount=USDT:1&OrderId=${ORDER}&NOSTR=${NPUB}`;
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

  malformed(`defito://base/0xabc&amount=USDT:1&orderid=${ORDER}`); // no nostr
  malformed(`defito://base/0xabc&orderid=${ORDER}&nostr=${NPUB}`); // no amount
  // Without an order id the confirmation that settles this invoice has nothing
  // to echo, so the merchant could never match the payment to the order.
  malformed(`defito://base/0xabc&amount=USDT:1&nostr=${NPUB}`);
  malformed(`defito://base&amount=USDT:1&orderid=${ORDER}&nostr=${NPUB}`); // no recipient
  malformed(`defito://base/&amount=USDT:1&orderid=${ORDER}&nostr=${NPUB}`); // empty recipient
  malformed(`defito:///0xabc&amount=USDT:1&orderid=${ORDER}&nostr=${NPUB}`); // empty network
  malformed(`defito://base/0xabc`); // no params at all
  // Only ONE line has to be short for the payload to be refused.
  malformed(
    `defito://base/0xabc&amount=USDT:1&orderid=${ORDER}&nostr=${NPUB}\ndefito://tron/Tabc&amount=USDT:1`,
  );
});

test('parseInbound: nostr must be a decodable identity key', () => {
  const malformed = (npub: string) =>
    assert.deepEqual(
      parseInbound('request_code', `defito://base/0xabc&amount=USDT:1&orderid=${ORDER}&nostr=${npub}`),
      { ok: false, reason: 'malformed' },
      npub,
    );
  malformed('npub1x'); // truncated
  malformed(`${NPUB.slice(0, -1)}q`); // bad checksum
  malformed('office@coffeeshop.com'); // a recipient to look up, not a key
  malformed(PUBKEY_HEX); // bare hex has a tx hash's shape
  // `nprofile` carries a key too and the app accepts it, so we must as well or
  // we would refuse a payload the wallet built.
  const withNprofile = `defito://base/0xabc&amount=USDT:1&orderid=${ORDER}&nostr=${NPROFILE}`;
  assert.deepEqual(parseInbound('request_code', withNprofile), {
    ok: true,
    message: { intent: 'request_code', uri: withNprofile },
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
  assert.deepEqual(
    parseInbound('request_code', `defito://a/b&amount=x&orderid=${ORDER}&nostr=` + 'a'.repeat(5000)),
    { ok: false, reason: 'silent' },
  );
});

// ---------------------------------------------------------------------------
// Cross-repo parity. These fixtures are duplicated VERBATIM in the app's
// `__tests__/protocol-parity.test.ts`; if you change one list, change the
// other. The two validators are deliberately different in scope - this server
// checks far less, because chain and coin names come from a registry that
// updates without a server deploy - but where both have an opinion they must
// agree. A payload one accepts and the other refuses is either a code that
// mints and never redeems, or a merchant whose POS mints nothing with no
// diagnosable reason. Three such divergences were found by measurement:
// duplicate keys, percent-encoded values, and the line-terminator set.
// ---------------------------------------------------------------------------

const PARITY_ACCEPTED: readonly string[] = [
  `defito://base/0xabc&amount=USDT:1&orderid=${ORDER}&nostr=${NPUB}`,
  `defito://base/0xabc&amount=USDT&orderid=${ORDER}&nostr=${NPUB}`,
  `defito://avalanche,base,tron/0xabc,TJRxyz&amount=USDT,USDC:123.45&orderid=${ORDER}&nostr=${NPUB}`,
  `defito://base/0xabc&amount=USDT:1&orderid=${ORDER}&nostr=${NPUB}\ndefito://tron/TJRxyz&amount=USDT:1&orderid=${ORDER}&nostr=${NPUB}`,
  `DeFiTo://base/0xAbC&Amount=USDT:1&OrderId=${ORDER}&NOSTR=${NPUB}`,
];

const PARITY_REFUSED: readonly string[] = [
  `defito://base/0xabc&amount=USDT:1&nostr=${NPUB}`,
  `defito://base/0xabc&amount=USDT:1&orderid=${ORDER}`,
  `defito://base/0xabc&orderid=${ORDER}&nostr=${NPUB}`,
  `defito://base&amount=USDT:1&orderid=${ORDER}&nostr=${NPUB}`,
  `defito://&orderid=${ORDER}&nostr=${NPUB}`,
  'defito://',
  `defipay://base/0xabc&amount=USDT:1&orderid=${ORDER}&nostr=${NPUB}`,
  `defifrom://base/0xabc&amount=USDT:1&orderid=${ORDER}&nostr=${NPUB}&tx=0xdead`,
  'https://evil.test',
  `defito://base/0xabc&amount=USDT:1&orderid=${ORDER}&nostr=${NPUB}\rhttps://evil.test`,
  `defito://base/0xabc&amount=USDT:1&orderid=${ORDER}&nostr=${NPUB}\u2028https://evil.test`,
  `defito://base/0xabc&amount=&amount=USDT:5&orderid=${ORDER}&nostr=${NPUB}`,
  `defito://base/0xabc&amount=USDT:1&orderid=${ORDER}&nostr=&nostr=${NPUB}`,
  // A hostile value in a presence-checked field. The app drops it, so without
  // the same screen here a code mints and is refused at redeem.
  `defito://base/0xabc&amount=USDT:1&orderid=%3Cscript%3E&nostr=${NPUB}`,
  `defito://base/0xabc&amount=USDT:1&orderid=%E2%80%AE${ORDER}&nostr=${NPUB}`,
  // Space-separated foreign scheme - the app refuses it, so this must too.
  `defito://base/0xabc&amount=USDT:1&orderid=${ORDER}&nostr=${NPUB} https://evil.test`,
];

test('parity: every payload the app parses, this server mints', () => {
  for (const payload of PARITY_ACCEPTED) {
    assert.deepEqual(
      parseInbound('request_code', payload),
      { ok: true, message: { intent: 'request_code', uri: payload } },
      payload,
    );
  }
});

test('parity: every payload the app refuses, this server refuses', () => {
  for (const payload of PARITY_REFUSED) {
    const result = parseInbound('request_code', payload);
    assert.equal(result.ok, false, `should be refused: ${JSON.stringify(payload)}`);
  }
});

test('parity: a refusal keeps the right VERDICT, not merely ok:false', () => {
  // The two verdicts cost the sender different things - `malicious` is a 24 h
  // blacklist, `malformed` is a reply - so a payload drifting between them is a
  // real regression that an `ok === false` assertion cannot see.
  const reasonOf = (payload: string) => {
    const result = parseInbound('request_code', payload);
    return result.ok ? 'ok' : result.reason;
  };
  // Wrong scheme aimed at us after proving key possession: deliberate.
  assert.equal(reasonOf('https://evil.test'), 'malicious');
  assert.equal(reasonOf(`defipay://base/0xabc&amount=USDT:1&orderid=${ORDER}&nostr=${NPUB}`), 'malicious');
  assert.equal(reasonOf(`defifrom://base/0xabc&amount=USDT:1&orderid=${ORDER}&nostr=${NPUB}`), 'malicious');
  // Right scheme, field missing: a broken client, and no blacklist.
  assert.equal(reasonOf(`defito://base/0xabc&amount=USDT:1&nostr=${NPUB}`), 'malformed');
  assert.equal(reasonOf(`defito://base/0xabc&orderid=${ORDER}&nostr=${NPUB}`), 'malformed');
  assert.equal(reasonOf(`defito://base&amount=USDT:1&orderid=${ORDER}&nostr=${NPUB}`), 'malformed');
});

test('parity: a percent-encoded npub is read the same way as a plain one', () => {
  // `%6E` is `n`. The app percent-decodes parameter values, so it saw a valid
  // npub here while this server saw the raw escape and answered `malformed`.
  const encoded = `defito://base/0xabc&amount=USDT:1&orderid=${ORDER}&nostr=${NPUB.replace(/^n/, '%6E')}`;
  assert.equal(parseInbound('request_code', encoded).ok, true);
});
