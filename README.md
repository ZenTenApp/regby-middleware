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
  event id in `e`. **Code validity (1 min) is anchored to the request
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
  codes are still dropped silently, and so is **binary content**: NIP-04
  decrypt decodes UTF-8 leniently, so encrypted bytes (an image, a file) arrive
  as text carrying `U+FFFD` or NUL/control characters. Any of those, other
  than tab and line breaks, drops the event before every other screen, with no
  reply and nothing stored (logged as `Binary content - dropping`).
- What earns that softer refusal is exactly what the wallet screens, mirrored
  field for field: a missing `<networks>/<recipients>`, `amount=`, `order_id=`
  or decodable `nostr=<npub>`; a missing or malformed `valid_until=` (unix
  seconds as a plain positive integer - whether it has PASSED is the wallet's
  call, on its own clock); an `amount=` whose shape is broken (`USDT:` is a
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
  payloads the day a chain is added. `order_id` is likewise opaque: we check it
  is present, never what it contains. The wallet re-validates all of it at
  redeem, where the registry lives - and must anyway, since this server is
  untrusted and nothing it approves is a safety guarantee.
- **request_regby_content** → look up the code. Valid → reply `i:regby_content` with the URI.
  **Single-use**: the first successful redeem consumes the code and wipes its
  URI. A code expires after 1 min or its first use, whichever comes first; the
  60s sweep wipes the URI of lapsed codes and checkpoints the WAL so no copy
  lingers there; shutdown wipes lapsed ones too, and day rotation wipes every
  URI left in the outgoing file. Consume happens before the reply is
  published, so a reply no relay accepted still burns the code (logged as a
  warning); the merchant re-mints. While the row is **retained** (within 1 h of
  the merchant's request): already redeemed → `i:regby_content` `Code Already Redeemed`
  (inside its 1-min validity or past it, the row's `redeemed_at` says so);
  lapsed and never redeemed → `Code Expired`. Never minted or past retention →
  `Code Not Found` (reason in `content`, not a URI).
- **Persistence**: the code store is **SQLite** (`node:sqlite`, file derived from
  `REGBY_DB_PATH`), so codes survive a restart - a reboot no longer makes every
  code `Code Not Found`. Each row carries `created_at` (wall-clock mint),
  `expires_at` (validity), `retain_until` (answer window,
  `REGBY_CODE_RETAIN_SECONDS`, after which redeem says `Code Not Found`) and
  `redeemed_at`.
- **No code reuse for 24 h**: a row is deleted only 24 h after its
  `created_at`, so its number cannot be issued again before then, even across
  midnight or a restart. A customer holding an old code can never open someone
  else's invoice with it. Fixed, not configurable. Rows past 24 h are swept on
  a 60s timer (also stale rate buckets + blacklist entries).
- **Daily rotation**: a new SQLite file is opened per **UTC day**
  (nested `YYYY/MM/regby-YYYY-MM-DD.db` derived from `REGBY_DB_PATH`), switched at 00:00 UTC; old
  files are kept on disk as a daily archive. Only the current day's file is
  read or written, but opening it (at the roll, or on startup) copies in the
  previous day's codes from the last 24 h, so midnight neither frees their
  numbers nor cuts short a code minted at 23:59. Archived files keep no
  invoices: the roll wipes the file it leaves, and startup wipes every older
  file, so a server down across several midnights leaves none behind either.
- **Audit log**: one record per request the server answered (or a guesser it
  blacklisted), sent to a separate **audit sink** on another machine; the
  broker keeps none of it on disk. Events: `code_issued`, `regby_busy`, `redeem`,
  `redeem_refused` (`detail` = `expired` / `redeemed` / `not-found`),
  `invalid_request` (`malformed`), `blacklisted` (`malicious` / `guessing`).
  Each carries the server time, the **full** sender pubkey, the request event
  id, the code, and `delivered` (did the reply reach a relay). A **served**
  request also carries the full invoice and its earliest `valid_until`; a
  refused payload is sent only as its length and an HMAC-SHA256 keyed with
  `REGBY_AUDIT_TOKEN`, never as text: the token holder can match a merchant's
  report against it, a leaked copy of the history alone can't.
  Requests dropped before any work (blacklisted, rate-limited, undecryptable)
  are not recorded. Delivery is best-effort: a bounded in-memory queue
  (`REGBY_AUDIT_QUEUE_MAX`) retries with backoff while the sink is down and
  drops the oldest records when full; a restart loses what is still queued.
- **Active deletion**: once a reply's `expiration` lapses, the server publishes a
  **NIP-09 `kind 5`** deletion for its own reply events (batched). NIP-40
  expiration is advisory - many relays ignore it - so we delete actively. Only the
  middleman's own events; inbound merchant/customer events are theirs to delete.
  The deletion queue is in-memory, so it covers replies from the current process
  lifetime; older replies fall back to NIP-40 relay expiry. (There is no boot wipe
  of own events anymore - codes persist, so prior replies aren't orphaned.) NB: on
  the dedicated DM relays (`REGBY_RELAYS`, kind 4
  ONLY), these kind-5 deletions
  are rejected, so active deletion no-ops there - retention then rests entirely on
  the NIP-40 `expiration` tag, which those relays enforce (and cap at 72h).
- **Dedicated DM relays**: ReGBY runs on `wss://dm1.zentext.me`,
  `wss://dm2.nostr.box` and `wss://dm3.npub.cx` - operator-run,
  ReGBY-only, kind 4 ONLY, NIP-40 expiration capped at 72h, content capped at
  4 KB. `REGBY_RELAYS` must match the app's `config/nostr.ts → REGBY_RELAYS`.
- **Subscription keep-alive**: a single long-lived REQ goes deaf when a relay
  drops the idle connection (nostr-tools won't re-open it), so the server
  re-subscribes every 120s (re-opening any dropped socket). The new REQ overlaps
  `since`; re-delivered events are filtered by the seen-id set, so no gap and no
  double-mint.

### Safeguards

- Per-sender sliding-window rate limit (`REGBY_RATE_MAX` / window).
- Global mint rate ceiling (`REGBY_MINT_RATE_MAX`), sized so a full day of it
  fits `REGBY_STORE_MAX`: a flood from fresh pubkeys can't fill the store and
  leave merchants on `Service Busy` for the 24 h its rows are held.
- Global redeem rate ceiling (`REGBY_REDEEM_RATE_MAX`) plus per-sender
  not-found strikes (`REGBY_REDEEM_FAIL_MAX` → blacklist): bounds code-space
  enumeration / URI harvesting even by an attacker rotating fresh pubkeys.
- 24 h blacklist for senders that submit a malicious `request_regby_code`.
- Code-TTL anchor (`created_at`) skew-clamped so expiry can't be gamed.
- Store capacity cap (`REGBY_STORE_MAX`, codes issued in any 24 h) - mints past
  it reply `i:regby_code` with `Service Busy, Try Again` (a reason, not a code).
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

### Docker

```bash
docker compose up -d --build
docker compose logs regby | grep dbPath   # must print /data/regby.db
```

The code store lives on the host in `./data` (override with `REGBY_DATA_DIR`
in `.env`), bind-mounted at `/data`, as `YYYY/MM/regby-YYYY-MM-DD.db`. It
survives rebuilds, container recreation, `docker compose down -v` and
`docker volume prune`. Compose pins `REGBY_DB_PATH=/data/regby.db`, so `.env`
cannot move the store off the mount.

The container runs as root, so the files are root-owned: run the commands
below as root (or with `sudo`).

**Backups**: past days' files are closed and safe to copy as-is. Today's file
is live (WAL mode); copy it with
`sqlite3 data/YYYY/MM/regby-<today>.db ".backup today.db"`, not `cp`.

**Migrating from the old named volume** (`regby-data`): stop the service, copy
the volume into the new folder, then start the new setup. The volume name
carries the compose project name (the repo folder by default), so confirm it
first.

```bash
docker volume ls | grep regby-data        # e.g. regby-middleware_regby-data
docker stop regby                         # closes today's db cleanly
mkdir -p data
cp -a "$(docker volume inspect -f '{{.Mountpoint}}' regby-middleware_regby-data)/." data/
find data -name 'regby-*.db' | wc -l      # one file per day served so far
docker compose up -d --build
```

Once the new setup has run cleanly for a few days, drop the old volume:
`docker volume rm regby-middleware_regby-data`.

If the old deploy had `REGBY_DB_PATH=regby.db` in `.env`, the files were in the
container under `/app/YYYY/...` instead. Copy out each year folder with
`docker cp regby:/app/YYYY ./data/` while the old container still exists, i.e.
before `docker compose up` recreates it.

### Audit sink

Runs on the audit machine, from this repo, as its own container. It stores
the history in one SQLite file, forces the folder to 0700 and the file to
0600, deletes records older than `REGBY_AUDIT_RETAIN_DAYS` (default 365) and
caps the table at `REGBY_AUDIT_MAX_ROWS` (oldest first). **This is a payment
history** (merchant and customer pubkeys, recipients, amounts): back it up and
restrict access like any customer database.

```bash
cp .env.audit-sink.example .env.audit-sink   # set REGBY_AUDIT_TOKEN
docker compose -f docker-compose.audit-sink.yml up -d --build
```

The sink speaks plain http on the host's loopback (`127.0.0.1:8787`). Put a
TLS proxy in front, e.g. Caddy: `audit.example.com { reverse_proxy 127.0.0.1:8787 }`.
Then on the broker set `REGBY_AUDIT_URL=https://audit.example.com/events` and
the same `REGBY_AUDIT_TOKEN`.

```bash
# everything that happened to one code
sqlite3 audit-data/audit.db \
  "SELECT datetime(ts,'unixepoch'), event, pubkey, detail, delivered FROM events WHERE code='48213907' ORDER BY ts"
```

## Layout

| file                | role                                              |
| ------------------- | ------------------------------------------------- |
| `src/protocol.ts`   | intent/tag + raw-content validation (mirrors app) |
| `src/config.ts`     | env loading, key decode, pubkey derivation        |
| `src/nostr.ts`      | relay pool, NIP-04 encrypt/decrypt, publish       |
| `src/store.ts`      | SQLite code → URI store (1-min validity, single-use, 1-h retention) + per-UTC-day file rotation |
| `src/audit.ts`      | audit wire contract (record shape, validation, payload redaction) |
| `src/audit-sender.ts` | broker side: bounded queue, batched HTTPS POST, backoff |
| `src/audit-sink/`   | the external audit service: HTTP intake, SQLite history, retention |
| `src/env.ts`        | env readers shared by both config loaders         |
| `src/rate-limit.ts` | per-pubkey sliding window                         |
| `src/blacklist.ts`  | 24h block list for malicious senders              |
| `src/deletion-queue.ts` | tracks own reply ids → due NIP-09 deletions   |
| `src/server.ts`     | broker: dedup, dispatch request_regby_code/request_regby_content  |
| `src/index.ts`      | entry + graceful shutdown                         |
