# regby-middleware

Nostr broker for **ReGBY**: BLIK-style 8-digit codes for the zenten-pay
wallet.

A merchant sends the broker any text (typically a `defito://` payment
request) in an encrypted Nostr DM and gets back an 8-digit code. The customer
types the code into their wallet, which sends it to the broker and receives
the merchant's text. The broker then tells each side who the other was. Codes
live one minute and work once.

```
merchant POS                    broker                      customer wallet
     │ request_regby_code ──────▶ │                                │
     │ ◀──────────── regby_code   │                                │
     │      (shows 42891337)      │ ◀──── request_regby_content    │
     │                            │ ────── regby_content + from ──▶│
     │ ◀── regby_content_delivered + to                            │
```

Every hop is a NIP-04 encrypted kind 4 DM on dedicated relays. The broker
holds **no funds and no wallet keys**, only its own Nostr key, and never
interprets the content it carries: validating it is the recipient's job.

## Documentation

| doc | for |
| --- | --- |
| [docs/protocol.md](docs/protocol.md) | Wire format, intents, failure states, code lifecycle, safeguards |
| [docs/flow-examples.md](docs/flow-examples.md) | Every event of a full exchange, tag by tag |
| [docs/configuration.md](docs/configuration.md) | Every environment variable, for the broker and the audit sink |
| [docs/deployment.md](docs/deployment.md) | Containers, audit sink setup, CI deploy, operations, backups, upgrades |
| [docs/audit-events.md](docs/audit-events.md) | The audit table: columns, events, reasons |
| [docs/audit-queries.sql](docs/audit-queries.sql) | Ready-made audit queries |
| [docs/recipient-checks.md](docs/recipient-checks.md) | Content checks the app must do, now that the broker does none |

## Quick start

Requires Node 22.5 or newer (`node:sqlite`).

```bash
npm install
cp .env.example .env      # set REGBY_PRIVATE_KEY and REGBY_RELAYS
npm run dev               # broker, restarts on change
```

The boot log prints the broker's `pubkey`: the app must hardcode the same
value as `REGBY_MIDDLEMAN_PUBKEY`. Set `REGBY_EXPECTED_PUBKEY` to have the
broker check it. Use a separate key for local runs, or the local broker will
answer production traffic on the shared relays.

### With Docker

```bash
docker compose up -d --build                       # broker only
docker compose -f docker-compose.yml -f docker-compose.audit.yml up -d --build   # broker + audit sink
```

Full setup, including the audit database and CI: [docs/deployment.md](docs/deployment.md).

### Audit sink locally

The sink needs a Postgres reachable over verified TLS and its CA file.

```bash
# in .env, alongside the broker's settings:
#   REGBY_AUDIT_URL=http://127.0.0.1:8787/events
#   REGBY_AUDIT_TOKEN=<32+ characters>
#   REGBY_AUDIT_DATABASE_URL=postgres://...
#   REGBY_AUDIT_DATABASE_CA=certs/db-ca.pem
npm run dev:audit-sink    # in a second terminal
```

## Scripts

| script | does |
| --- | --- |
| `npm run dev` / `npm run dev:audit-sink` | Run from source with `tsx`, reload on change |
| `npm run build` | Compile to `dist/` (tests excluded) |
| `npm start` / `npm run start:audit-sink` | Run the compiled build |
| `npm run typecheck` | `tsc --noEmit` over sources and tests |
| `npm test` | Node test runner. The Postgres tests run only with `REGBY_AUDIT_TEST_DATABASE_URL` and `REGBY_AUDIT_TEST_DATABASE_CA` set |

## Layout

| path | role |
| --- | --- |
| `src/index.ts` | Broker entry point, graceful shutdown |
| `src/server.ts` | Broker: dedup, rate limits, dispatch of mint and redeem |
| `src/protocol.ts` | Intents, tags, envelope checks (binary, size, code shape) |
| `src/nostr.ts` | Relay pool, NIP-42 AUTH, NIP-04, publish, NIP-09 deletions |
| `src/store.ts` | SQLite code store, per-UTC-day file rotation |
| `src/config.ts` | Broker config loading and boot-time checks |
| `src/env.ts` | Env readers shared by both config loaders |
| `src/rate-limit.ts`, `src/blacklist.ts` | Sliding-window limiter, guesser block list |
| `src/bounded-map.ts`, `src/deletion-queue.ts` | Bounded seen-id set, pending NIP-09 deletions |
| `src/audit.ts` | Audit wire contract shared by broker and sink |
| `src/audit-sender.ts` | Broker side: bounded queue, batched POST, backoff |
| `src/audit-sink/` | Audit service: HTTP intake, Postgres history, retention |
| `src/logger.ts`, `src/process.ts`, `src/time.ts` | JSON logging, process lifecycle, clocks |
