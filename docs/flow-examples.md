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

Rules (intents, failures, tags, code lifecycle, retention) live in
[protocol.md](protocol.md); this page only shows the events.

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

## Error variant - refused code (own intent, replaces hop 4)

Same shape as hop 4, but the intent names the failure, `content` is a raw `""`
(empty content is never encrypted) and there is no `from` tag:

```json
{
  "kind": 4,
  "pubkey": "4014be77...ac0951",
  "created_at": 1750579261,
  "tags": [
    ["p","c0c0...c0c0"],
    ["e","a19a7a4f...0022222"],
    ["i","regby_code_expired"],
    ["expiration","1750838401"],
    ["client","regby-middleware"]
  ],
  "content": "",
  "id": "…", "sig": "…"
}
```

Which failure intent applies, by the code's age: [protocol.md, Failures](protocol.md#failures).
A refused mint looks the same with `i` = `regby_code_busy`, sent to the merchant.

## Notes

- `content` shown decrypted - wire carries only NIP-04 ciphertext + plaintext tags (`from` / `to` included).
- Intent is the `["i",<intent>]` tag (signed → authenticated); no `type` field, no `requestId`.
- Correlation is the `["e", <request-event-id>]` reply tag.
- The DM relays refuse writes without a `client` tag. The broker's events carry `["client","regby-middleware"]`; app events carry the app's own (omitted from the merchant and customer examples above).
- Server subscription: `{ kinds:[4], "#p":[MID], "#i":["request_regby_code","request_regby_content"] }`.
- **Deletion**: once a reply's expiration passes, the broker publishes a NIP-09 kind 5 for its own
  reply ids, e.g. `{ "kind":5, "tags":[["k","4"],["e","<reply-id>"],…], "content":"regby expired" }`.
  The dedicated DM relays reject kind 5, so there retention rests on the NIP-40 tag (see
  [protocol.md, Relay housekeeping](protocol.md#relay-housekeeping)).
