# ReGBY flow — event examples

```
MID pubkey      = 4014be77...ac0951   (middleman, env REGBY_PRIVATE_KEY → derived)
MERCHANT pubkey = a1a1...a1a1
CUSTOMER pubkey = c0c0...c0c0
```

Transport is an encrypted **DM (kind 4)**. `content` is the **raw value**
(NIP-04 encrypted on the wire, shown decrypted below): a `defito://` payment
request (possibly multi-line / multi-option) or a bare eight-digit code — no
JSON wrapper. A `defifrom://` payment confirmation goes straight to the npub
named in the invoice it answers and never passes through this broker.

- Intent rides the `["i", <intent>]` tag: `request_code` / `code` /
  `request_uri` / `uri`. There is **no `error` intent** — a failure reuses the
  request's success intent and carries the reason in `content`.
- Replies link to the request via `["e", <request-event-id>]` (the client
  matches a reply to the request it published — no in-band id).
- `["expiration", <unix>]` (NIP-40) = `created_at + 1 h` on every event — a
  relay-retention / maintenance buffer only. **Code validity is 5 min**, and is
  anchored to the merchant request event's `created_at` (not server
  receive-time), so the POS and server count down from the same instant. The
  merchant signed that event, so it already knows the origin — no timestamp is
  echoed back.

## Hop 1 — merchant → middleman (`i: request_code`)

Decrypted `content` (the merchant's multi-option request):
```
defito://base/0x075eC7591B346391cBe5BdEc297bB1C80D335807&amount=EURC:1.00&nostr=npub1e2yuky03caw4ke3zy68lg0fz3r4gkt94hx4fjmlelacyljgyk79svn3eef&orderid=9f2c14ab7e5d4083b6a1cc90de3f7721
defito://bnbchain,solana,ethereum,tron/coffeeshop@swap-provider.com&amount=USDT,USDC,PYUSD:1.18&nostr=npub1e2yuky03caw4ke3zy68lg0fz3r4gkt94hx4fjmlelacyljgyk79svn3eef&orderid=9f2c14ab7e5d4083b6a1cc90de3f7721
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
    ["i","request_code"],
    ["expiration","1750582800"]
  ],
  "content": "AgB8xK2v...==",
  "sig": "…"
}
```
Server: read `i:request_code` → decrypt → validate every line is a `defito://` invoice → `store.mint(uri, clampToSkew(created_at))` → 8-digit code (SQLite row), valid 5 min from the merchant's `created_at`, retained 1 h. Anything else → `i:code` with `Invalid Request` (a reason, not a code) + 24h blacklist (see error variant). A `defito://` payload the wallet would refuse at redeem gets the same reply WITHOUT the blacklist: a broken client is not an attacker. That covers a missing `<networks>/<recipients>`, `amount=`, `orderid=` or decodable `nostr=<npub>`, a broken `amount=` shape (`USDT:`, `:5`), hidden/bidi/markup characters anywhere in the payload, and more than 20 lines - each one mirroring a screen the wallet runs, because a code that mints here and dies at redeem leaves the merchant nothing to act on. The payload is judged TRIMMED, like the wallet judges it, and only ONE line has to be redeemable: the wallet drops a rail it cannot parse and pays from the rest, so an empty or half-built rail beside a good one still mints. Past that the server validates nothing - networks, coins, address formats and amount values are the wallet's business, and it holds plaintext it never needed to understand. `orderid` is likewise opaque: we check it is PRESENT and never look at its contents, so the wallet is free to change how it mints one.

## Hop 2 — middleman → merchant (`i: code`)

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
    ["i","code"],
    ["expiration","1750582801"]
  ],
  "content": "AgQ1mP9t...==",
  "id": "…", "sig": "…"
}
```
Merchant matches by `["e", <its request id>]`, decrypts → shows `42891337`.

## Hop 3 — customer → middleman (`i: request_uri`)

Up to *any* number of customers can redeem the same code within the 5-min
window — each sends their own event. Decrypted `content`:
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
    ["i","request_uri"],
    ["expiration","1750582860"]
  ],
  "content": "AgZ7nR4s...==",
  "sig": "…"
}
```
Server: `store.redeem("42891337")` → found + unexpired → returns URI. **Not consumed** — the code stays valid for other customers until it expires.

## Hop 4 — middleman → customer (`i: uri`)

Decrypted `content` (same multi-option URI the merchant sent):
```
defito://base/0x075eC7591B346391cBe5BdEc297bB1C80D335807&amount=EURC:1.00&nostr=npub1e2yuky03caw4ke3zy68lg0fz3r4gkt94hx4fjmlelacyljgyk79svn3eef&orderid=9f2c14ab7e5d4083b6a1cc90de3f7721
defito://bnbchain,solana,ethereum,tron/coffeeshop@swap-provider.com&amount=USDT,USDC,PYUSD:1.18&nostr=npub1e2yuky03caw4ke3zy68lg0fz3r4gkt94hx4fjmlelacyljgyk79svn3eef&orderid=9f2c14ab7e5d4083b6a1cc90de3f7721
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
    ["i","uri"],
    ["expiration","1750582861"]
  ],
  "content": "AgC2hW8q...==",
  "id": "…", "sig": "…"
}
```
Customer matches by `["e", <its request id>]`, decrypts → URI → `ingestPaymentUri` → confirm → pay.

## Error variant — bad / expired code (reuses the value intent, replaces hop 4)

There is **no `error` intent**. A failure reply carries the request's success
intent (`code` for a `request_code`, `uri` for a `request_uri`) but its `content`
is a reason string instead of a value. The client tells them apart by shape — an
8-digit code / one of our URI schemes is a value; anything else is an error
reason, whitelist-sanitised before display.

Decrypted `content`:
```
Code Not Found
```
Event tags: `["p", customer]`, `["e", <customer request id>]`, `["i","uri"]` (redeem
failure) or `["i","code"]` (mint failure), `["expiration", …]`.
`content` is one of:
- `"Code Expired"` — existed but past the 5-min validity (still retained, < 1 h old). Reply `i:uri`.
- `"Code Not Found"` — never minted, or past its 1-h retention (purged). Reply `i:uri`.
- `"Service Busy, Try Again"` — mint-time store overflow. Reply `i:code`.
- `"Invalid Request"` — a `request_code` whose decrypted payload was not
  `defito://`. Reply `i:code`. The sender is also **blacklisted for 24 h**;
  further events from them are dropped silently until the block lapses.

## Notes

- `content` shown decrypted — wire carries only NIP-44 v2 ciphertext + plaintext tags.
- Intent is the `["i",<intent>]` tag (signed → authenticated); no `type` field, no `requestId`.
- Correlation is the `["e", <request-event-id>]` reply tag.
- Server subscription: `{ kinds:[4], "#p":[MID], "#i":["request_code","request_uri"] }`.
- Code validity = 5 min, anchored to the merchant request's `created_at` (skew-clamped). Multi-use, unlimited redemptions within the window. Lapsed codes stay redeemable-as-`Code Expired` for 1 h, then purge to `Code Not Found`.
- Relay retention = NIP-40 `expiration` = `created_at + 1 h` on every event (maintenance buffer, unrelated to code validity).
- **Active cleanup**: after a reply's 1-hour expiration, the middleman publishes a NIP-09 `kind 5`
  deletion referencing its own reply event ids (batched), since NIP-40 is advisory and not all relays honor
  it. Example: `{ "kind":5, "tags":[["k","4"],["e","<reply-id>"],…], "content":"regby expired" }`. Only the
  middleman's own events — inbound merchant/customer events are theirs to delete.
- **Persistence**: the code store is SQLite (`node:sqlite`, base `REGBY_DB_PATH`), so codes survive a
  restart — a reboot no longer makes prior codes `Code Not Found`. The deletion queue stays in-memory
  (covers replies from the current process; older ones fall back to NIP-40 relay expiry), so there's no
  boot wipe of own events.
- **Daily rotation**: a new SQLite file is opened per UTC day (nested `YYYY/MM/regby-YYYY-MM-DD.db` from `REGBY_DB_PATH`),
  switched at 00:00 UTC; old files are kept on disk. Only the current day's file is read/written, so a code
  minted just before midnight is unreachable after the roll (current-day-only). Each row also stores a
  `created_at` audit column (wall-clock mint time).
