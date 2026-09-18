/**
 * ReGBY wire protocol — the single source of truth for the encrypted DM shapes
 * exchanged between the app and this middleman, mirroring `utils/regby.ts` in
 * the wallet app.
 *
 * Transport is a standard encrypted **DM (kind 4)** so events are treated as
 * messages. Design:
 *   - `content` is the **raw value**, NIP-04 encrypted: a `defito://`
 *     payment-request URI (possibly multi-line / multi-option) or the bare
 *     eight-digit code. No JSON wrapper. A `defifrom://` confirmation never
 *     passes through here - see `DEFITO_PREFIX`.
 *   - the message **intent** rides a plaintext `['i', <intent>]` tag —
 *     single-letter `i` is relay-indexable, so the server subscribes
 *     `#i:['request_code','request_uri']` and pulls only inbound regby traffic.
 *   - replies carry `['e', <request-event-id>]` (Nostr-native reply linkage)
 *     so the client matches a reply to the request it published — no in-band
 *     correlation id needed.
 *   - there is **no `error` intent**. A failure reply reuses the success intent
 *     (`code` for a `request_code`, `uri` for a `request_uri`) and carries the
 *     reason string in `content` instead of a value. The client tells a value
 *     from an error by the content's SHAPE (8 digits / a `defito://` prefix)
 *     and whitelist-sanitises anything else — the middleman is untrusted, so a
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

/** Upper bound on decrypted content we accept (multi-line URIs included). */
export const MAX_CONTENT_LENGTH = 4096;

/** Intent tag key. */
export const INTENT_TAG = 'i';

export type ReGBYIntent = 'request_code' | 'code' | 'request_uri' | 'uri';

/** The two intents the middleman emits — a failure reuses the matching one. */
export type OutboundIntent = Extract<ReGBYIntent, 'code' | 'uri'>;

/** The two intents the middleman accepts from clients. */
export type InboundIntent = Extract<ReGBYIntent, 'request_code' | 'request_uri'>;

/** Inbound intents as a value list — feeds the relay `#i` subscription filter. */
export const INBOUND_INTENTS: readonly InboundIntent[] = ['request_code', 'request_uri'];

/** The success intent that answers each inbound request (reused for errors). */
export const REPLY_INTENT: Record<InboundMessage['intent'], OutboundIntent> = {
  request_code: 'code',
  request_uri: 'uri',
};

/** A validated inbound message: a merchant code request, or a customer redeem. */
export type InboundMessage =
  | { intent: 'request_code'; uri: string }
  | { intent: 'request_uri'; code: string };

/**
 * Outcome of parsing decrypted inbound content. The three verdicts differ by
 * what they cost the SENDER, so what separates them is evidence of intent.
 *  - `ok`        → a well-formed message to dispatch.
 *  - `malicious` → decrypt succeeded (a real, targeted message) but a
 *    `request_code` carried a payload that is not `defito://`. The sender
 *    proved they hold the conversation key, so aiming a foreign scheme at us is
 *    deliberate → caller replies on the reused success intent (`code`,
 *    content = reason) AND blacklists the sender for 24 h.
 *  - `malformed` → `defito://`, but missing a field the grammar always
 *    requires. Caller replies with the same reason and does NOT
 *    blacklist: this is a broken client, not an attacker, and a 24 h lockout
 *    is the wrong answer to a merchant whose POS built a bad string.
 *  - `silent`    → junk we drop without a reply (empty/oversized, malformed
 *    code shape, or an outbound intent echoed back at us).
 */
export type ParseResult =
  | { ok: true; message: InboundMessage }
  | { ok: false; reason: 'malicious' | 'malformed' | 'silent' };

/**
 * Read the inbound intent from an event's tags. Returns the first recognised
 * `['i', 'request_code' | 'request_uri']`, or null when absent/unknown. The two
 * outbound intents (`code`/`uri`) are NOT accepted here — an echoed-back reply
 * never enters processing.
 */
export function extractIntent(tags: string[][]): InboundIntent | null {
  for (const tag of tags) {
    if (tag[0] !== INTENT_TAG) continue;
    const value = tag[1];
    if (value === 'request_code' || value === 'request_uri') return value;
  }
  return null;
}

/**
 * Validate decrypted `content` for an inbound intent. A `request_code` whose
 * payload is not `defito://` is `malicious` (see ParseResult) so the caller can
 * blacklist the sender; one that IS `defito://` but omits a required field is
 * `malformed` and is NOT blacklisted; a malformed code shape is dropped
 * `silent`.
 */
export function parseInbound(intent: InboundIntent, content: string): ParseResult {
  // Emptiness is tested on the TRIMMED content: `malicious` costs the sender a
  // 24 h blacklist, and three spaces from a buggy client is noise, not proof of
  // deliberate abuse. Only a payload with something in it can earn that.
  if (content.trim().length === 0 || content.length > MAX_CONTENT_LENGTH) {
    return { ok: false, reason: 'silent' };
  }

  if (intent === 'request_code') {
    // Two questions, two punishments: "is this even ours" (a foreign scheme is
    // deliberate) then "is it complete" (a missing field is a broken client).
    if (!isValidPaymentUri(content)) return { ok: false, reason: 'malicious' };
    if (!hasRequiredFields(content)) return { ok: false, reason: 'malformed' };
    return { ok: true, message: { intent, uri: content } };
  }

  // request_uri
  const code = content.trim();
  if (!REGBY_CODE_RE.test(code)) return { ok: false, reason: 'silent' };
  return { ok: true, message: { intent, code } };
}

/**
 * An invoice payload is one or more line-separated lines, every non-empty one a
 * `defito://` URI. The multiple lines are the merchant's ranked fallback rails
 * for ONE order, so they should share an `orderid` (not compared here).
 *
 * Only the scheme is checked here; field checks live in `hasRequiredFields`. A
 * line that is ONLY the scheme is still refused: minting it burns a code on
 * something the wallet is certain to reject at redeem.
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
  return lines.every(
    (l) => l.startsWith(DEFITO_PREFIX) && l.length > DEFITO_PREFIX.length,
  );
}

/** Trimmed non-empty lines, split on every terminator in `LINE_BREAK_RE`. */
function payloadLines(content: string): string[] {
  return content
    .split(LINE_BREAK_RE)
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Every line carries the fields the grammar ALWAYS requires. Checked separately
 * from the scheme because it earns a softer verdict (see ParseResult).
 *
 * This is the one validation beyond the scheme that is safe to run here,
 * because none of it can drift: the shape is fixed by the grammar, `orderid` is
 * an opaque token we only check the presence of, and `nostr` is a bech32 key
 * that decodes or does not. Chain names, coin symbols, address formats and
 * amount VALUES are deliberately still not checked. They come from a stablecoin
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
function hasRequiredFields(content: string): boolean {
  return payloadLines(content).every(lineHasRequiredFields);
}

/** Only called after `isValidPaymentUri`, so every line starts with the prefix. */
function lineHasRequiredFields(line: string): boolean {
  const rest = line.slice(DEFITO_PREFIX.length);
  // The canonical separator is `&`; `?` on the first param is also accepted.
  const qIdx = rest.search(/[?&]/);
  if (qIdx === -1) return false; // no params at all
  const path = rest.slice(0, qIdx);

  // `<networks>/<recipients>` — both halves must be non-empty.
  const slash = path.indexOf('/');
  if (slash <= 0) return false;
  if (path.slice(slash + 1).trim().length === 0) return false;

  const tail = rest.slice(qIdx + 1);
  // A coin list is required; its `:<value>` half is optional (an invoice may
  // ask the payer to key the figure in), and which it is stays the wallet's
  // rule - we only check the parameter is present and non-empty.
  if (!param(tail, 'amount')) return false;
  // The order this invoice is for. The confirmation that settles it echoes this
  // value back, so an invoice without one can never be matched to its payment.
  if (!param(tail, 'orderid')) return false;
  return isIdentityKey(param(tail, 'nostr'));
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
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw; // malformed escape - judge it on what it plainly says
    }
  }
  return undefined;
}

/**
 * A bech32 Nostr identity key. `npub` and `nprofile` both carry one, and the
 * app accepts either, so we must too or we would refuse payloads it builds.
 * A NIP-05 string and a bare hex pubkey are NOT keys here, matching the app:
 * the first names a recipient to look up, the second has a tx hash's shape.
 */
function isIdentityKey(value: string | undefined): boolean {
  if (value === undefined) return false;
  try {
    const { type } = decode(value);
    return type === 'npub' || type === 'nprofile';
  } catch {
    return false; // bad checksum, truncated, or not bech32 at all
  }
}
