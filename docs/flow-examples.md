# ReGBY flow - event examples

```
MID pubkey      = 4014be77...ac0951   (middleman, env REGBY_PRIVATE_KEY → derived)
MERCHANT pubkey = a1a1...a1a1
CUSTOMER pubkey = c0c0...c0c0
```

Transport is an encrypted **DM (kind 4)**. `content` is the merchant's **raw
content** (NIP-04 encrypted on the wire, shown decrypted below): any text,
opaque to the server, no JSON wrapper. It travels on hops 1, 2, 4 and 5; hop 3
and every failure carry a raw `""`. The code is never in `content`: it rides
only in the plaintext `["regby_code", <code>]` tag. The examples use a
`defito://` payment request; plain text or empty content runs the same five
hops (empty only pairs the peers). Judging the content is the recipient's job.

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

Decrypted `content` (the merchant's own hop 1 content, sent back):
```
defito://base/0x075eC7591B346391cBe5BdEc297bB1C80D335807&amount=EURC:1.00&nostr=npub1e2yuky03caw4ke3zy68lg0fz3r4gkt94hx4fjmlelacyljgyk79svn3eef&order_id=9f2c14ab7e5d4083b6a1cc90de3f7721&valid_until=1750580100
defito://bnbchain,solana,ethereum,tron/coffeeshop@swap-provider.com&amount=USDT,USDC,PYUSD:1.18&nostr=npub1e2yuky03caw4ke3zy68lg0fz3r4gkt94hx4fjmlelacyljgyk79svn3eef&order_id=9f2c14ab7e5d4083b6a1cc90de3f7721&valid_until=1750580100
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
    ["client","regby-middleware"],
    ["regby_code","42891337"]
  ],
  "content": "AgQ1mP9t...==",
  "id": "…", "sig": "…"
}
```
Merchant matches by `["e", <its request id>]` and reads the code from the
`regby_code` tag → shows `42891337`.

## Hop 3 - customer → middleman (`i: request_regby_content`)

Only the first customer to redeem the code within the 1-min window gets the
content - the code is consumed on use. `content` is a raw `""`; the code is in
the tag.

Event:
```json
{
  "kind": 4,
  "pubkey": "c0c0...c0c0",
  "created_at": 1750579230,
  "id": "a19a7a4f...0022222",
  "tags": [
    ["p","4014be77...ac0951"],
    ["i","request_regby_content"],
    ["expiration","1750838370"],
    ["regby_code","42891337"]
  ],
  "content": "",
  "sig": "…"
}
```
`regby_code` is required: it is the only place the server reads the code
from. A hop 3 without an eight-digit `regby_code` tag is dropped with no reply;
its `content` is never decrypted.
Server: `store.redeem("42891337", customer pubkey)` → found + unexpired → returns the content and the merchant who asked for it, and **consumes** the code: it stamps `redeemed_at` and `redeemed_by` (this customer), so inside the code's minute this customer is served again and anyone else gets `regby_code_already_redeemed`, and after it the code's age decides (see the error variant). The customer is also counted for hop 5 (see [Another customer](#another-customer-inside-the-minute)). The row (content included) stays 72 h for debugging, then is deleted.

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
  "created_at": 1750579231,
  "tags": [
    ["p","c0c0...c0c0"],
    ["e","a19a7a4f...0022222"],
    ["i","regby_content"],
    ["expiration","1750838371"],
    ["client","regby-middleware"],
    ["regby_code","42891337"],
    ["from","a1a1...a1a1"]
  ],
  "content": "AgC2hW8q...==",
  "id": "…", "sig": "…"
}
```
Customer matches by `["e", <its request id>]`, decrypts → content (here a `defito://` invoice) → `ingestPaymentUri` → confirm → pay.
`from` is the hex pubkey of the key that signed hop 1 (plaintext, unlike the content).

## Hop 5 - middleman → merchant (`i: regby_content_delivered`)

Sent right after hop 4, and even when hop 4 reached no relay: the code is used
up either way, and the merchant has to know to re-mint. Once per code: the
same customer fetching the content again gets no second one, and every other
customer who sends the code inside its minute gets the merchant a
`regby_conflict` instead (see
[Another customer](#another-customer-inside-the-minute)).

Decrypted `content` (exactly what the customer received in hop 4):
```
defito://base/0x075eC7591B346391cBe5BdEc297bB1C80D335807&amount=EURC:1.00&nostr=npub1e2yuky03caw4ke3zy68lg0fz3r4gkt94hx4fjmlelacyljgyk79svn3eef&order_id=9f2c14ab7e5d4083b6a1cc90de3f7721&valid_until=1750580100
defito://bnbchain,solana,ethereum,tron/coffeeshop@swap-provider.com&amount=USDT,USDC,PYUSD:1.18&nostr=npub1e2yuky03caw4ke3zy68lg0fz3r4gkt94hx4fjmlelacyljgyk79svn3eef&order_id=9f2c14ab7e5d4083b6a1cc90de3f7721&valid_until=1750580100
```
Event:
```json
{
  "kind": 4,
  "pubkey": "4014be77...ac0951",
  "created_at": 1750579231,
  "tags": [
    ["p","a1a1...a1a1"],
    ["e","a19a7a4f...0011111"],
    ["i","regby_content_delivered"],
    ["expiration","1750838371"],
    ["client","regby-middleware"],
    ["regby_code","42891337"],
    ["to","c0c0...c0c0"]
  ],
  "content": "AgD9xK2m...==",
  "id": "…", "sig": "…"
}
```
`e` is the merchant's own hop 1 event, so the POS can match the notice to the
code it is showing. `to` is the customer's hex pubkey, in plaintext.
`created_at` is the moment the server counted that customer, not when it
published. An app that predates this intent drops the event as unknown.

## Another customer inside the minute

A second customer (`d0d0...d0d0`) sends the same code one second after the
first, while it is still inside its minute. Another pubkey already used it,
so instead of hop 4 they get `regby_code_already_redeemed`, a plain failure
with empty content, and the merchant gets a `regby_conflict` naming them.

To the second customer, in place of hop 4 (`e` = their own hop 3, no `from`):

```json
{
  "kind": 4,
  "pubkey": "4014be77...ac0951",
  "created_at": 1750579232,
  "tags": [
    ["p","d0d0...d0d0"],
    ["e","b27c1e90...0033333"],
    ["i","regby_code_already_redeemed"],
    ["expiration","1750838372"],
    ["client","regby-middleware"],
    ["regby_code","42891337"]
  ],
  "content": "",
  "id": "…", "sig": "…"
}
```

To the merchant, on their own hop 1 like hop 5 (`to` = the refused customer).
Its content is a fixed warning, never the merchant's text. Decrypted:
```
This ReGBY code was already redeemed by another npub.
```

```json
{
  "kind": 4,
  "pubkey": "4014be77...ac0951",
  "created_at": 1750579232,
  "tags": [
    ["p","a1a1...a1a1"],
    ["e","a19a7a4f...0011111"],
    ["i","regby_conflict"],
    ["expiration","1750838372"],
    ["client","regby-middleware"],
    ["regby_code","42891337"],
    ["to","d0d0...d0d0"]
  ],
  "content": "AgE4tL0w...==",
  "id": "…", "sig": "…"
}
```

- The merchant's app shows the conflict as a warning, not a routine notice:
  the first to type the code may have read it off the merchant's screen, so
  the refused customer can be the real one and the pubkey in hop 5 an
  onlooker.
- One notice per distinct customer pubkey: hop 5 for the winner, a
  `regby_conflict` for each refused one. The winner sending the code again
  inside the minute gets hop 4 again; a refused customer gets
  `regby_code_already_redeemed` again. Neither causes a further notice.
- The intent alone says who got the content, whatever order the notices
  arrive in. The server also stamps each notice for the code at least one
  second after the previous one, so they keep the order the customers arrived
  in.
- A customer past the minute, the winner included, gets `regby_code_expired`
  and the merchant hears nothing.

## After hop 5 - customer → merchant, directly (recommended)

The server's part ends here. The customer's next DM to the merchant (in the
payment case, the `defifrom://` confirmation) goes straight to the merchant
and should carry `["regby_code","42891337"]`, so the merchant can match it to
the customer named in hop 5's `to`. Rules and an example:
[spec.md, Event 6](spec.md#event-6).

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
    ["client","regby-middleware"],
    ["regby_code","42891337"]
  ],
  "content": "",
  "id": "…", "sig": "…"
}
```

Which failure intent applies, by the code's age: [protocol.md, Failures](protocol.md#failures).
A refused mint looks the same with `i` = `regby_code_busy`, sent to the merchant,
without a `regby_code` tag.

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
