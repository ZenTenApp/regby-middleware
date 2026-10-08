/**
 * ReGBY wire protocol - the single source of truth for the encrypted DM shapes
 * exchanged between the app and this middleman, mirroring `utils/regby.ts` in
 * the wallet app.
 *
 * Transport is a standard encrypted **DM (kind 4)** so events are treated as
 * messages. Design:
 *   - `content` is the **raw value**, NIP-04 encrypted: a `defito://`
 *     payment-request URI (possibly multi-line / multi-option) or the bare
 *     eight-digit code. No JSON wrapper. A `defifrom://` confirmation never
 *     passes through here - see `DEFITO_PREFIX`.
 *   - the message **intent** rides a plaintext `['i', <intent>]` tag -
 *     single-letter `i` is relay-indexable, so the server subscribes
 *     `#i:INBOUND_INTENTS` and pulls only inbound regby traffic.
 *   - replies carry `['e', <request-event-id>]` (Nostr-native reply linkage)
 *     so the client matches a reply to the request it published - no in-band
 *     correlation id needed.
 *   - there is **no `error` intent**. A failure reply reuses the success intent
 *     (`regby_code` for a `request_regby_code`, `regby_content` for a
 *     `request_regby_content`) and carries the reason string in `content`
 *     instead of a value. The client tells a value from an error by the
 *     content's SHAPE (8 digits / a `defito://` prefix)
 *     and whitelist-sanitises anything else - the middleman is untrusted, so a
 *     free `error` text channel was just a hole for arbitrary text into the UI.
 *   - relay retention is bounded by NIP-40 `['expiration', unixSec]`.
 *
 * Tags are covered by the event signature, so intent/linkage are authenticated.
 * Only the URI/code lives in the ciphertext.
 */

import { decode } from 'nostr-tools/nip19';

/** Encrypted DM kind: NIP-04 envelope and NIP-04 ciphertext, which is what
 *  every client reading these relays expects under this kind. */
export const REGBY_KIND = 4;

/**
 * The one scheme this server brokers: a `defito://` payment request, which a
 * merchant mints a code for and a customer redeems.
 *
 * A `defifrom://` payment CONFIRMATION is deliberately not accepted. It is sent
 * straight to the npub named in the invoice it answers, so there is nothing for
 * a middleman to do: this broker exists to squeeze an invoice into eight digits
 * a customer can type, and nobody types a confirmation. Accepting one here
 * would mean holding the plaintext of a settled payment for no reason.
 *
 * `protocol.test.ts` pins the value so an edit fails loudly: the app builds
 * against the same word, and a payload it builds that we reject is a code the
 * merchant can never mint.
 */
export const DEFITO_PREFIX = 'defito://';

/**
 * Line terminators we split a multi-line payload on. Deliberately WIDER than
 * the `\r?\n` a wallet writes: "every line is an invoice" is only a real
 * guarantee if nothing else can start a line. A lone `\r` used to slip a
 * second, foreign-scheme line past the check inside what this file counted as
 * one line, which is exactly the payload the rule exists to refuse.
 */
const LINE_BREAK_RE = /\r\n|[\n\r\u2028\u2029]/;

/** Codes are exactly eight decimal digits. */
export const REGBY_CODE_RE = /^\d{8}$/;

/** Upper bound on decrypted content we accept, measured TRIMMED as the app
 *  measures it (multi-line URIs included). Mirrors `MAX_REDEEMED_URI_CHARS` in
 *  the app's `utils/regby.ts`. */
export const MAX_CONTENT_LENGTH = 4096;

/**
 * Upper bound on what we STORE. The grammar bound above is measured trimmed,
 * because that is the string the wallet judges - but we keep `content`
 * verbatim, so without this a sender pads 4096 valid characters with unlimited
 * whitespace and we persist all of it. The slack is deliberate: padding is a
 * broken emitter long before it is an attack, and the trimmed bound is the one
 * that has to agree with the app.
 */
const MAX_STORED_LENGTH = MAX_CONTENT_LENGTH * 2;

/**
 * Cap on the LINES of one payload. Mirrors `MAX_PAYLOAD_LINES` in the app's
 * `utils/payment-uri.ts`: past this the wallet refuses the payload outright, so
 * minting a code for it hands the merchant an eight-digit number that can never
 * be redeemed.
 */
export const MAX_PAYLOAD_LINES = 20;

/** Intent tag key. */
export const INTENT_TAG = 'i';

/** Inbound intents as a value list. Feeds the relay `#i` subscription filter
 *  and `extractIntent`, so the type and the runtime check cannot drift. */
export const INBOUND_INTENTS = ['request_regby_code', 'request_regby_content'] as const;

/** The two intents the middleman accepts from clients. */
export type InboundIntent = (typeof INBOUND_INTENTS)[number];

/** The success intent that answers each inbound request (reused for errors). */
export const REPLY_INTENT = {
  request_regby_code: 'regby_code',
  request_regby_content: 'regby_content',
} as const satisfies Record<InboundIntent, string>;

/** The two intents the middleman emits; a failure reuses the matching one. */
export type OutboundIntent = (typeof REPLY_INTENT)[InboundIntent];

/** A validated inbound message: a merchant code request, or a customer redeem. */
export type InboundMessage =
  | { intent: 'request_regby_code'; uri: string }
  | { intent: 'request_regby_content'; code: string };

/**
 * Outcome of parsing decrypted inbound content. The three verdicts differ by
 * what they cost the SENDER, so what separates them is evidence of intent.
 *  - `ok`        → a well-formed message to dispatch.
 *  - `malicious` → decrypt succeeded (a real, targeted message) but a
 *    `request_regby_code` carried a payload that is not `defito://`. The sender
 *    proved they hold the conversation key, so aiming a foreign scheme at us is
 *    deliberate → caller replies on the reused success intent (`regby_code`,
 *    content = reason) AND blacklists the sender for 24 h.
 *  - `malformed` → `defito://`, but the wallet would refuse it at redeem: NO
 *    rail carries the required fields in the shapes the grammar fixes, or a
 *    payload-level screen fails (hostile text, more lines than the wallet
 *    parses). Caller replies with the same reason and does NOT blacklist: this
 *    is a broken client, not an attacker, and a 24 h
 *    lockout is the wrong answer to a merchant whose POS built a bad string.
 *  - `silent`    → junk we drop without a reply (empty/oversized, malformed
 *    code shape, or an outbound intent echoed back at us).
 */
export type ParseResult =
  | { ok: true; message: InboundMessage }
  | { ok: false; reason: 'malicious' | 'malformed' | 'silent' };

/**
 * Read the inbound intent from an event's tags. Returns the first recognised
 * `['i', 'request_regby_code' | 'request_regby_content']`, or null when
 * absent/unknown. The two outbound intents (`regby_code`/`regby_content`) are
 * NOT accepted here, so an echoed-back reply never enters processing.
 */
export function extractIntent(tags: string[][]): InboundIntent | null {
  for (const tag of tags) {
    if (tag[0] !== INTENT_TAG) continue;
    const match = INBOUND_INTENTS.find((intent) => intent === tag[1]);
    if (match) return match;
  }
  return null;
}

/**
 * Validate decrypted `content` for an inbound intent. A `request_regby_code` whose
 * payload is not `defito://` is `malicious` (see ParseResult) so the caller can
 * blacklist the sender; one that IS `defito://` but that the wallet would
 * refuse at redeem is `malformed` and is NOT blacklisted; a malformed code
 * shape is dropped `silent`.
 */
export function parseInbound(intent: InboundIntent, content: string): ParseResult {
  // Every judgement below is made on the TRIMMED payload, because that is the
  // string the wallet judges (`sanitizeRedeemedUri` trims before it screens or
  // measures). Screening the untrimmed one refused payloads the wallet takes:
  // a trailing BOM is a hidden character until `trim` removes it, and a payload
  // that fits 4096 only after trimming was dropped silently. What we STORE is
  // still `content` verbatim - see `isValidPaymentUri`.
  const trimmed = content.trim();
  // `malicious` costs the sender a 24 h blacklist, and three spaces from a
  // buggy client is noise, not proof of deliberate abuse. Only a payload with
  // something in it can earn that.
  if (trimmed.length === 0 || trimmed.length > MAX_CONTENT_LENGTH) {
    return { ok: false, reason: 'silent' };
  }
  if (content.length > MAX_STORED_LENGTH) return { ok: false, reason: 'silent' };

  if (intent === 'request_regby_code') {
    // Two questions, two punishments: "is this even ours" (a foreign scheme is
    // deliberate) then "would the wallet take it" (anything it refuses is a
    // broken client).
    if (!isValidPaymentUri(trimmed)) return { ok: false, reason: 'malicious' };
    if (!wouldRedeem(trimmed)) return { ok: false, reason: 'malformed' };
    return { ok: true, message: { intent, uri: content } };
  }

  // request_regby_content
  if (!REGBY_CODE_RE.test(trimmed)) return { ok: false, reason: 'silent' };
  return { ok: true, message: { intent, code: trimmed } };
}

/**
 * An invoice payload is one or more line-separated lines, every non-empty one a
 * `defito://` URI. The multiple lines are the merchant's ranked fallback rails
 * for ONE order, so they should share an `order_id` (not compared here).
 *
 * Only the scheme is checked here; the rest lives in `wouldRedeem`. A line
 * that is ONLY the scheme carries the scheme, so it passes THIS gate and is
 * judged there - it is an empty rail, not a foreign one, and an empty rail must
 * never cost a merchant the 24 h blacklist a foreign scheme earns.
 *
 * Note what this normalises is not what `parseInbound` stores: validation trims
 * and lowercases each line, storage keeps `content` verbatim. That is on
 * purpose. Case is meaningful (base58 and EVM checksum addresses), and a URI
 * the merchant may one day SIGN must survive us byte for byte, so we must not
 * rewrite a payload we only ever needed to screen. The wallet re-trims on
 * receipt.
 */
export function isValidPaymentUri(content: string): boolean {
  const lines = payloadLines(content).map((l) => l.toLowerCase());
  if (lines.length === 0) return false;
  return lines.every((l) => l.startsWith(DEFITO_PREFIX));
}

/** Trimmed non-empty lines, split on every terminator in `LINE_BREAK_RE`. */
function payloadLines(content: string): string[] {
  return content
    .split(LINE_BREAK_RE)
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Everything beyond the scheme that decides whether the WALLET will accept this
 * payload at redeem: the payload-level screens, then the per-line grammar.
 * Checked separately from the scheme because it earns a softer verdict (see
 * ParseResult).
 *
 * Each screen here mirrors one in the app (`sanitizeRedeemedUri` in
 * `utils/regby.ts`, `parseDeFiToFields` in `utils/payment-uri.ts`). A payload
 * that passes here and fails there is a code that mints and never redeems, with
 * no reason the merchant can act on.
 */
function wouldRedeem(content: string): boolean {
  const lines = payloadLines(content);
  // The wallet drops everything past its own cap, so a longer payload would be
  // redeemed as a request the merchant did not write.
  if (lines.length > MAX_PAYLOAD_LINES) return false;
  // Screened as the app writes it, BOTH as written and as it will be decoded:
  // `%E2%80%AE` is seven innocent characters until the wallet unescapes it.
  // Decoding never deletes a character, so the decoded form already subsumes
  // the raw one; the pair is kept so the two screens stay diffable. `param`
  // covers the three lifted fields, this covers the path halves and the extras.
  if (isHostileText(content) || isHostileText(decodeLoose(content))) return false;
  // Both screens above are payload-level, deliberately NOT per-rail: the wallet
  // throws the WHOLE payload away on either, so a good rail beside a hostile
  // one saves nothing.
  //
  // ANY rail, not every rail. The wallet drops a line it cannot parse and pays
  // from the rest, so a payload with one broken rail and one good one redeems
  // there - and refusing it here costs the merchant a code the customer could
  // have paid, over a rail the wallet was never going to show. Only a payload
  // with nothing redeemable left is refused, which is what the wallet does too.
  return lines.some(lineWouldRedeem);
}

/**
 * One rail carries the fields the grammar ALWAYS requires, in the shapes it
 * fixes. A payload needs one rail that does (see `wouldRedeem`), not all of
 * them. Only called after `isValidPaymentUri`, so the line starts with the
 * prefix.
 *
 * Everything checked here is safe to check on this side because none of it can
 * drift: the shape is fixed by the grammar, `order_id` is an opaque token we
 * only check the presence of, `valid_until` is unix seconds whose SHAPE we
 * check (whether it has passed is the wallet's call, on its own clock), and
 * `nostr` is a bech32 key that decodes or does not. Chain names, coin symbols,
 * address formats and amount VALUES are deliberately still not checked. They come from a stablecoin
 * registry that updates without a server deploy, so a list frozen here would
 * start refusing valid payloads the day a chain is added, and the refusal
 * costs a merchant a reply they cannot act on. The wallet re-validates
 * all of it at redeem, where the registry actually lives, and must anyway:
 * this server is untrusted, so nothing it approves is a safety guarantee.
 *
 * What we DO refuse is a payload the wallet is certain to reject, because
 * minting one burns a code and hands the merchant a failure with no
 * explanation attached.
 */
function lineWouldRedeem(line: string): boolean {
  const rest = line.slice(DEFITO_PREFIX.length);
  // The canonical separator is `&`; `?` on the first param is also accepted.
  const qIdx = rest.search(/[?&]/);
  if (qIdx === -1) return false; // no params at all
  const path = rest.slice(0, qIdx);

  // `<networks>/<recipients>`: both are comma lists, and the wallet needs at
  // least one entry in each, so `,,,/0xabc` is as dead as an empty half.
  const slash = path.indexOf('/');
  if (slash === -1) return false;
  if (csv(path.slice(0, slash)).length === 0) return false;
  if (csv(path.slice(slash + 1)).length === 0) return false;

  const tail = rest.slice(qIdx + 1);
  if (!hasAmountShape(param(tail, 'amount'))) return false;
  // The order this invoice is for. The confirmation that settles it echoes this
  // value back, so an invoice without one can never be matched to its payment.
  if (!param(tail, 'order_id')) return false;
  // The wallet drops a line whose expiry it cannot parse.
  if (!VALID_UNTIL_RE.test(param(tail, 'valid_until') ?? '')) return false;
  return isIdentityKey(param(tail, 'nostr'));
}

/**
 * `valid_until=<unix seconds>`: a plain positive decimal integer, no sign,
 * leading zero or exponent, at most 12 digits. Mirrors `parseValidUntil` in the
 * app's `utils/invoice-validity.ts`; a looser check here mints codes the wallet
 * drops at redeem.
 */
const VALID_UNTIL_RE = /^[1-9]\d{0,11}$/;

/**
 * `amount=<coins>[:<value>]`. The coin list is required; the value half is
 * optional, because an invoice may ask the payer to key the figure in.
 *
 * Split at the LAST colon, as `parseDeFiToFields` does, so a stray colon in the
 * coin list cannot swallow the value. Which coins exist is still the wallet's
 * business - the registry lives there - but the SHAPE is fixed by the grammar:
 * `USDT:` is a truncated amount the wallet refuses rather than a request with
 * no value, and `:5` names no coin to pay in.
 */
function hasAmountShape(amount: string | undefined): boolean {
  if (amount === undefined) return false;
  const colon = amount.lastIndexOf(':');
  if (colon === -1) return csv(amount).length > 0;
  return csv(amount.slice(0, colon)).length > 0 && amount.slice(colon + 1).trim().length > 0;
}

/** Non-empty entries of a comma list, trimmed. Mirrors the app's `splitCsv`,
 *  which also caps a list at `MAX_CSV_OPTIONS` and TRUNCATES the surplus rather
 *  than refusing it - so there is no refusal to mirror, and imposing one here
 *  would reject payloads the wallet accepts. */
function csv(part: string): string[] {
  return part
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * First occurrence of `name` in an `a=b&c=d` tail, case-insensitive on the key,
 * trimmed and percent-decoded, or undefined when absent or empty.
 *
 * Mirrors `parseUriParams` in the app's `utils/payment-uri.ts`, down to details
 * only a hostile payload can observe: the FIRST occurrence of a key wins even
 * when empty (a later duplicate cannot override it), and the value is decoded
 * before it is judged. Any drift means a code the POS cannot mint with no
 * diagnosable reason; the parity fixtures in `protocol.test.ts` pin both.
 */
function param(tail: string, name: string): string | undefined {
  for (const token of tail.split('&')) {
    const eq = token.indexOf('=');
    if (eq === -1) continue;
    if (token.slice(0, eq).trim().toLowerCase() !== name) continue;
    const raw = token.slice(eq + 1).trim();
    if (!raw) return undefined;
    const value = decodeLoose(raw);
    // The app DROPS a value carrying hidden/bidi characters or an injection
    // marker, so one that survives here is a code that mints and is refused at
    // redeem. Kept although `wouldRedeem` already screens the whole payload:
    // when any OTHER parameter holds a malformed escape, that payload-level
    // decode bails to the raw string, and only this per-value decode still sees
    // `%E2%80%AE` for what it is.
    return isHostileText(value) ? undefined : value;
  }
  return undefined;
}

// Control (C0/C1), zero-width and bidi-override code points, plus the markup
// and foreign-scheme markers. Mirrors `utils/hostile-text.ts` in the app; the
// two must agree, or one side mints a code the other refuses at redeem.
const HIDDEN_CHARS_RE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;
const INJECTION_MARKERS: readonly string[] = ['javascript:', 'vbscript:', '<', '>', '\\'];

/** Percent-decode for SCREENING only: a malformed escape yields the original,
 *  so a broken payload is still judged on what it plainly says. */
function decodeLoose(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isHostileText(value: string): boolean {
  if (HIDDEN_CHARS_RE.test(value)) return true;
  const lower = value.toLowerCase();
  return INJECTION_MARKERS.some((marker) => lower.includes(marker));
}

const NOSTR_URI_PREFIX = 'nostr:';

/**
 * A bech32 Nostr identity key. `npub` and `nprofile` both carry one, and the
 * app accepts either, so we must too or we would refuse payloads it builds.
 * A NIP-05 string and a bare hex pubkey are NOT keys here, matching the app:
 * the first names a recipient to look up, the second has a tx hash's shape.
 *
 * The normalisation mirrors `parseNostrIdentifier` in the app's
 * `utils/nostr-identifier.ts`: a `nostr:` URI prefix is stripped and the value
 * is lowercased before decoding. Bech32 is case-insensitive as a format, so an
 * emitter that spells the key `NOSTR:NPUB1…` builds a payload the wallet reads
 * and this server used to refuse.
 */
function isIdentityKey(value: string | undefined): boolean {
  if (value === undefined) return false;
  const lower = value.trim().toLowerCase();
  const bare = lower.startsWith(NOSTR_URI_PREFIX) ? lower.slice(NOSTR_URI_PREFIX.length) : lower;
  try {
    const { type } = decode(bare);
    return type === 'npub' || type === 'nprofile';
  } catch {
    return false; // bad checksum, truncated, or not bech32 at all
  }
}
