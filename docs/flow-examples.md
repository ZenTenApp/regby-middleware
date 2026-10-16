# ReGBY flow - event examples

```
MID pubkey      = 4014be77...ac0951   (middleman, env REGBY_PRIVATE_KEY → derived)
MERCHANT pubkey = a1a1...a1a1
CUSTOMER pubkey = c0c0...c0c0
```

Transport is an encrypted **DM (kind 4)**. `content` is the **raw value**
(NIP-04 encrypted on the wire, shown decrypted below): the sender's content -
any text, opaque to the server - or a bare eight-digit code, no JSON wrapper.
The examples use a `defito://` payment request; plain text or empty content
runs the same five hops (empty only pairs the peers). Judging the content is
the recipient's job.

- Intent rides the `["i", <intent>]` tag: `request_regby_code` / `regby_code` /
  `request_regby_content` / `regby_content` / `regby_content_delivered`. A
  failure has its own intent and empty content (see the error variant below).
- Replies link to the request via `["e", <request-event-id>]` (the client
  matches a reply to the request it published - no in-band id).
- `["expiration", <unix>]` (NIP-40) = `created_at + REGBY_EVENT_EXPIRY_SECONDS`
  (default 72 h less a minute) on every event - a relay-retention /
  maintenance buffer only. **Code validity is 1 min, single-use**, and is
  anchored to the merchant request event's `created_at` (not server
  receive-time), so the POS and server count down from the same instant. The
  merchant signed that event, so it already knows the origin - no timestamp is
  echoed back.

## Hop 1 - merchant → middleman (`i: request_regby_code`)

Decrypted `content` (here, a merchant's multi-option payment request; any text works):
```
defito://base/0x075eC7591B346391cBe5BdEc297bB1C80D335807&amount=EURC:1.00&nostr=npub1e2yuky03caw4ke3zy68lg0fz3r4gkt94hx4fjmlelacyljgyk79svn3eef&order_id=9f2c14ab7e5d4083b6a1cc90de3f7721&valid_until=1750580100
defito://bnbchain,solana,ethereum,tron/coffeeshop@swap-provider.com&amount=USDT,USDC,PYUSD:1.18&nostr=npub1e2yuky03caw4ke3zy68lg0fz3r4gkt94hx4fjmlelacyljgyk79svn3eef&order_id=9f2c14ab7e5d4083b6a1cc90de3f7721&valid_until=1750580100
```
Event on relay:
```json
{
  "kind": 4,
  "pubkey": "a1a1...a1a1",
  "created_at": 1750579200,
  "id": "a19a7a4f...0011111",
  "tags": [
    ["p","4014be77...ac0951"],
    ["i","request_regby_code"],
    ["expiration","1750838340"]
  ],
  "content": "AgB8xK2v...==",
  "sig": "…"
}
```
Server: read `i:request_regby_code` → decrypt → drop it silently if it is binary or over 4096 characters → `store.mint(content, clampToSkew(created_at), { merchant pubkey, request event id })` → 8-digit code (SQLite row), valid 1 min from the merchant's `created_at` (or until first redeem), answering `regby_code_expired` for 1 h and held back from reuse for 72 h. The content is stored verbatim and never read: networks, coins, amounts, even whether it is a `defito://` invoice at all, are the receiving wallet's to check.

## Hop 2 - middleman → merchant (`i: regby_code`)

Decrypted `content`:
```
42891337
```
Event:
```json
{
  "kind": 4,
  "pubkey": "4014be77...ac0951",
  "created_at": 1750579201,
  "tags": [
    ["p","a1a1...a1a1"],
    ["e","a19a7a4f...0011111"],
    ["i","regby_code"],
    ["expiration","1750838341"],
    ["client","regby-middleware"]
  ],
  "content": "AgQ1mP9t...==",
  "id": "…", "sig": "…"
}
```
Merchant matches by `["e", <its request id>]`, decrypts → shows `42891337`.

## Hop 3 - customer → middleman (`i: request_regby_content`)

Only the first customer to redeem the code within the 1-min window gets the
content - the code is consumed on use. Decrypted `content`:
```
42891337
```
Event:
```json
{
  "kind": 4,
  "pubkey": "c0c0...c0c0",
  "created_at": 1750579260,
  "id": "a19a7a4f...0022222",
  "tags": [
    ["p","4014be77...ac0951"],
    ["i","request_regby_content"],
    ["expiration","1750838400"]
  ],
  "content": "AgZ7nR4s...==",
  "sig": "…"
}
```
Server: `store.redeem("42891337")` → found + unexpired → returns the content and the merchant who asked for it, and **consumes** the code: it stamps `redeemed_at`, so a later redeem inside the code's minute gets `regby_code_already_redeemed`, and after it the code's age decides (see the error variant). The row (content included) stays 72 h for debugging, then is deleted.

## Hop 4 - middleman → customer (`i: regby_content`)

Decrypted `content` (exactly what the merchant sent):
```
defito://base/0x075eC7591B346391cBe5BdEc297bB1C80D335807&amount=EURC:1.00&nostr=npub1e2yuky03caw4ke3zy68lg0fz3r4gkt94hx4fjmlelacyljgyk79svn3eef&order_id=9f2c14ab7e5d4083b6a1cc90de3f7721&valid_until=1750580100
defito://bnbchain,solana,ethereum,tron/coffeeshop@swap-provider.com&amount=USDT,USDC,PYUSD:1.18&nostr=npub1e2yuky03caw4ke3zy68lg0fz3r4gkt94hx4fjmlelacyljgyk79svn3eef&order_id=9f2c14ab7e5d4083b6a1cc90de3f7721&valid_until=1750580100
```
Event:
```json
{
  "kind": 4,
  "pubkey": "4014be77...ac0951",
  "created_at": 1750579261,
  "tags": [
    ["p","c0c0...c0c0"],
    ["e","a19a7a4f...0022222"],
    ["i","regby_content"],
    ["expiration","1750838401"],
    ["client","regby-middleware"],
    ["from","a1a1...a1a1"]
  ],
  "content": "AgC2hW8q...==",
  "id": "…", "sig": "…"
}
```
Customer matches by `["e", <its request id>]`, decrypts → content (here a `defito://` invoice) → `ingestPaymentUri` → confirm → pay.
`from` is the hex pubkey of the key that signed hop 1 (plaintext, unlike the content).

## Hop 5 - middleman → merchant (`i: regby_content_delivered`)

Sent right after hop 4, only for a successful redeem, and even when hop 4
reached no relay: the code is used up either way, and the merchant has to know
to re-mint.

Decrypted `content` (the code that was redeemed):
```
42891337
```
Event:
```json
{
  "kind": 4,
  "pubkey": "4014be77...ac0951",
  "created_at": 1750579261,
  "tags": [
    ["p","a1a1...a1a1"],
    ["e","a19a7a4f...0011111"],
    ["i","regby_content_delivered"],
    ["expiration","1750838401"],
    ["client","regby-middleware"],
    ["to","c0c0...c0c0"]
  ],
  "content": "AgD9xK2m...==",
  "id": "…", "sig": "…"
}
```
`e` is the merchant's own hop 1 event, so the POS can match the notice to the
code it is showing. `to` is the customer's hex pubkey, in plaintext. An app
that predates this intent drops the event as unknown.

## Error variant - bad / expired code (own intent, replaces hop 4)

A failure reply names the outcome in its intent and carries **empty**
`content` (a raw `""`, not encrypted: empty content never is, in either
direction) and no `from` tag. Content is opaque and may be
empty on a success too, so the client reads the intent, never the content, to
tell them apart.

Event tags: `["p", <requester>]`, `["e", <request id>]`, `["i", <failure intent>]`,
`["expiration", …]`, `["client","regby-middleware"]`. A code is in exactly one state at a time, set by its age
from the merchant's request; each later state overrides the earlier, so a used
code reads `expired` once its minute is over. The failure intent is one of:
- `regby_code_already_redeemed` - already redeemed, still inside its 1-min validity. Answers a `request_regby_content`.
  - This includes a redeem whose reply no relay accepted: the code is consumed before the reply is published (at-most-once), so a dropped reply burns it and the customer's retry lands here (or on `regby_code_expired` once the minute is over). Recovery is a re-mint at the POS; the server logs `Code consumed but its reply reached no relay`.
- `regby_code_expired` - past the 1-min validity, used or not, under 1 h old. Answers a `request_regby_content`.
- `regby_code_locked` - 1 h to 72 h old: the number is held back so it is never issued to another request before then. Answers a `request_regby_content`, and counts as a guess toward the blacklist.
- `regby_code_not_found` - never minted, or more than 72 h old. Answers a `request_regby_content`, and counts as a guess.
- `regby_code_busy` - mint-time store overflow. Answers a `request_regby_code`, to the merchant.

## Notes

- `content` shown decrypted - wire carries only NIP-04 ciphertext + plaintext tags (`from` / `to` included).
- Intent is the `["i",<intent>]` tag (signed → authenticated); no `type` field, no `requestId`.
- Correlation is the `["e", <request-event-id>]` reply tag.
- The DM relays refuse writes without a `client` tag. The broker's events carry `["client","regby-middleware"]`; app events carry the app's own (omitted from the merchant and customer examples above).
- Server subscription: `{ kinds:[4], "#p":[MID], "#i":["request_regby_code","request_regby_content"] }`.
- Code validity = 1 min, anchored to the merchant request's `created_at` (skew-clamped). Single-use: the first redeem consumes it. A used code answers `regby_code_already_redeemed` inside its minute; then any code answers `regby_code_expired` until 1 h, `regby_code_locked` until 72 h, then `regby_code_not_found`. The number is not reissued for 72 h.
- Relay retention = NIP-40 `expiration` = `created_at + REGBY_EVENT_EXPIRY_SECONDS` (default 72 h less a minute) on every event (maintenance buffer, unrelated to code validity).
- **Active cleanup**: once a reply's expiration passes, the middleman publishes a NIP-09 `kind 5`
  deletion referencing its own reply event ids (batched), since NIP-40 is advisory and not all relays honor
  it. Example: `{ "kind":5, "tags":[["k","4"],["e","<reply-id>"],…], "content":"regby expired" }`. Only the
  middleman's own events - inbound merchant/customer events are theirs to delete.
- **Persistence**: the code store is SQLite (`node:sqlite`, base `REGBY_DB_PATH`), so codes survive a
  restart. The deletion queue stays in-memory (covers replies from the current process; older ones
  fall back to NIP-40 relay expiry).
- **Daily rotation**: a new SQLite file is opened per UTC day (nested `YYYY/MM/regby-YYYY-MM-DD.db` from `REGBY_DB_PATH`),
  switched at 00:00 UTC; old files are kept on disk. Only the current day's file is read/written, but
  opening it copies in the codes from the last 72 h out of every earlier day file, so a code minted just before midnight
  still works after the roll and no number is reissued within 72 h. Each row also stores `created_at`
  (wall-clock mint time, the start of the 72 h reuse window).
