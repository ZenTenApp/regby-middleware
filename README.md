# regby-middleware

Nostr middleman broker for **ReGBY** - BLIK-style coded payment requests for the
zenten-pay wallet. A merchant encrypts a `defito://` request to this server's
npub; the server mints a short **8-digit code** and returns it. A customer
redeems the code; the server returns the original URI.

A `defifrom://` payment **confirmation** never passes through here. It is sent
straight to the npub named in the invoice it answers, so there is nothing for a
middleman to do: this broker exists to squeeze an invoice into eight digits a
customer can type, and nobody types a confirmation. Every hop is a
**NIP-04 encrypted** Nostr **DM (kind 4)**.

This server holds **no funds and no wallet keys** - only its own Nostr identity
key, used to decrypt requests and sign replies.

See [`src/flow-examples.md`](src/flow-examples.md) for full event examples.

## Protocol

Encrypted **DM (kind 4)**. `content` is the **raw value** (NIP-04 ciphertext on
the wire): a `defito://` URI (possibly multi-line / multi-option) or the bare
eight-digit code - no JSON wrapper.

NIP-04 is the required scheme on this kind, in both directions. It is
deprecated and unauthenticated, and it is what every client reading these
relays opens a kind 4 with - a NIP-44 payload here is not a message the other
side reports as broken, it is one it never sees. Sender authenticity therefore
comes from the event signature alone, never from a successful decrypt.

- **Intent** rides the `['i', <intent>]` tag (single-letter → relay-indexable):
  `request_regby_code` / `regby_code` / `request_regby_content` / `regby_content`.
- **No `error` intent**: a failure reuses the request's success intent
  (`regby_code` for a `request_regby_code`, `regby_content` for a
  `request_regby_content`) and carries the reason string in `content`. The client tells a value from an error by the content's **shape**
  (8 digits / a `defito://` prefix) and whitelist-sanitises anything else - the
  middleman is untrusted, so a free error-text channel was a hole into the UI.
- **Correlation** is the `['e', <request-event-id>]` reply tag - the client
  matches a reply to the request it published. No in-band id.
- **Routing**: `['p', recipientHex]`. **Retention**: `['expiration', unixSec]`
  (NIP-40) = `created_at + 1 h` on every event - a maintenance/retention buffer
  only, unrelated to code validity.

| direction          | `i` tag                 | `content` (decrypted)        |
| ------------------ | ----------------------- | ---------------------------- |
| merchant → server  | `request_regby_code`    | `defito://…` URI             |
| server → merchant  | `regby_code`            | `42891337` *or* reason       |
| customer → server  | `request_regby_content` | `42891337`                   |
| server → customer  | `regby_content`         | `defito://…` URI *or* reason |

## Behaviour

- **request_regby_code** → validate every line is a `defito://` invoice, mint a
  unique 8-digit code, store
  `code → { uri, expiresAt, retainUntil }`, reply `i:regby_code` with the requester's
  event id in `e`. **Code validity (2 min) is anchored to the request
  event's `created_at`**, not server receive-time, so the merchant POS and the
  server count down from the same origin - the merchant already knows that
  timestamp (it signed the event), so no echo is needed. `created_at` is
  skew-clamped (`REGBY_CLOCK_SKEW_SECONDS`) to stop a forged future/stale stamp
  from gaming expiry.
- Two ways a `request_regby_code` is refused, and they differ by what they cost the
  sender. A payload that is **not `defito://`** is deliberate (the sender proved
  they hold the conversation key), so the server replies `i:regby_code` with
  `Invalid Request` and **blacklists them for 24 h** (`REGBY_BLACKLIST_SECONDS`).
  A `defito://` payload the **wallet would refuse at redeem** gets the same
  reply and **no blacklist**: that is a broken client, and a day-long lockout
  would make a POS bug look like an outage. Undecryptable noise and malformed
  codes are still dropped silently.
- What earns that softer refusal is exactly what the wallet screens, mirrored
  field for field: a missing `<networks>/<recipients>`, `amount=`, `orderid=`
  or decodable `nostr=<npub>`; an `amount=` whose shape is broken (`USDT:` is a
  truncated amount, `:5` names no coin); hidden, bidi or markup characters
  anywhere in the payload, read both as written and as the wallet will decode
  them; and more than 20 lines, past which the wallet drops the surplus and
  would show a request the merchant never wrote. The payload is judged
  **trimmed**, as the wallet judges it, and `nostr=` is read as leniently
  (a `nostr:` prefix and any casing decode the same). A payload that passes
  here and fails there is an eight-digit code that mints and never redeems,
  with no reason the merchant can act on, so `src/protocol.test.ts` pins the
  accepted and refused fixtures against the app's copy of the same list.
- A multi-line payload needs **one** redeemable rail, not every rail. The
  wallet drops a line it cannot parse and pays from the rest, so refusing the
  whole payload here costs the merchant a code the customer could have paid
  over a rail the wallet was never going to show. An empty `defito://` rail is
  likewise a broken client, never a foreign scheme: it must not earn the
  blacklist.
- Nothing past that is validated here, on purpose. Chain names, coin symbols,
  address formats and amount values come from a stablecoin registry that updates
  without a server deploy, so a list frozen here would start refusing valid
  payloads the day a chain is added. `orderid` is likewise opaque: we check it
  is present, never what it contains. The wallet re-validates all of it at
  redeem, where the registry lives - and must anyway, since this server is
  untrusted and nothing it approves is a safety guarantee.
- **request_regby_content** → look up the code. Valid → reply `i:regby_content` with the URI.
  **Single-use**: the first successful redeem consumes the code and wipes its
  URI. A code expires after 2 min or its first use, whichever comes first; the
  60s sweep wipes the URI of lapsed codes, and day rotation wipes any left in
  the outgoing file. Expired but still **retained** (within 1 h of its
  `created_at`) → `i:regby_content` `Code Expired`; never minted or past retention →
  `i:regby_content` `Code Not Found` (reason in `content`, not a URI).
- **Persistence**: the code store is **SQLite** (`node:sqlite`, file derived from
  `REGBY_DB_PATH`), so codes survive a restart - a reboot no longer makes every
  code `Code Not Found`. Each row carries `created_at` (wall-clock mint, audit
  only), `expires_at` (validity) and `retain_until`
  (`created_at + REGBY_CODE_RETAIN_SECONDS`); rows past retention are swept on a
  60s timer (also stale rate buckets + blacklist entries).
- **Daily rotation**: a new SQLite file is opened per **UTC day**
  (nested `YYYY/MM/regby-YYYY-MM-DD.db` derived from `REGBY_DB_PATH`), switched at 00:00 UTC; old
  files are kept on disk as a daily archive. Only the current day's file is read
  or written - a code minted just before midnight is unreachable after the roll
  even within its retention window (a deliberate current-day-only trade).
- **Active deletion**: once a reply's `expiration` lapses, the server publishes a
  **NIP-09 `kind 5`** deletion for its own reply events (batched). NIP-40
  expiration is advisory - many relays ignore it - so we delete actively. Only the
  middleman's own events; inbound merchant/customer events are theirs to delete.
  The deletion queue is in-memory, so it covers replies from the current process
  lifetime; older replies fall back to NIP-40 relay expiry. (There is no boot wipe
  of own events anymore - codes persist, so prior replies aren't orphaned.) NB: on
  the dedicated `wss://dm1.zentext.me` / `wss://dm2.nostr.box` relays (kind 4
  ONLY), these kind-5 deletions
  are rejected, so active deletion no-ops there - retention then rests entirely on
  the NIP-40 `expiration` tag, which those relays enforce (and cap at 72h).
- **Dedicated DM relays**: ReGBY runs on `wss://dm1.zentext.me` and
  `wss://dm2.nostr.box` - operator-run,
  ReGBY-only, kind 4 ONLY, NIP-40 expiration capped at 72h, content capped at
  4 KB. `REGBY_RELAYS` must match the app's `config/nostr.ts → REGBY_RELAYS`.
- **Subscription keep-alive**: a single long-lived REQ goes deaf when a relay
  drops the idle connection (nostr-tools won't re-open it), so the server
  re-subscribes every 120s (re-opening any dropped socket). The new REQ overlaps
  `since`; re-delivered events are filtered by the seen-id set, so no gap and no
  double-mint.

### Safeguards

- Per-sender sliding-window rate limit (`REGBY_RATE_MAX` / window).
- Global redeem rate ceiling (`REGBY_REDEEM_RATE_MAX`) plus per-sender
  not-found strikes (`REGBY_REDEEM_FAIL_MAX` → blacklist): bounds code-space
  enumeration / URI harvesting even by an attacker rotating fresh pubkeys.
- 24 h blacklist for senders that submit a malicious `request_regby_code`.
- Code-TTL anchor (`created_at`) skew-clamped so expiry can't be gamed.
- Store capacity cap (`REGBY_STORE_MAX`) - mints past it reply `i:regby_code` with
  `Service Busy, Try Again` (a reason, not a code).
- Processed event ids are remembered so a relay re-delivery can't double-mint.
- Strict content validation; length caps.
- Decrypted URIs / live codes are logged only at `debug`.

> **Trust note.** Between mint and redeem the server holds the plaintext
> `defito://` URI, so a compromised server could hand the customer a different
> recipient. The customer still confirms recipient + amount on-device before
> signing. Future hardening (out of scope): merchant signs the URI, customer
> verifies against the merchant npub.

## Run

```bash
cp .env.example .env      # set REGBY_PRIVATE_KEY + REGBY_RELAYS
npm install
npm run typecheck
npm test
npm run dev               # tsx watch
# production:
npm run build && npm start
```

The boot log prints the derived public key - copy it into the app's
`REGBY_MIDDLEMAN_PUBKEY` constant. Set `REGBY_EXPECTED_PUBKEY` to have the server
assert that match itself.

## Layout

| file                | role                                              |
| ------------------- | ------------------------------------------------- |
| `src/protocol.ts`   | intent/tag + raw-content validation (mirrors app) |
| `src/config.ts`     | env loading, key decode, pubkey derivation        |
| `src/nostr.ts`      | relay pool, NIP-04 encrypt/decrypt, publish       |
| `src/store.ts`      | SQLite code → URI store (2-min validity, single-use, 1-h retention) + per-UTC-day file rotation |
| `src/rate-limit.ts` | per-pubkey sliding window                         |
| `src/blacklist.ts`  | 24h block list for malicious senders              |
| `src/deletion-queue.ts` | tracks own reply ids → due NIP-09 deletions   |
| `src/server.ts`     | broker: dedup, dispatch request_regby_code/request_regby_content  |
| `src/index.ts`      | entry + graceful shutdown                         |
