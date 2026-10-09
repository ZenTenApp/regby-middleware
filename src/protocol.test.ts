import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nprofileEncode } from 'nostr-tools/nip19';

import {
  extractIntent,
  parseInbound,
  isValidPaymentUri,
  validUntilOf,
  DEFITO_PREFIX,
  MAX_PAYLOAD_LINES,
  REPLY_REASON,
} from './protocol.ts';

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

// A real npub, the hex it decodes to, and an nprofile for the same key. The
// shape check decodes `nostr=`, so a placeholder will not do.
const NPUB = 'npub1e2yuky03caw4ke3zy68lg0fz3r4gkt94hx4fjmlelacyljgyk79svn3eef';
const PUBKEY_HEX = 'ca89cb11f1c75d5b6622268ff43d2288ea8b2cb5b9aa996ff9ff704fc904b78b';
const NPROFILE = nprofileEncode({ pubkey: PUBKEY_HEX });
// 32 hex chars, no dashes - the shape the app mints. Opaque to this server.
const ORDER = '9f2c14ab7e5d4083b6a1cc90de3f7721';
// Unix seconds. Only the SHAPE is checked here, never whether it has passed
// (that is the wallet's call), so the value need not stay in the future.
const VALID_UNTIL = 1795219200;
// Every required field after `amount`. Shared spelling with the app's parity
// file (see the cross-repo parity block below).
const REQUIRED = `&order_id=${ORDER}&valid_until=${VALID_UNTIL}&nostr=${NPUB}`;
// A minimal payload the wallet redeems; tests vary it one field at a time.
const GOOD = `defito://base/0xabc&amount=USDT:1${REQUIRED}`;

test('the shared constants are the values the app builds against', () => {
  // Lockstep with the app is otherwise carried by prose alone, and a silent
  // edit on either side mints codes the other refuses. This suite cannot see
  // that repo, and the parity lists below spell 20 and 21 literally because
  // they are copied from the app's file - so pin what it can.
  assert.equal(DEFITO_PREFIX, 'defito://');
  assert.equal(MAX_PAYLOAD_LINES, 20);
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

test('isValidPaymentUri: a bare scheme is an empty rail, not a foreign one', () => {
  // It carries our scheme, so it clears the gate that earns a 24 h blacklist
  // and is judged with the rest. The old check refused it HERE, which billed a
  // POS that rendered one empty rail for a day of lockout - measured against
  // the app, which redeems such a payload from its remaining rails.
  assert.equal(isValidPaymentUri('defito://'), true);
  // Nothing redeemable in it, so it is still refused - just as a broken client,
  // which is what it is.
  assert.deepEqual(parseInbound('request_regby_code', 'defito://'), {
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

test('parseInbound: request_regby_code returns the raw uri', () => {
  const uri = GOOD;
  assert.deepEqual(parseInbound('request_regby_code', uri), {
    ok: true,
    message: { intent: 'request_regby_code', uri },
  });
  // The stored value is the plaintext verbatim - we never normalise a payload
  // we hand back to a wallet that will parse it strictly.
  const mixedCase = `DeFiTo://base/0xAbC&Amount=USDT:1&Order_Id=${ORDER}&Valid_Until=${VALID_UNTIL}&NOSTR=${NPUB}`;
  assert.deepEqual(parseInbound('request_regby_code', mixedCase), {
    ok: true,
    message: { intent: 'request_regby_code', uri: mixedCase },
  });
});

test('parseInbound: request_regby_code with a non-payment payload is malicious', () => {
  assert.deepEqual(parseInbound('request_regby_code', 'https://evil.test'), {
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
    assert.deepEqual(
      parseInbound('request_regby_code', uri),
      { ok: false, reason: 'malformed' },
      uri,
    );

  malformed(`defito://base/0xabc&amount=USDT:1&order_id=${ORDER}&valid_until=${VALID_UNTIL}`); // no nostr
  malformed(`defito://base/0xabc${REQUIRED}`); // no amount
  // Without an order id the confirmation that settles this invoice has nothing
  // to echo, so the merchant could never match the payment to the order.
  malformed(`defito://base/0xabc&amount=USDT:1&valid_until=${VALID_UNTIL}&nostr=${NPUB}`);
  // Without a valid_until the wallet drops the line. Its SHAPE cases live in
  // the parity list below.
  malformed(`defito://base/0xabc&amount=USDT:1&order_id=${ORDER}&nostr=${NPUB}`);
  malformed(`defito://base&amount=USDT:1${REQUIRED}`); // no recipient
  malformed(`defito://base/&amount=USDT:1${REQUIRED}`); // empty recipient
  malformed(`defito:///0xabc&amount=USDT:1${REQUIRED}`); // empty network
  malformed(`defito://base/0xabc`); // no params at all
  // EVERY rail has to be unredeemable, not just one: see the rails test below.
  malformed(`defito://base/0xabc\ndefito://tron/Tabc&amount=USDT:1`);
});

test('parseInbound: one broken rail does not sink the payload', () => {
  // Measured against the app: `parseDirectPay` drops a rail it cannot parse and
  // pays from the rest, so refusing here cost the merchant a code the customer
  // could have paid, over a rail the wallet was never going to show.
  const good = GOOD;
  for (const broken of ['defito://', 'defito://tron/Tabc&amount=USDT:1']) {
    const uri = `${good}\n${broken}`;
    assert.deepEqual(
      parseInbound('request_regby_code', uri),
      { ok: true, message: { intent: 'request_regby_code', uri } },
      uri,
    );
  }
});

test('parseInbound: padding is bounded even though the grammar is judged trimmed', () => {
  // The grammar bound is measured TRIMMED, to agree with the app - but we store
  // `content` verbatim, so whitespace is only free up to the storage bound.
  const good = GOOD;
  assert.equal(parseInbound('request_regby_code', `${' '.repeat(3000)}${good}`).ok, true);
  assert.deepEqual(parseInbound('request_regby_code', `${' '.repeat(9000)}${good}`), {
    ok: false,
    reason: 'silent',
  });
});

test('parseInbound: the wallet trims before it screens, so we do too', () => {
  // A trailing BOM is a hidden character until `trim` removes it, and the app
  // trims first. Screening the untrimmed payload refused one it accepts.
  const uri = `${GOOD}\uFEFF`;
  assert.deepEqual(parseInbound('request_regby_code', uri), {
    ok: true,
    // Stored VERBATIM: we validate the trimmed payload and keep what was sent.
    message: { intent: 'request_regby_code', uri },
  });
});

test('parseInbound: nostr is read as leniently as the app reads it', () => {
  // `parseNostrIdentifier` strips a `nostr:` prefix and lowercases before the
  // bech32 decode, so both of these build payloads the wallet pays.
  for (const key of [`nostr:${NPUB}`, `N${NPUB.slice(1)}`]) {
    const uri = `defito://base/0xabc&amount=USDT:1&order_id=${ORDER}&valid_until=${VALID_UNTIL}&nostr=${key}`;
    assert.deepEqual(
      parseInbound('request_regby_code', uri),
      { ok: true, message: { intent: 'request_regby_code', uri } },
      key,
    );
  }
});

test('parseInbound: nostr must be a decodable identity key', () => {
  const malformed = (npub: string) =>
    assert.deepEqual(
      parseInbound(
        'request_regby_code',
        `defito://base/0xabc&amount=USDT:1&order_id=${ORDER}&valid_until=${VALID_UNTIL}&nostr=${npub}`,
      ),
      { ok: false, reason: 'malformed' },
      npub,
    );
  malformed('npub1x'); // truncated
  malformed(`${NPUB.slice(0, -1)}q`); // bad checksum
  malformed('office@coffeeshop.com'); // a recipient to look up, not a key
  malformed(PUBKEY_HEX); // bare hex has a tx hash's shape
  // `nprofile` carries a key too and the app accepts it, so we must as well or
  // we would refuse a payload the wallet built.
  const withNprofile = `defito://base/0xabc&amount=USDT:1&order_id=${ORDER}&valid_until=${VALID_UNTIL}&nostr=${NPROFILE}`;
  assert.deepEqual(parseInbound('request_regby_code', withNprofile), {
    ok: true,
    message: { intent: 'request_regby_code', uri: withNprofile },
  });
});

test('parseInbound: whitespace-only request_regby_code is silent, not malicious', () => {
  // `malicious` costs the sender a 24 h blacklist. Three spaces from a buggy
  // client is noise; the empty-content guard already treats "no payload" that
  // way, and a payload that is only whitespace is the same thing.
  assert.deepEqual(parseInbound('request_regby_code', '   '), { ok: false, reason: 'silent' });
  assert.deepEqual(parseInbound('request_regby_code', '\n\n'), { ok: false, reason: 'silent' });
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

test('extractIntent rejects the outbound intents echoed back at us', () => {
  // `regby_code`/`regby_content` are reply intents. The server must never
  // process them inbound, so extractIntent (the sole inbound gate) drops them
  // before parseInbound.
  assert.equal(extractIntent([['i', 'regby_code']]), null);
  assert.equal(extractIntent([['i', 'regby_content']]), null);
});

test('extractIntent rejects the pre-rename intents', () => {
  // Renamed, not aliased: a stale client gets no reply rather than a half-
  // understood one.
  for (const old of ['request_code', 'request_uri', 'code', 'uri']) {
    assert.equal(extractIntent([['i', old]]), null, old);
  }
});

test('parseInbound: oversized content dropped silently', () => {
  // Silent regardless of intent (no blacklist on a size flood).
  assert.deepEqual(
    parseInbound(
      'request_regby_code',
      `defito://a/b&amount=x&order_id=${ORDER}&valid_until=${VALID_UNTIL}&nostr=` + 'a'.repeat(5000),
    ),
    { ok: false, reason: 'silent' },
  );
});

// ---------------------------------------------------------------------------
// Cross-repo parity. The two lists below hold the same payloads in the same
// order as the app's `__tests__/protocol-parity.test.ts`, with the same
// `REQUIRED` spelling (declared at the top here), so the two files read side
// by side and a payload added to one is visibly missing from the other. Change one list, change the other.
// The ONE textual difference is deliberate: where the app writes a raw U+2028
// into its source, this file writes the `\u2028` escape, because an invisible
// line separator in a source file is a trap for the next editor. Cases only
// this side has a use for live in `LOCAL_REFUSED` below, which is not shared.
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

const PARITY_ACCEPTED: readonly string[] = [
  `defito://base/0xabc&amount=USDT:1${REQUIRED}`,
  `defito://base/0xabc&amount=USDT${REQUIRED}`, // amount value optional
  `defito://avalanche,base,tron/0xabc,TJRxyz&amount=USDT,USDC:123.45${REQUIRED}`,
  `defito://base/0xabc&amount=USDT:1${REQUIRED}\ndefito://tron/TJRxyz&amount=USDT:1${REQUIRED}`,
  `DeFiTo://base/0xAbC&Amount=USDT:1&Order_Id=${ORDER}&Valid_Until=${VALID_UNTIL}&NOSTR=${NPUB}`, // key case
  // The accepted side of the line cap. `21 refuses` alone would still pass if
  // a regression tightened MAX_PAYLOAD_LINES to 5; this is the half that costs
  // a merchant a code they can mint and nobody can redeem.
  Array.from({ length: 20 }, () => `defito://base/0xabc&amount=USDT:1${REQUIRED}`).join('\n'),
];

const PARITY_REFUSED: readonly string[] = [
  `defito://base/0xabc&amount=USDT:1&valid_until=${VALID_UNTIL}&nostr=${NPUB}`, // no order_id
  `defito://base/0xabc&amount=USDT:1&orderid=${ORDER}&valid_until=${VALID_UNTIL}&nostr=${NPUB}`, // retired spelling
  `defito://base/0xabc&amount=USDT:1&order_id=${ORDER}&nostr=${NPUB}`, // no valid_until
  // --- valid_until SHAPE: unix seconds as a plain positive integer.
  `defito://base/0xabc&amount=USDT:1&order_id=${ORDER}&valid_until=&nostr=${NPUB}`,
  `defito://base/0xabc&amount=USDT:1&order_id=${ORDER}&valid_until=0&nostr=${NPUB}`,
  `defito://base/0xabc&amount=USDT:1&order_id=${ORDER}&valid_until=1e9&nostr=${NPUB}`,
  `defito://base/0xabc&amount=USDT:1&order_id=${ORDER}&valid_until=-60&nostr=${NPUB}`,
  `defito://base/0xabc&amount=USDT:1&order_id=${ORDER}&valid_until=tomorrow&nostr=${NPUB}`,
  `defito://base/0xabc&amount=USDT:1&order_id=${ORDER}&valid_until=${VALID_UNTIL}`, // no nostr
  `defito://base/0xabc&order_id=${ORDER}&valid_until=${VALID_UNTIL}&nostr=${NPUB}`, // no amount
  `defito://base&amount=USDT:1${REQUIRED}`, // no recipient
  `defito://${REQUIRED}`, // no path at all
  'defito://', // scheme only
  `defipay://base/0xabc&amount=USDT:1${REQUIRED}`, // the scheme defito replaced
  `defifrom://base/0xabc&amount=USDT:1${REQUIRED}&tx=0xdead`, // never brokered
  'https://evil.test',
  `defito://base/0xabc&amount=USDT:1${REQUIRED}\rhttps://evil.test`, // lone CR
  `defito://base/0xabc&amount=USDT:1${REQUIRED}\u2028https://evil.test`,
  `defito://base/0xabc&amount=&amount=USDT:5${REQUIRED}`, // first key wins, empty
  `defito://base/0xabc&amount=USDT:1&order_id=${ORDER}&valid_until=${VALID_UNTIL}&nostr=&nostr=${NPUB}`,
  // A hostile value in a presence-checked field. The app drops it in
  // `parseUriParams`; the middleware screens it in `param` for the same reason.
  `defito://base/0xabc&amount=USDT:1&order_id=%3Cscript%3E&valid_until=${VALID_UNTIL}&nostr=${NPUB}`,
  `defito://base/0xabc&amount=USDT:1&order_id=%E2%80%AE${ORDER}&valid_until=${VALID_UNTIL}&nostr=${NPUB}`,
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
 * Refused here and by the app, but kept out of the shared list: each is either
 * the other position or the other spelling of a screen the shared list already
 * pins, so copying it into the app's file would buy coverage neither side
 * lacks. `,,,/0xabc` is the one that earns its place on its own - it is the
 * only case exercising `csv()` on a network half that is all separators.
 */
const LOCAL_REFUSED: readonly string[] = [
  `defito://ba\u200Bse/0xabc&amount=USDT:1${REQUIRED}`, // ZWSP in the network word
  `defito://base/0x\u202Eabc&amount=USDT:1${REQUIRED}`, // RLO in the recipient
  `defito://base/0xabc&amount=USDT:1${REQUIRED}&message=<script>`, // undecoded
  `defito://,,,/0xabc&amount=USDT:1${REQUIRED}`, // a comma list naming nothing
  `defito://base/0xabc&amount=USDT:1${REQUIRED} https://evil.test`, // space, no break
];

test('parity: every payload the app parses, this server mints', () => {
  for (const payload of PARITY_ACCEPTED) {
    assert.deepEqual(
      parseInbound('request_regby_code', payload),
      { ok: true, message: { intent: 'request_regby_code', uri: payload } },
      payload,
    );
  }
});

test('parity: every payload the app refuses, this server refuses', () => {
  for (const payload of [...PARITY_REFUSED, ...LOCAL_REFUSED]) {
    const result = parseInbound('request_regby_code', payload);
    assert.equal(result.ok, false, `should be refused: ${JSON.stringify(payload)}`);
  }
});

test('parity: a refusal keeps the right VERDICT, not merely ok:false', () => {
  // The two verdicts cost the sender different things - `malicious` is a 24 h
  // blacklist, `malformed` is a reply - so a payload drifting between them is a
  // real regression that an `ok === false` assertion cannot see.
  const reasonOf = (payload: string) => {
    const result = parseInbound('request_regby_code', payload);
    return result.ok ? 'ok' : result.reason;
  };
  // Wrong scheme aimed at us after proving key possession: deliberate.
  assert.equal(reasonOf('https://evil.test'), 'malicious');
  assert.equal(reasonOf(`defipay://base/0xabc&amount=USDT:1${REQUIRED}`), 'malicious');
  assert.equal(reasonOf(`defifrom://base/0xabc&amount=USDT:1${REQUIRED}`), 'malicious');
  // Right scheme, field missing: a broken client, and no blacklist.
  assert.equal(reasonOf(`defito://base/0xabc&amount=USDT:1&valid_until=${VALID_UNTIL}&nostr=${NPUB}`), 'malformed');
  assert.equal(reasonOf(`defito://base/0xabc${REQUIRED}`), 'malformed');
  assert.equal(reasonOf(`defito://base&amount=USDT:1${REQUIRED}`), 'malformed');
  // Right scheme, wallet-refusing payload: also a broken client, not a foreign
  // scheme aimed at us, so it must not cost the sender a day of lockout.
  assert.equal(reasonOf(`defito://base/0xabc&amount=USDT:${REQUIRED}`), 'malformed');
  assert.equal(
    reasonOf(`defito://base/0xabc&amount=USDT:1${REQUIRED}&message=<script>`),
    'malformed',
  );
});

test('parity: a percent-encoded npub is read the same way as a plain one', () => {
  // `%6E` is `n`. The app percent-decodes parameter values, so it saw a valid
  // npub here while this server saw the raw escape and answered `malformed`.
  const encoded = `defito://base/0xabc&amount=USDT:1&order_id=${ORDER}&valid_until=${VALID_UNTIL}&nostr=${NPUB.replace(/^n/, '%6E')}`;
  assert.equal(parseInbound('request_regby_code', encoded).ok, true);
});

test('a percent-encoded valid_until is read decoded, like every other value', () => {
  // `%31` is `1`. `param` decodes before the shape check, as the app does, so
  // an escaped digit passes and an escaped sign (`%2B` → `+`) still refuses.
  const withExpiry = (value: string): string =>
    `defito://base/0xabc&amount=USDT:1&order_id=${ORDER}&valid_until=${value}&nostr=${NPUB}`;
  assert.equal(parseInbound('request_regby_code', withExpiry(`%31${VALID_UNTIL}`)).ok, true);
  assert.deepEqual(parseInbound('request_regby_code', withExpiry(`%2B${VALID_UNTIL}`)), {
    ok: false,
    reason: 'malformed',
  });
});

// What NIP-04 decrypt hands us for encrypted BYTES: nostr-tools decodes the
// plaintext with a non-fatal UTF-8 decoder, so bytes arrive as a string.
function asDecrypted(bytes: readonly number[]): string {
  return new TextDecoder().decode(Uint8Array.from(bytes));
}
const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d];

test('binary content is dropped before any other screen, on both intents', () => {
  const png = asDecrypted(PNG_HEADER);
  assert.deepEqual(parseInbound('request_regby_code', png), { ok: false, reason: 'binary' });
  assert.deepEqual(parseInbound('request_regby_content', png), { ok: false, reason: 'binary' });
  // Bytes behind a valid-looking invoice are still bytes: no reply, no audit.
  assert.deepEqual(parseInbound('request_regby_code', `${GOOD}&x=\u0000\u0001`), {
    ok: false,
    reason: 'binary',
  });
  // An invalid UTF-8 byte inside a value surfaces as U+FFFD.
  const withBadByte = GOOD + asDecrypted([0x26, 0x78, 0x3d, 0xc3, 0x28]); // "&x=" + broken 2-byte seq
  assert.ok(withBadByte.includes('\uFFFD'));
  assert.deepEqual(parseInbound('request_regby_code', withBadByte), { ok: false, reason: 'binary' });
  assert.deepEqual(parseInbound('request_regby_content', '4289\u00001337'), {
    ok: false,
    reason: 'binary',
  });
  // Precedence over the blacklist: a foreign scheme carrying bytes is dropped,
  // not punished as `malicious`.
  assert.deepEqual(parseInbound('request_regby_code', 'javascript:x\u0000'), {
    ok: false,
    reason: 'binary',
  });
});

test('real text is never read as binary', () => {
  // Each case pins its full verdict, so a text screen that starts refusing
  // real merchant input fails here too, not only a binary misread.
  const cases: readonly { text: string; ok: boolean }[] = [
    // Whitespace controls are text: line breaks split rails, trim takes the rest.
    { text: `${GOOD}\r\n${GOOD}\t\u000B\u000C`, ok: true },
    // Non-ASCII text is valid UTF-8, not bytes.
    { text: `${GOOD}&message=caf\u00e9 \u2615`, ok: true },
    // An ESCAPED NUL is text: it still earns `malformed` and a reply.
    { text: `${GOOD}&x=%00`, ok: false },
  ];
  for (const { text, ok } of cases) {
    const result = parseInbound('request_regby_code', text);
    if (ok) assert.equal(result.ok, true, JSON.stringify(text));
    else assert.deepEqual(result, { ok: false, reason: 'malformed' }, JSON.stringify(text));
  }
});

// Cross-repo parity for failure-reply text: the same list, in the same order,
// as `APP_REASONS` in the app's `__tests__/protocol-parity.test.ts`. A reason
// this server sends that the app does not list renders there as a generic
// error - which is how a renamed reason once nearly shipped unreadable.
const PARITY_REPLY_REASONS: readonly string[] = [
  'Code Not Found',
  'Code Expired',
  'Code Already Redeemed',
  'Service Busy, Try Again',
  'Invalid Request',
];

test('parity: every failure reason this server sends is on the app allowlist', () => {
  assert.deepEqual(Object.values(REPLY_REASON), PARITY_REPLY_REASONS);
});

test('validUntilOf: earliest well-formed valid_until across rails, for the audit', () => {
  const rail = (until: string): string =>
    `defito://base/0xabc&amount=USDT:1&order_id=${ORDER}&valid_until=${until}&nostr=${NPUB}`;
  assert.equal(validUntilOf(rail('1795219200')), 1795219200);
  // Ranked rails can disagree; the request lapses with the first of them.
  assert.equal(validUntilOf(`${rail('1795219300')}\n${rail('1795219200')}`), 1795219200);
  // A malformed value is skipped, never read as a number.
  assert.equal(validUntilOf(`${rail('soon')}\n${rail('1795219300')}`), 1795219300);
  assert.equal(validUntilOf(rail('0')), null);
  assert.equal(validUntilOf('defito://base/0xabc&amount=USDT:1&order_id=x'), null);
  // A foreign scheme is never read as an invoice.
  assert.equal(validUntilOf('evil://xxxxbase/0x&valid_until=1795219200'), null);
});
