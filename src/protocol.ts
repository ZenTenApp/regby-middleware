/**
 * ReGBY wire protocol — the single source of truth for the encrypted DM shapes
 * exchanged between the app and this middleman, mirroring `utils/regby.ts` in
 * the wallet app.
 *
 * Transport is a standard encrypted **DM (kind 4)** so events are treated as
 * messages. Design:
 *   - `content` is the **raw value**, NIP-04 encrypted: a `defito://`
 *     payment-request URI (possibly multi-line / multi-option), a
 *     `defifrom://` payment confirmation, or the bare eight-digit code. No
 *     JSON wrapper.
 *   - the message **intent** rides a plaintext `['i', <intent>]` tag —
 *     single-letter `i` is relay-indexable, so the server subscribes
 *     `#i:['request_code','request_uri']` and pulls only inbound regby traffic.
 *   - replies carry `['e', <request-event-id>]` (Nostr-native reply linkage)
 *     so the client matches a reply to the request it published — no in-band
 *     correlation id needed.
 *   - there is **no `error` intent**. A failure reply reuses the success intent
 *     (`code` for a `request_code`, `uri` for a `request_uri`) and carries the
 *     reason string in `content` instead of a value. The client tells a value
 *     from an error by the content's SHAPE (8 digits / one of our URI schemes)
 *     and whitelist-sanitises anything else — the middleman is untrusted, so a
 *     free `error` text channel was just a hole for arbitrary text into the UI.
 *   - relay retention is bounded by NIP-40 `['expiration', unixSec]`.
 *
 * Tags are covered by the event signature, so intent/linkage are authenticated.
 * Only the URI/code lives in the ciphertext.
 */

/** Encrypted DM kind: NIP-04 envelope and NIP-04 ciphertext, which is what
 *  every client reading these relays expects under this kind. */
export const REGBY_KIND = 4;

/**
 * The schemes a payload may use. A code stands in for either half of the
 * protocol: a `defito://` request the customer redeems, or a `defifrom://`
 * confirmation handed back once they have paid. Mirrors `REGBY_URI_PREFIXES`
 * in the app's `utils/regby.ts` — keep the two in lockstep or a payload the
 * wallet builds will be rejected here as malicious.
 */
export const DEFITO_PREFIX = 'defito://';
export const DEFIFROM_PREFIX = 'defifrom://';
export const REGBY_URI_PREFIXES = [DEFITO_PREFIX, DEFIFROM_PREFIX] as const;

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
 * Outcome of parsing decrypted inbound content.
 *  - `ok`        → a well-formed message to dispatch.
 *  - `malicious` → decrypt succeeded (a real, targeted message) but a
 *    `request_code` carried a payload that is not one of our URIs. The sender
 *    proved they
 *    hold the conversation key, so this is a deliberate bad request → caller
 *    replies on the reused success intent (`code`, content = reason) and
 *    blacklists the sender.
 *  - `silent`    → junk we drop without a reply (empty/oversized, malformed
 *    code shape, or an outbound intent echoed back at us).
 */
export type ParseResult =
  | { ok: true; message: InboundMessage }
  | { ok: false; reason: 'malicious' | 'silent' };

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
 * payload is not a valid DeFi payment URI is `malicious` (see ParseResult) so
 * the caller can blacklist the sender; a malformed code shape is dropped
 * `silent`.
 */
export function parseInbound(intent: InboundIntent, content: string): ParseResult {
  if (content.length === 0 || content.length > MAX_CONTENT_LENGTH) {
    return { ok: false, reason: 'silent' };
  }

  if (intent === 'request_code') {
    if (!isValidPaymentUri(content)) return { ok: false, reason: 'malicious' };
    return { ok: true, message: { intent, uri: content } };
  }

  // request_uri
  const code = content.trim();
  if (!REGBY_CODE_RE.test(code)) return { ok: false, reason: 'silent' };
  return { ok: true, message: { intent, code } };
}

/**
 * A payment payload is one or more newline-separated lines, every non-empty one
 * using the SAME one of our schemes. Mirrors `isDefiUriContent` in the app's
 * `utils/regby.ts`, which the wallet applies to whatever we hand back.
 *
 * The lines must AGREE on their scheme. A request and a confirmation mean
 * opposite things, so a payload mixing them is either a bug or an attempt to
 * have us mint one code that redeems as both — we refuse to store it at all
 * rather than leave the wallet as the only thing standing between the two.
 *
 * We deliberately do not validate anything past the scheme: networks, coins,
 * amounts and the required `nostr=<npub>` are the wallet's business, and this
 * server holds the plaintext it never needed to understand.
 */
export function isValidPaymentUri(content: string): boolean {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean);
  const [first] = lines;
  if (first === undefined) return false;
  const prefix = REGBY_URI_PREFIXES.find((p) => first.startsWith(p));
  if (prefix === undefined) return false;
  return lines.every((l) => l.startsWith(prefix));
}
