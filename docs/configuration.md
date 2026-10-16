# Configuration

Both processes read their settings from environment variables. Locally they
come from a `.env` file in the working directory (loaded with `dotenv`); under
Docker Compose each service gets its own file through `env_file`.

| process | template | file it reads |
| --- | --- | --- |
| broker (`src/index.ts`) | [`.env.example`](../.env.example) | `.env` |
| audit sink (`src/audit-sink/index.ts`) | [`.env.audit-sink.example`](../.env.audit-sink.example) | `.env.audit-sink` under Compose, `.env` for a local run |

Every value is validated at boot. A missing or malformed one stops the process
with `Fatal on boot` and a message naming the variable, so a bad deploy fails
loudly instead of running half configured. Integers must be positive.

## Broker

### Identity and relays

| variable | default | meaning |
| --- | --- | --- |
| `REGBY_PRIVATE_KEY` | required | The broker's Nostr secret key, 64 hex characters. Used to decrypt requests and sign replies. It holds no funds. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. |
| `REGBY_EXPECTED_PUBKEY` | unset | Hex public key the private key must derive to. When set, a mismatch stops the boot: protects against deploying the wrong key. The app hardcodes this key as `REGBY_MIDDLEMAN_PUBKEY`. |
| `REGBY_RELAYS` | required | Comma-separated `wss://` relay URLs. Must equal the app's `REGBY_RELAYS` (`config/nostr.ts`), or requests and replies never meet. |

### Code lifetime

| variable | default | meaning |
| --- | --- | --- |
| `REGBY_CODE_TTL_SECONDS` | `60` | How long a code can be redeemed, counted from the merchant request's `created_at`. Must match the app's `REGBY_CODE_TTL_MS`. |
| `REGBY_CODE_RETAIN_SECONDS` | `3600` | How long after the request a lapsed code answers `regby_code_expired`. After that it answers `regby_code_locked` until 72 h, then `regby_code_not_found`. |
| `REGBY_CLOCK_SKEW_SECONDS` | `30` | Tolerance between a request's `created_at` and the server clock. Stamps outside it are clamped so a forged time can't stretch a code's life. |
| `REGBY_EVENT_EXPIRY_SECONDS` | `259140` | NIP-40 `expiration` put on every published event (72 h less one minute). Relay retention only, unrelated to code validity. |

Boot checks: `CLOCK_SKEW < CODE_TTL`, `CODE_RETAIN >= CODE_TTL`,
`CODE_RETAIN + CLOCK_SKEW <= 259200` (72 h), and
`EVENT_EXPIRY <= 259200` (the DM relays reject events stamped further out).

The 72 h reuse window (a code number is never reissued within 72 h of its last
issue) is a constant, `CODE_REUSE_SECONDS` in `src/store.ts`, not a setting.

### Storage

| variable | default | meaning |
| --- | --- | --- |
| `REGBY_DB_PATH` | `regby.db` | Base path of the SQLite code store. The real files are derived from it, one per UTC day: `regby.db` becomes `YYYY/MM/regby-YYYY-MM-DD.db` next to it. Ignored under Compose, which pins `/data/regby.db`. |
| `REGBY_STORE_MAX` | `1500000` | Most codes issued in any 72 h. Mints beyond it answer `regby_code_busy`. |

### Abuse limits

| variable | default | meaning |
| --- | --- | --- |
| `REGBY_RATE_MAX` / `REGBY_RATE_WINDOW_SECONDS` | `30` / `60` | Events processed per sender per window. Excess is dropped silently. |
| `REGBY_MINT_RATE_MAX` / `REGBY_MINT_RATE_WINDOW_SECONDS` | `300` / `60` | Mints per window across all senders. Excess is dropped silently. |
| `REGBY_REDEEM_RATE_MAX` / `REGBY_REDEEM_RATE_WINDOW_SECONDS` | `300` / `60` | Redeems per window across all senders. Bounds code guessing by an attacker rotating fresh keys. |
| `REGBY_REDEEM_FAIL_MAX` | `10` | `not-found` or `locked` redeems one sender may make within the redeem window before it is blacklisted. |
| `REGBY_BLACKLIST_SECONDS` | `86400` | How long a blacklisted sender is ignored. |

Boot check: a full 72 h at the mint ceiling must fit the store,
`MINT_RATE_MAX * ceil(259200 / MINT_RATE_WINDOW) <= STORE_MAX`, so a flood
can't lock merchants out with `regby_code_busy` for three days. Raising the
mint ceiling means raising `REGBY_STORE_MAX` with it.

### Audit

Leave `REGBY_AUDIT_URL` unset to run without an audit log.

| variable | default | meaning |
| --- | --- | --- |
| `REGBY_AUDIT_URL` | unset | Sink intake, e.g. `http://audit-sink:8787/events`. Must be `https://`; plain `http://` is allowed only to `localhost`, `127.0.0.1`, `[::1]` or a dotless Compose service name. Set by `docker-compose.audit.yml`. |
| `REGBY_AUDIT_TOKEN` | required with the URL | Shared secret, at least 32 characters, equal to the sink's. `openssl rand -hex 32`. |
| `REGBY_AUDIT_QUEUE_MAX` | `10000` | Records buffered in memory while the sink is unreachable. Past it the oldest are dropped. |

### Logging

| variable | default | meaning |
| --- | --- | --- |
| `REGBY_LOG_LEVEL` | `info` | `error`, `warn`, `info` or `debug`. Logs are JSON lines on stdout (errors and warnings on stderr). **`debug` logs decrypted content and live codes**: never leave it on in production. |

### Compose only

Read by `docker compose` from `.env`, not by the broker.

| variable | default | meaning |
| --- | --- | --- |
| `REGBY_DATA_DIR` | `./data` | Host folder mounted at `/data` for the code store. |
| `COMPOSE_FILE` | unset | Set to `docker-compose.yml:docker-compose.audit.yml` so a plain `docker compose up` also starts the audit sink. The deploy workflow relies on this. |

## Audit sink

| variable | default | meaning |
| --- | --- | --- |
| `REGBY_AUDIT_TOKEN` | required | Same value as the broker's. |
| `REGBY_AUDIT_DATABASE_URL` | required | `postgres://user:password@host:port/database`. Only the sink ever holds it. URL query parameters such as `sslmode` are ignored. |
| `REGBY_AUDIT_DATABASE_CA` | required | Path to the PEM CA the database's TLS certificate must chain to. TLS is always on and always verified. Compose pins `/certs/db-ca.pem` (mounted from `./certs`). |
| `REGBY_AUDIT_HOST` | `127.0.0.1` | Bind address. Compose pins `0.0.0.0` inside the container; no port is published to the host. |
| `REGBY_AUDIT_PORT` | `8787` | Bind port. Compose pins `8787`. |
| `REGBY_AUDIT_RETAIN_DAYS` | `365` | Records older than this are deleted, hourly. |
| `REGBY_AUDIT_MAX_ROWS` | `10000000` | Hard row cap; the oldest go first. |
| `REGBY_LOG_LEVEL` | `info` | As for the broker. |

## Tests

| variable | meaning |
| --- | --- |
| `REGBY_AUDIT_TEST_DATABASE_URL`, `REGBY_AUDIT_TEST_DATABASE_CA` | Point the Postgres store tests (`src/audit-sink/store.test.ts`) at a real database. Each test works in a throwaway schema and drops it. Unset, those tests are skipped. |
