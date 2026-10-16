/**
 * ReGBY wire protocol - the single source of truth for the encrypted DM shapes
 * exchanged between the app and this middleman, mirroring `utils/regby.ts` in
 * the wallet app.
 *
 * ReGBY is a transport: it carries one peer's content to another behind an
 * eight-digit code, then pairs the two peers. The content is opaque here -
 * any text, empty included, only bytes are refused. Judging it (a `defito://`
 * invoice, say) is the RECIPIENT's job, never this server's.
 *
 * Transport is a standard encrypted **DM (kind 4)** so events are treated as
 * messages. Design:
 *   - `content` is the **raw value**, NIP-04 encrypted: the sender's content,
 *     or the bare eight-digit code. No JSON wrapper. Empty content is the
 *     exception: it travels as a raw `""`, never encrypted (`EMPTY_CONTENT`).
 *     Some NIP-04 clients or relays may choke on a kind 4 with empty content;
 *     untested on our relays so far.
 *   - the message **intent** rides a plaintext `['i', <intent>]` tag -
 *     single-letter `i` is relay-indexable, so the server subscribes
 *     `#i:INBOUND_INTENTS` and pulls only inbound regby traffic.
 *   - replies carry `['e', <request-event-id>]` (Nostr-native reply linkage)
 *     so the client matches a reply to the request it published - no in-band
 *     correlation id needed.
 *   - a failure reply names the outcome in its intent (`FAILURE_INTENT`,
 *     e.g. `regby_code_expired`) and carries empty `content` and no pairing
 *     tag. Empty content alone means nothing: a success may carry empty
 *     content too, so the client reads the intent first.
 *   - relay retention is bounded by NIP-40 `['expiration', unixSec]`.
 *
 * Tags are covered by the event signature, so intent/linkage are authenticated.
 * Only the content/code lives in the ciphertext.
 */

/** Encrypted DM kind: NIP-04 envelope and NIP-04 ciphertext, which is what
 *  every client reading these relays expects under this kind. */
export const REGBY_KIND = 4;

/**
 * Empty content on the wire, in both directions: sent as-is, never encrypted,
 * and read back as empty without a decrypt. NIP-04 of `""` would still be a
 * full ciphertext block, so a raw `""` is what lets anyone see "no content".
 */
export const EMPTY_CONTENT = '';

/** Codes are exactly eight decimal digits. */
export const REGBY_CODE_RE = /^\d{8}$/;

/**
 * Decrypted content that is bytes, not text. NIP-04 decrypt decodes UTF-8
 * leniently (nostr-tools' non-fatal `TextDecoder`), so encrypted bytes never
 * fail: they arrive as a string with `U+FFFD` where a byte sequence was not
 * valid UTF-8, and NULs and other C0 controls pass through. Either is treated
 * as bytes. That also catches a wrong-key decrypt that happens to pass PKCS7
 * padding (about 1 in 256).
 *
 * The C0 range minus the whitespace controls (tab, LF, VT, FF, CR), which are
 * text, plus `U+FFFD`. It applies to the RAW characters only: an escaped `%00`
 * is text, and the recipient's to judge.
 */
const BINARY_RE = /[\u0000-\u0008\u000E-\u001F\uFFFD]/;

/**
 * Upper bound on decrypted content we accept, raw characters; past it the event
 * is dropped, not answered. A sanity bound, not what fits on a relay: the DM
 * relays cap the ENCRYPTED content at 4 KB, which NIP-04 overhead reaches near
 * 3000 ASCII characters (see docs/recipient-checks.md, "Size").
 */
export const MAX_CONTENT_LENGTH = 4096;

/** Intent tag key. */
export const INTENT_TAG = 'i';

/** Inbound intents as a value list. Feeds the relay `#i` subscription filter
 *  and `extractIntent`, so the type and the runtime check cannot drift. */
export const INBOUND_INTENTS = ['request_regby_code', 'request_regby_content'] as const;

/** The two intents the middleman accepts from clients. */
export type InboundIntent = (typeof INBOUND_INTENTS)[number];

/** The success intent that answers each inbound request. */
export const REPLY_INTENT = {
  request_regby_code: 'regby_code',
  request_regby_content: 'regby_content',
} as const satisfies Record<InboundIntent, string>;

/**
 * The intent of every failure reply, sent with empty content. `busy` answers a
 * `request_regby_code` (no free code to mint), the rest a
 * `request_regby_content`, one per state of the code (see `store.ts`): used
 * inside its minute, lapsed (used or not), held back from reuse, unknown. The
 * app must know each one: an intent it does not
 * recognise never matches its pending request, so a new failure needs an app
 * release first. Keep in sync with the app's `utils/regby.ts`.
 */
export const FAILURE_INTENT = {
  notFound: 'regby_code_not_found',
  expired: 'regby_code_expired',
  redeemed: 'regby_code_already_redeemed',
  locked: 'regby_code_locked',
  busy: 'regby_code_busy',
} as const;

/**
 * Unsolicited notice to the MERCHANT once their code is redeemed (content = the
 * code, `e` = the merchant's own `request_regby_code` event). "Delivered" means
 * the server released the content and used up the code, not that the customer's
 * reply reached a relay. Not a reply to the merchant's latest message, so it has
 * its own intent: an app that predates it drops an unknown intent instead of
 * reading it as a second `regby_code`.
 */
export const CONTENT_DELIVERED_INTENT = 'regby_content_delivered';

export type FailureIntent = (typeof FAILURE_INTENT)[keyof typeof FAILURE_INTENT];

/** Every intent the middleman emits. */
export type OutboundIntent =
  | (typeof REPLY_INTENT)[InboundIntent]
  | FailureIntent
  | typeof CONTENT_DELIVERED_INTENT;

/**
 * Plaintext tags naming the counterparty by hex pubkey (as `p` does), so each
 * side learns who the server paired them with: `from` (the merchant) on the
 * customer's `regby_content`, `to` (the customer) on the merchant's
 * `regby_content_delivered`. Unlike the content they are NOT encrypted: anyone
 * reading the relay sees which merchant and customer met. Accepted product
 * trade-off.
 */
export const FROM_TAG = 'from';
export const TO_TAG = 'to';

/** A validated inbound message: a merchant code request, or a customer redeem. */
export type InboundMessage =
  | { intent: 'request_regby_code'; content: string }
  | { intent: 'request_regby_content'; code: string };

/**
 * Outcome of parsing decrypted inbound content.
 *  - `ok`     → a message to dispatch. Any text is a valid `request_regby_code`.
 *  - `silent` → dropped without a reply: content past `MAX_CONTENT_LENGTH`, a
 *    redeem whose content is not an eight-digit code.
 *  - `binary` → the decrypted content is bytes, not text (an image, a file, a
 *    wrong-key decrypt). Dropped like `silent`, kept apart so operators can see
 *    it in the log.
 */
export type ParseResult =
  | { ok: true; message: InboundMessage }
  | { ok: false; reason: 'silent' | 'binary' };

/**
 * Read the inbound intent from an event's tags. Returns the first recognised
 * `['i', 'request_regby_code' | 'request_regby_content']`, or null when
 * absent/unknown. Outbound intents are NOT accepted here, so an echoed-back
 * reply never enters processing.
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
 * Read decrypted `content` for an inbound intent (see `ParseResult`). Only the
 * envelope is checked - bytes, size, the code's shape - never what the
 * content says: that is the recipient's to judge.
 */
export function parseInbound(intent: InboundIntent, content: string): ParseResult {
  if (BINARY_RE.test(content)) return { ok: false, reason: 'binary' };
  if (content.length > MAX_CONTENT_LENGTH) return { ok: false, reason: 'silent' };
  if (intent === 'request_regby_code') return { ok: true, message: { intent, content } };

  // request_regby_content
  const code = content.trim();
  if (!REGBY_CODE_RE.test(code)) return { ok: false, reason: 'silent' };
  return { ok: true, message: { intent, code } };
}
