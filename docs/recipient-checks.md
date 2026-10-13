# Content checks moved to the recipient (usdt-pay)

ReGBY is now a transport: the middleware carries any text from one peer to
the other and never judges it. Every check below used to run in the
middleware's `src/protocol.ts` (see commit `877d3ba` on `main`) and was
removed. Each one is now the app's job.

The middleware still refuses only:

- binary content (NUL / C0 controls other than tab and line breaks, `U+FFFD`)
- content over 4096 characters
- a redeem whose content is not exactly eight digits (after trimming)

## Status in the app

"Redeem" means the customer side, after a `regby_content` arrives
(`sanitizeRedeemedUri` in `utils/regby.ts`, then `parseDeFiToFields` in
`utils/payment-uri.ts`). "Mint" means the merchant side, before a
`request_regby_code` is sent.

| # | Check (old middleware behaviour) | App at redeem | App at mint | To do |
| --- | --- | --- | --- | --- |
| 1 | Every non-empty line starts with `defito://` (case-insensitive). Anything else was `Invalid Request` plus a 24 h sender blacklist. | Yes (`isDefiUriContent`) | No | Decide what non-`defito://` content means now (see "New cases" below). The blacklist has no app equivalent and is gone. |
| 2 | Lines are split on `\r\n`, `\n`, `\r`, `U+2028`, `U+2029`, so a lone `\r` can't hide a second, foreign line. | Yes (`LINE_BREAK_RE`) | No | Keep both sides on the same terminator set. |
| 3 | At most 20 non-empty lines (`MAX_PAYLOAD_LINES`). | Yes | No | Validate before minting, or a code is issued for a payload that can never be redeemed. |
| 4 | No hidden or hostile text anywhere in the payload, checked both raw and percent-decoded: C0/C1 controls, zero-width `U+200B`-`U+200F`, bidi `U+202A`-`U+202E` and `U+2066`-`U+2069`, BOM `U+FEFF`, and the markers `javascript:`, `vbscript:`, `<`, `>`, `\`. | Yes (`isHostileText`, raw + `decodeLoose`) | No | Also screen any NON-invoice content before showing it, since the middleware no longer filters anything. |
| 5 | The payload is judged trimmed; the stored content is kept verbatim (case and bytes matter for addresses and a future merchant signature). | Yes (trims) | n/a | Nothing. |
| 6 | At least ONE rail is redeemable; broken rails beside a good one are fine. | Yes (drops unparsable rails) | No | Validate before minting. |
| 7 | Per rail: `<networks>/<recipients>` both present, each a non-empty comma list. | Yes (`parseDeFiToFields`) | No | Validate before minting. |
| 8 | Per rail: `amount=<coins>[:<value>]`, coin list required; split at the LAST colon; `USDT:` (empty value) and `:5` (no coin) refused. | Yes | No | Validate before minting. |
| 9 | Per rail: `order_id` present (opaque, contents never checked). | Yes | No | Validate before minting. |
| 10 | Per rail: `valid_until` is a plain positive integer, 1 to 12 digits, no sign, leading zero or exponent (`/^[1-9]\d{0,11}$/`). Whether it has passed is the wallet's call. | Yes (`parseValidUntil`) | No | Validate before minting. |
| 11 | Per rail: `nostr` decodes as an `npub` or `nprofile`, after stripping a `nostr:` prefix and lowercasing. NIP-05 names and bare hex are not keys. | Yes (`parseNostrIdentifier`) | No | Validate before minting. |
| 12 | Params: first occurrence of a key wins even when empty; keys case-insensitive; values trimmed and percent-decoded before judging; a value with hidden/injection text is dropped. | Yes (`parseUriParams`) | n/a | Nothing. |
| 13 | Size: at most 4096 characters, trimmed. | Yes (`MAX_REDEEMED_URI_CHARS`) | No | See "Size" below. |
| 14 | Chain names, coin symbols, address formats and amount values were deliberately NOT checked by the middleware (they come from the registry). | Yes (registry) | n/a | Nothing. |

The customer side already rejects everything the middleware used to reject.
What is new is the **merchant side**: the middleware used to refuse a bad
invoice at mint with `Invalid Request`, and now it issues a code for it. The
POS should run the same validation on its own invoice before sending
`request_regby_code`, so it never shows a code that fails at redeem.

## New cases the app must handle

These did not exist when the middleware judged content.

1. **Empty content.** A `request_regby_code` with `""` is valid: it pairs the
   peers through the `from` / `deliver_to` tags. The redeemed
   `regby_content` carries an encrypted `""`. `sanitizeRedeemedUri` throws
   `Empty payment request.` on it today; it must be treated as a successful
   pairing, not an error.
2. **Content that is not a `defito://` invoice.** Any text now gets a code.
   The app must decide what to do with it (show it, refuse it, route it), and
   must screen it (check 4) before rendering anything.
3. **Telling a value from an error.** The app used to tell a value from a
   failure reason by shape (eight digits or `defito://` = value, anything
   else = reason). Content is now opaque, so a merchant can send text equal to
   a reason. Use the **`from` tag** instead: a successful `regby_content`
   always carries it, a failure (`Code Not Found`, `Code Expired`,
   `Code Already Redeemed`) never does. On `regby_code`, a value is still
   always eight digits, and `Service Busy, Try Again` is the only failure.
4. **`Invalid Request` is no longer sent.** It can stay on the app's reason
   allowlist for older middleware builds.
5. **Pairing tags.** Read `from` (merchant npub) on `regby_content` and
   handle the new `regby_redeemed` notice (`e` = the merchant's own
   `request_regby_code`, `deliver_to` = customer npub). Both tags are
   plaintext on the relay.

## Size

The middleware's 4096-character limit is looser than the DM relays, which
cap the ENCRYPTED content at 4 KB. NIP-04 (base64 plus the IV) adds about a
third, and non-ASCII characters take more than one byte, so a content of
roughly 3000 ASCII characters already fails at the relay. The POS should keep
the plaintext well under that before minting, or the request (or the redeemed
reply) is dropped by the relay.
