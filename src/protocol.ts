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
 *     or the bare eight-digit code. No JSON wrapper.
 *   - the message **intent** rides a plaintext `['i', <intent>]` tag -
 *     single-letter `i` is relay-indexable, so the server subscribes
 *     `#i:INBOUND_INTENTS` and pulls only inbound regby traffic.
 *   - replies carry `['e', <request-event-id>]` (Nostr-native reply linkage)
 *     so the client matches a reply to the request it published - no in-band
 *     correlation id needed.
 *   - there is **no `error` intent**. A failure reply reuses the success intent
 *     (`regby_code` for a `request_regby_code`, `regby_content` for a
 *     `request_regby_content`) and carries a `REPLY_REASON` string in
 *     `content` instead of a value.
 *   - relay retention is bounded by NIP-40 `['expiration', unixSec]`.
 *
 * Tags are covered by the event signature, so intent/linkage are authenticated.
 * Only the content/code lives in the ciphertext.
 */

/** Encrypted DM kind: NIP-04 envelope and NIP-04 ciphertext, which is what
 *  every client reading these relays expects under this kind. */
export const REGBY_KIND = 4;

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

/** The success intent that answers each inbound request (reused for errors). */
export const REPLY_INTENT = {
  request_regby_code: 'regby_code',
  request_regby_content: 'regby_content',
} as const satisfies Record<InboundIntent, string>;

/**
 * Every reason a failure reply can carry. The app shows only these exact
 * strings (`sanitizeReGBYError`) and renders anything else as a generic
 * fallback, so a new or reworded reason needs an app release before its text
 * reaches a user. Pinned against the app's allowlist by the parity tests.
 */
export const REPLY_REASON = {
  notFound: 'Code Not Found',
  expired: 'Code Expired',
  redeemed: 'Code Already Redeemed',
  busy: 'Service Busy, Try Again',
} as const;

/**
 * Unsolicited notice to the MERCHANT once their code is redeemed (content = the
 * code, `e` = the merchant's own `request_regby_code` event). Not a reply to the
 * merchant's latest message, so it has its own intent: an app that predates it
 * drops an unknown intent instead of reading it as a second `regby_code`.
 */
export const REDEEMED_INTENT = 'regby_redeemed';

/** Every intent the middleman emits; a failure reuses the matching reply intent. */
export type OutboundIntent = (typeof REPLY_INTENT)[InboundIntent] | typeof REDEEMED_INTENT;

/**
 * Plaintext tags naming the counterparty as an npub, so each side learns who
 * the server paired them with: `from` (the merchant) on the customer's
 * `regby_content`, `deliver_to` (the customer) on the merchant's
 * `regby_redeemed`. Unlike the content they are NOT encrypted: anyone reading
 * the relay sees which merchant and customer met. Accepted product trade-off.
 */
export const FROM_TAG = 'from';
export const DELIVER_TO_TAG = 'deliver_to';

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
