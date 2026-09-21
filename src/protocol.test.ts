import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nprofileEncode } from 'nostr-tools/nip19';

import {
  extractIntent,
  parseInbound,
  isValidPaymentUri,
  DEFITO_PREFIX,
  MAX_PAYLOAD_LINES,
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

test('the shared constants are the values the app builds against', () => {
  // The parity lists below spell 20 and 21 literally, because they are copied
  // verbatim from the app's file. That is only safe while this holds.
  assert.equal(MAX_PAYLOAD_LINES, 20);
});

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

test('a bare scheme is an empty rail, not a foreign one', () => {
  // It carries our scheme, so it clears the gate that earns a 24 h blacklist
  // and is judged with the rest. The old check refused it HERE, which billed a
  // POS that rendered one empty rail for a day of lockout - measured against
  // the app, which redeems such a payload from its remaining rails.
  assert.equal(isValidPaymentUri('defito://'), true);
  // Nothing redeemable in it, so it is still refused - just as a broken client,
  // which is what it is.
  assert.deepEqual(parseInbound('request_code', 'defito://'), {
    ok: false,
    reason: 'malformed',
  });
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
  // EVERY rail has to be unredeemable, not just one: see the rails test below.
  malformed(`defito://base/0xabc\ndefito://tron/Tabc&amount=USDT:1`);
});

test('parseInbound: one broken rail does not sink the payload', () => {
  // Measured against the app: `parseDirectPay` drops a rail it cannot parse and
  // pays from the rest, so refusing here cost the merchant a code the customer
  // could have paid, over a rail the wallet was never going to show.
  const good = `defito://base/0xabc&amount=USDT:1&orderid=${ORDER}&nostr=${NPUB}`;
  for (const broken of ['defito://', 'defito://tron/Tabc&amount=USDT:1']) {
    const uri = `${good}\n${broken}`;
    assert.deepEqual(
      parseInbound('request_code', uri),
      { ok: true, message: { intent: 'request_code', uri } },
      uri,
    );
  }
});

test('parseInbound: the wallet trims before it screens, so we do too', () => {
  // A trailing BOM is a hidden character until `trim` removes it, and the app
  // trims first. Screening the untrimmed payload refused one it accepts.
  const uri = `defito://base/0xabc&amount=USDT:1&orderid=${ORDER}&nostr=${NPUB}\uFEFF`;
  assert.deepEqual(parseInbound('request_code', uri), {
    ok: true,
    // Stored VERBATIM: we validate the trimmed payload and keep what was sent.
    message: { intent: 'request_code', uri },
  });
});

test('parseInbound: nostr is read as leniently as the app reads it', () => {
  // `parseNostrIdentifier` strips a `nostr:` prefix and lowercases before the
  // bech32 decode, so both of these build payloads the wallet pays.
  for (const key of [`nostr:${NPUB}`, `N${NPUB.slice(1)}`]) {
    const uri = `defito://base/0xabc&amount=USDT:1&orderid=${ORDER}&nostr=${key}`;
    assert.deepEqual(
      parseInbound('request_code', uri),
      { ok: true, message: { intent: 'request_code', uri } },
      key,
    );
  }
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
// Cross-repo parity. The two lists below are duplicated ENTRY FOR ENTRY in the
// app's `__tests__/protocol-parity.test.ts` - same payloads, same order, same
// `REQUIRED` spelling - so a diff of the two files shows the contract drifting.
// Change one list, change the other. Cases that only this side has a use for
// live in `LOCAL_REFUSED` below, which is deliberately NOT shared.
//
// The two validators are deliberately different in scope - this server checks
// far less, because chain and coin names come from a registry that updates
// without a server deploy - but where both have an opinion they must agree. A
// payload one accepts and the other refuses is either a code that mints and
// never redeems, or a merchant whose POS mints nothing with no diagnosable
// reason. Every divergence in these lists was found by measurement, not by
// reading: duplicate keys, percent-encoded values, the line-terminator set,
// amount shape, hostile text outside the lifted fields, and the line cap.
// ---------------------------------------------------------------------------

const REQUIRED = `&orderid=${ORDER}&nostr=${NPUB}`;

const PARITY_ACCEPTED: readonly string[] = [
  `defito://base/0xabc&amount=USDT:1${REQUIRED}`,
  `defito://base/0xabc&amount=USDT${REQUIRED}`, // amount value optional
  `defito://avalanche,base,tron/0xabc,TJRxyz&amount=USDT,USDC:123.45${REQUIRED}`,
  `defito://base/0xabc&amount=USDT:1${REQUIRED}\ndefito://tron/TJRxyz&amount=USDT:1${REQUIRED}`,
  `DeFiTo://base/0xAbC&Amount=USDT:1&OrderId=${ORDER}&NOSTR=${NPUB}`, // key case
  // The accepted side of the line cap. `21 refuses` alone would still pass if
  // a regression tightened MAX_PAYLOAD_LINES to 5; this is the half that costs
  // a merchant a code they can mint and nobody can redeem.
  Array.from({ length: 20 }, () => `defito://base/0xabc&amount=USDT:1${REQUIRED}`).join('\n'),
];

const PARITY_REFUSED: readonly string[] = [
  `defito://base/0xabc&amount=USDT:1&nostr=${NPUB}`, // no orderid
  `defito://base/0xabc&amount=USDT:1&orderid=${ORDER}`, // no nostr
  `defito://base/0xabc&orderid=${ORDER}&nostr=${NPUB}`, // no amount
  `defito://base&amount=USDT:1${REQUIRED}`, // no recipient
  `defito://${REQUIRED}`, // no path at all
  'defito://', // scheme only
  `defipay://base/0xabc&amount=USDT:1${REQUIRED}`, // the scheme defito replaced
  `defifrom://base/0xabc&amount=USDT:1${REQUIRED}&tx=0xdead`, // never brokered
  'https://evil.test',
  `defito://base/0xabc&amount=USDT:1${REQUIRED}\rhttps://evil.test`, // lone CR
  `defito://base/0xabc&amount=USDT:1${REQUIRED} https://evil.test`,
  `defito://base/0xabc&amount=&amount=USDT:5${REQUIRED}`, // first key wins, empty
  `defito://base/0xabc&amount=USDT:1&orderid=${ORDER}&nostr=&nostr=${NPUB}`,
  // A hostile value in a presence-checked field. The app drops it in
  // `parseUriParams`; the middleware screens it in `param` for the same reason.
  `defito://base/0xabc&amount=USDT:1&orderid=%3Cscript%3E&nostr=${NPUB}`,
  `defito://base/0xabc&amount=USDT:1&orderid=%E2%80%AE${ORDER}&nostr=${NPUB}`,
  `defito://base/0xabc&amount=USDT:1${REQUIRED}\nhttps://evil.test`,
  // --- amount SHAPE. The coin list is required and a trailing colon is a
  // truncated value, not an amount-less request. Both sides refuse all three.
  `defito://base/0xabc&amount=USDT:${REQUIRED}`,
  `defito://base/0xabc&amount=:5${REQUIRED}`,
  `defito://base/0xabc&amount=,,,:5${REQUIRED}`,
  // --- hidden characters anywhere in the payload, including the path segments.
  // One gate does this - `isHostileText` over the whole string, raw AND decoded
  // - so position is irrelevant; these pin that a spoofed address or network
  // word is covered by it too.
  `defito://base/0xab\u200Bc&amount=USDT:1${REQUIRED}`,
  `defito://ba\u202Ese/0xabc&amount=USDT:1${REQUIRED}`,
  // --- hostile text in an EXTRA parameter. Refused by that same whole-payload
  // screen, not by anything per-field: being unlifted buys an attacker nothing.
  `defito://base/0xabc&amount=USDT:1${REQUIRED}&message=%3Cscript%3E`,
  // --- line count. MAX_PAYLOAD_LINES is 20 on both sides; 21 must refuse
  // rather than silently losing the overflow.
  Array.from({ length: 21 }, () => `defito://base/0xabc&amount=USDT:1${REQUIRED}`).join('\n'),
];

/**
 * Refused here and by the app, but NOT part of the shared list: each one is the
 * mirror image of a shared fixture (the same screen, the other position or the
 * undecoded spelling), so duplicating them across repos would buy coverage
 * neither side lacks.
 */
const LOCAL_REFUSED: readonly string[] = [
  `defito://ba\u200Bse/0xabc&amount=USDT:1${REQUIRED}`, // ZWSP in the network word
  `defito://base/0x\u202Eabc&amount=USDT:1${REQUIRED}`, // RLO in the recipient
  `defito://base/0xabc&amount=USDT:1${REQUIRED}&message=<script>`, // undecoded
  `defito://,,,/0xabc&amount=USDT:1${REQUIRED}`, // a comma list naming nothing
  `defito://base/0xabc&amount=USDT:1${REQUIRED}\u2028https://evil.test`,
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
  for (const payload of [...PARITY_REFUSED, ...LOCAL_REFUSED]) {
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
  // Right scheme, wallet-refusing payload: also a broken client, not a foreign
  // scheme aimed at us, so it must not cost the sender a day of lockout.
  assert.equal(reasonOf(`defito://base/0xabc&amount=USDT:&orderid=${ORDER}&nostr=${NPUB}`), 'malformed');
  assert.equal(
    reasonOf(`defito://base/0xabc&amount=USDT:1&orderid=${ORDER}&nostr=${NPUB}&message=<script>`),
    'malformed',
  );
});

test('parity: a percent-encoded npub is read the same way as a plain one', () => {
  // `%6E` is `n`. The app percent-decodes parameter values, so it saw a valid
  // npub here while this server saw the raw escape and answered `malformed`.
  const encoded = `defito://base/0xabc&amount=USDT:1&orderid=${ORDER}&nostr=${NPUB.replace(/^n/, '%6E')}`;
  assert.equal(parseInbound('request_code', encoded).ok, true);
});
