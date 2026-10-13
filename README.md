# regby-middleware

Nostr middleman broker for **ReGBY** - BLIK-style codes for the zenten-pay
wallet. ReGBY is a **transport**: one peer (the merchant) encrypts any text to
this server's npub - a `defito://` request, anything else, or nothing at all.
The server never reads it. It mints a short **8-digit
code** and returns it. Another peer (the customer) redeems the code; the server
returns the original content, then **pairs the two peers**: the customer learns
who the content came from (`from`) and the merchant who received it
(`deliver_to`).

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
the wire): the sender's content, any text up to 4096 characters (empty
included), or the bare eight-digit code - no JSON wrapper. **Judging the
content is the recipient's job**: a `defito://` invoice is validated by the
wallet that receives it, never by this server. The only content refused here
is binary (see Behaviour).

NIP-04 is the required scheme on this kind, in both directions. It is
deprecated and unauthenticated, and it is what every client reading these
relays opens a kind 4 with - a NIP-44 payload here is not a message the other
side reports as broken, it is one it never sees. Sender authenticity therefore
comes from the event signature alone, never from a successful decrypt.

- **Intent** rides the `['i', <intent>]` tag (single-letter → relay-indexable):
  `request_regby_code` / `regby_code` / `request_regby_content` / `regby_content`,
  plus `regby_redeemed`, the server's notice to the merchant after a redeem.
- **No `error` intent**: a failure reuses the request's success intent
  (`regby_code` for a `request_regby_code`, `regby_content` for a
  `request_regby_content`) and carries one of the fixed `REPLY_REASON`
  strings in `content`. The client whitelist-sanitises any reason it shows -
  the middleman is untrusted, so a free error-text channel was a hole into the
  UI. Content is any text, so its shape no longer tells a value from an
  error. The signal is the **`from` tag**: a successful `regby_content`
  always carries it, a failure never does. (Codes minted before origins were
  stored redeem without it; they last at most the 1-minute code life after
  the deploy.) A `regby_code` value is always eight digits.
- **Correlation** is the `['e', <request-event-id>]` reply tag - the client
  matches a reply to the request it published. No in-band id.
- **Routing**: `['p', recipientHex]`. **Retention**: `['expiration', unixSec]`
  (NIP-40) = `created_at + REGBY_EVENT_EXPIRY_SECONDS` (default 72 h less a
  minute, the DM relays' cap) on every event - a maintenance/retention buffer
  only, unrelated to code validity.

| direction          | `i` tag                 | `content` (decrypted)        |
| ------------------ | ----------------------- | ---------------------------- |
| merchant → server  | `request_regby_code`    | any text (e.g. `defito://…`) |
| server → merchant  | `regby_code`            | `42891337` *or* reason       |
| customer → server  | `request_regby_content` | `42891337`                   |
| server → customer  | `regby_content`         | that text *or* reason        |
| server → merchant  | `regby_redeemed`        | `42891337`                   |

After a successful redeem the customer's `regby_content` also carries
`['from', <merchant npub>]`, and the server sends the merchant `regby_redeemed`
with `['e', <merchant's request id>]` and `['deliver_to', <customer npub>]`,
whether or not the customer's reply reached a relay (the code is used up
either way). The merchant npub is the key that signed the request, not the
invoice's own `nostr=`. **These tags are plaintext**: anyone reading the relay
sees which merchant and customer met. A refused redeem sends neither.

Empty content is a valid `request_regby_code` payload and runs the same five
events: the customer's `regby_content` carries an (encrypted) empty string, and
the `from` / `deliver_to` tags pair the two peers. Whitespace-only content is
still dropped as noise.

## Behaviour

- **request_regby_code** → mint a unique 8-digit code for the content as sent
  (verbatim, not trimmed), store
  `code → { content, expiresAt, retainUntil, merchant, request event }`, reply `i:regby_code` with the requester's
  event id in `e`. **Code validity (1 min) is anchored to the request
  event's `created_at`**, not server receive-time, so the merchant POS and the
  server count down from the same origin - the merchant already knows that
  timestamp (it signed the event), so no echo is needed. `created_at` is
  skew-clamped (`REGBY_CLOCK_SKEW_SECONDS`) to stop a forged future/stale stamp
  from gaming expiry.
- **Content is opaque.** Any text is minted, whatever it says: a `defito://`
  invoice, a foreign scheme, plain text, whitespace or nothing. There is no
  `Invalid Request` and no blacklist for content any more. What is dropped
  silently, with no reply and nothing stored: content over 4096 characters,
  undecryptable noise, and **binary content**: NIP-04 decrypt decodes UTF-8
  leniently, so encrypted bytes (an image, a file) arrive as text carrying
  `U+FFFD` or NUL/control characters. Any of those, other than tab and line
  breaks, drops the event (logged as `Binary content - dropping`).
- **The recipient validates.** The wallet re-validates a `defito://` invoice
  at redeem, where its registry lives, and must screen any content it renders
  (hidden, bidi or markup characters included): this server is untrusted and
  now approves nothing.
- **request_regby_content** → look up the code. Valid → reply `i:regby_content` with the content.
  **Single-use**: the first successful redeem consumes the code. A code
  expires after 1 min or its first use, whichever comes first. The live file
  keeps every code's content, used or lapsed, until the row is deleted 24 h after
  issue, so recent codes can be debugged straight from the db; day rotation
  wipes every content left in the outgoing file. Consume happens before the reply is
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
  blacklisted), sent to a separate **audit sink** process that stores it in a
  remote Postgres; nothing of it is kept on disk. Events: `code_issued`, `regby_busy`, `redeem`,
  `redeem_refused` (`reason` = `expired` / `redeemed` / `not-found`),
  `blacklisted` (`guessing`), `merchant_notified`.
  Each carries the server time, the **full** sender pubkey, the request event
  id, the code, and `delivered` (did the reply reach a relay). A **served**
  request also carries the full content.
  Requests dropped before any work (blacklisted, rate-limited, undecryptable)
  are not recorded. Delivery is best-effort: a bounded in-memory queue
  (`REGBY_AUDIT_QUEUE_MAX`) retries with backoff while the sink is down and
  drops the oldest records when full; a restart loses what is still queued.
  Every column, event and reason: [docs/audit-events.md](docs/audit-events.md).
  On its first start after the content change, the sink renames `uri` →
  `content` and `detail` → `reason` and **drops** `valid_until`,
  `payload_hmac` and `payload_length` (every later start is a no-op). Take a
  `pg_dump` first if those old values matter.
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
- Code-TTL anchor (`created_at`) skew-clamped so expiry can't be gamed.
- Store capacity cap (`REGBY_STORE_MAX`, codes issued in any 24 h) - mints past
  it reply `i:regby_code` with `Service Busy, Try Again` (a reason, not a code).
- Processed event ids are remembered so a relay re-delivery can't double-mint.
- Length cap (4096 characters) and a binary screen; no other content checks.
- Decrypted content / live codes are logged only at `debug`.

> **Trust note.** For 24 h after issue the server's live file holds the
> plaintext content, so a compromised server could hand the customer different
> content (for an invoice, a different recipient). The recipient must treat
> every content as untrusted: the wallet still validates an invoice and the
> customer confirms recipient + amount on-device before signing. Future hardening (out of scope): merchant signs the URI, customer
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

Runs on the broker's machine as its own container; the history itself lives
in a managed Postgres (table `events`, created on first start), never on this
disk. The sink deletes records older than `REGBY_AUDIT_RETAIN_DAYS` (default
365) and caps the table at `REGBY_AUDIT_MAX_ROWS` (oldest first). Only the
sink container holds the database credentials: the broker appends through the
token-guarded intake and can't read or delete history. TLS to the database is
always verified against the provider's CA (`REGBY_AUDIT_DATABASE_CA`). **This
is a payment history** (merchant and customer pubkeys, recipients, amounts):
give the sink its own database role, and restrict access to the database and
its backups like any customer database. Deleted rows stay in the provider's
backups for their retention window.

```bash
cp .env.audit-sink.example .env.audit-sink   # set REGBY_AUDIT_TOKEN and the database URL
mkdir -p certs && cp <provider-ca.pem> certs/db-ca.pem
# in .env: REGBY_AUDIT_TOKEN = the same value as in .env.audit-sink
docker compose -f docker-compose.yml -f docker-compose.audit.yml up -d --build
```

The broker reaches the sink by service name, `http://audit-sink:8787/events`
(set by the compose file), on the compose network; no port is published. Each
container keeps its own network, so a sink restart never takes the broker
offline: the broker queues records and retries. Without the second `-f`, the
broker runs with no audit. To make a plain `docker compose up -d --build`
include the audit on a server, set
`COMPOSE_FILE=docker-compose.yml:docker-compose.audit.yml` in its `.env`.

```bash
# everything that happened to one code
psql "$REGBY_AUDIT_DATABASE_URL?sslmode=verify-full&sslrootcert=certs/db-ca.pem" \
  -c "SELECT to_timestamp(ts), event, pubkey, reason, delivered FROM events WHERE code='48213907' ORDER BY ts"
```

## Layout

| file                | role                                              |
| ------------------- | ------------------------------------------------- |
| `src/protocol.ts`   | intents, tags, envelope checks (binary, size, code shape) |
| `src/config.ts`     | env loading, key decode, pubkey derivation        |
| `src/nostr.ts`      | relay pool, NIP-04 encrypt/decrypt, publish       |
| `src/store.ts`      | SQLite code → content + origin store (1-min validity, single-use, 1-h answer window, 24-h row) + per-UTC-day file rotation |
| `src/audit.ts`      | audit wire contract (record shape, validation)    |
| `src/audit-sender.ts` | broker side: bounded queue, batched POST (HTTPS, or http to a local sink), backoff |
| `src/audit-sink/`   | the audit service: HTTP intake, Postgres history, retention |
| `src/env.ts`        | env readers shared by both config loaders         |
| `src/rate-limit.ts` | per-pubkey sliding window                         |
| `src/blacklist.ts`  | 24h block list for code guessers                  |
| `src/deletion-queue.ts` | tracks own reply ids → due NIP-09 deletions   |
| `src/server.ts`     | broker: dedup, dispatch request_regby_code/request_regby_content  |
| `src/index.ts`      | entry + graceful shutdown                         |
