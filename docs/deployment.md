# Deployment and operations

Production is one Linux host running Docker Compose with two containers built
from the same image:

```
                 ┌──────────── host ─────────────────────────────┐
 DM relays ◀────▶│ regby (broker)  ── POST /events ──▶ audit-sink │──TLS──▶ managed Postgres
 (wss, AUTH)     │   ./data:/data                     ./certs:ro  │         (table `events`)
                 └────────────────────────────────────────────────┘
```

| container | command | holds | files |
| --- | --- | --- | --- |
| `regby` | `node dist/index.js` | the broker's Nostr key | `.env`, `./data` (code store) |
| `regby-audit-sink` | `node dist/audit-sink/index.js` | the database credentials | `.env.audit-sink`, `./certs/db-ca.pem` |

Codes stay on the host; the audit history lives only in the remote Postgres.
The broker can append audit records through the token-guarded intake but can
never read or delete them, and the sink never sees the Nostr key.

The audit sink is optional. Without it the broker runs alone and records
nothing.

## Requirements

- Docker Engine with the Compose plugin (`docker compose`).
- Outbound `wss://` to the relays and TLS to the Postgres host. No inbound
  ports: the broker only dials out, and the sink's port is never published.
- For the audit: a Postgres database and role for the sink, and the
  provider's CA certificate.

The image is `node:24-alpine`. Running outside Docker needs Node 22.5 or newer
(`node:sqlite`).

## First install

Run as a user in the `docker` group, or as root. The containers run as root,
so files under `./data` are root-owned.

```bash
git clone <repo> /opt/regby-middleware && cd /opt/regby-middleware

# Broker
cp .env.example .env
#   set REGBY_PRIVATE_KEY, REGBY_EXPECTED_PUBKEY, REGBY_RELAYS
chmod 600 .env

docker compose up -d --build
docker compose logs regby | grep -E 'booting|Broker started'
```

The boot log prints `pubkey` (must be the app's `REGBY_MIDDLEMAN_PUBKEY`) and
`dbPath` (must be `/data/regby.db`, i.e. on the mount).

### Adding the audit sink

```bash
cp .env.audit-sink.example .env.audit-sink
#   set REGBY_AUDIT_TOKEN (openssl rand -hex 32) and REGBY_AUDIT_DATABASE_URL
chmod 600 .env.audit-sink

mkdir -p certs && cp <provider-ca.pem> certs/db-ca.pem && chmod 700 certs

# in .env: the same token, and make compose start both services by default
echo 'REGBY_AUDIT_TOKEN=<same token>' >> .env
echo 'COMPOSE_FILE=docker-compose.yml:docker-compose.audit.yml' >> .env

docker compose up -d --build
docker compose logs audit-sink | grep 'Audit sink listening'
```

The sink creates the `events` table, its indexes and column comments on first
start. Give it its own database role with rights on that database only. **The
table is a payment history** (pubkeys, recipients, amounts): restrict access
to it and to its backups like any customer database.

Without `COMPOSE_FILE` the same stack can be started explicitly:

```bash
docker compose -f docker-compose.yml -f docker-compose.audit.yml up -d --build
```

The broker reaches the sink at `http://audit-sink:8787/events` on the compose
network (set by `docker-compose.audit.yml`). A sink that is down, or a database
that is unreachable, never stops the broker: records wait in its memory queue
and are retried with backoff.

## Continuous deployment

Every push to `main` runs [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml):

1. `npm ci`, `npm run typecheck`, `npm test` on GitHub's runner.
2. Port-knock the server firewall, SSH in with a dedicated key.
3. On the server: `git merge --ff-only <tested sha>` in the checkout, then
   `docker compose up -d --build`. Which services start is decided by
   `COMPOSE_FILE` in the server's `.env`.
4. After 15 s, fail the deploy if any container is not running or has
   restarted, and print the last logs.
5. Prune dangling images only after the check passes, so the previous image
   stays available for a manual rollback.

Branch flow: features branch from `staging` and merge into it; `staging` is
merged into `main` to release.

### Secrets

Set under **Settings > Environments > production**:

| secret | value |
| --- | --- |
| `DEPLOY_HOST` | server IP or hostname |
| `DEPLOY_USER` | SSH user, in the `docker` group |
| `DEPLOY_SSH_KEY` | private key for that user, ed25519, **no passphrase** |
| `DEPLOY_KNOWN_HOSTS` | pinned host key, from `ssh-keyscan -p <port> <host>` run on a trusted machine after knocking |
| `DEPLOY_SSH_PORT` | SSH port behind the knock |
| `DEPLOY_KNOCK_PORTS` | knock sequence, space separated, TCP |
| `DEPLOY_PATH` | absolute path of the checkout on the server |

### Server prerequisites for CI

- The checkout must fetch from GitHub non-interactively. Use a read-only
  deploy key without a passphrase, pinned to this repo:
  `git config core.sshCommand "ssh -i ~/.ssh/<deploy key> -o IdentitiesOnly=yes"`.
  Test it with `SSH_AUTH_SOCK= git fetch` so a forwarded agent can't hide a
  problem.
- The firewall must accept `ESTABLISHED,RELATED` before the knock rule, or a
  long build drops the SSH session when the knock window closes.
- The checkout must stay on `main` with no local commits; the fast-forward
  refuses a diverged tree and fails the deploy.

### Rollback

```bash
cd $DEPLOY_PATH
git checkout --detach <good sha>
docker compose up -d --build
```

The next automatic deploy checks out `main` again and fast-forwards it.

## Day-to-day operations

```bash
docker compose ps
docker compose logs -f regby                # JSON lines
docker compose logs -f audit-sink
docker compose restart regby                # codes survive, see below
```

Restarts are safe: codes are on disk, so a code issued before a restart still
redeems after it. The audit sender makes one last flush on `SIGTERM`; records
still queued after that are lost and logged as `Audit records lost at shutdown`.

### Log messages worth alerting on

| message | level | meaning |
| --- | --- | --- |
| `Fatal on boot` | error | Bad config or unreadable store. The container restart-loops; the deploy check fails. |
| `Reply accepted by no relay` | warn | Every relay refused or timed out. Carries per-relay `rejections`. |
| `Code consumed but its reply reached no relay` | warn | A customer lost a redeem; the merchant has to re-mint. |
| `Relay AUTH failed`, `Dropping wedged relay socket` | warn | A relay is unhealthy; the broker reconnects on its own. |
| `Global mint rate limit hit`, `Global redeem rate limit hit` | warn | Traffic at the global ceilings: a flood, or limits set too low. |
| `Blacklisted sender - repeated code guessing` | warn | A sender hit `REGBY_REDEEM_FAIL_MAX`. |
| `Mint failed (store full / no free code)` | warn | `REGBY_STORE_MAX` reached; merchants get `regby_code_busy`. |
| `Day rotation failed - staying on the previous file` | error | Today's file could not be opened; retried on every operation. Check disk space and permissions on `./data`. |
| `Audit sink unreachable`, `Audit sink refused batch` | warn | Sink or database down; records are being retried. |
| `Audit queue overflowed - oldest records dropped` | warn | Outage outlasted `REGBY_AUDIT_QUEUE_MAX`; history has a gap. |
| `Audit sink rejected batch - dropped` | error | Broker and sink disagree on the record contract (deployed out of step). |

### Code store files

```
data/
  2026/
    10/
      regby-2026-10-15.db       archive: rows kept, content and pubkeys wiped
      regby-2026-10-16.db       live (plus -wal / -shm while running)
```

- **Backups.** Past days' files are closed and can be copied as-is. Today's
  file is live in WAL mode: copy it with
  `sqlite3 data/YYYY/MM/regby-<today>.db ".backup /tmp/today.db"`, never `cp`.
- **Disk.** Archives are kept forever. They hold no content, but delete old
  months by hand if space matters; only the last three days are ever read.
- **Inspecting a code.** The live file keeps each code's content and origin
  for 72 h:
  `sqlite3 data/YYYY/MM/regby-<today>.db "SELECT * FROM codes WHERE code='48213907'"`.
  Treat this as production payment data.

### Audit queries

```bash
psql "$REGBY_AUDIT_DATABASE_URL?sslmode=verify-full&sslrootcert=certs/db-ca.pem" \
  -c "SELECT to_timestamp(ts), event, pubkey, reason, delivered FROM events WHERE code='48213907' ORDER BY ts"
```

More in [audit-queries.sql](audit-queries.sql); every column and event is
explained in [audit-events.md](audit-events.md).

## Rotating secrets

| secret | how |
| --- | --- |
| Audit token | Set the new value in both `.env` and `.env.audit-sink`, then `docker compose up -d`. Records sent during the swap get `401`, which the broker retries, so none are lost. |
| Database password | Update `REGBY_AUDIT_DATABASE_URL` in `.env.audit-sink`, `docker compose up -d audit-sink`. |
| Broker Nostr key | Breaking: the app hardcodes the broker's pubkey. Ship an app release with the new pubkey first, then change `REGBY_PRIVATE_KEY` and `REGBY_EXPECTED_PUBKEY`. Codes issued under the old key stop being reachable. |

## Upgrading older installs

Schema changes are applied automatically on start and are idempotent:

- **Code store:** a daily file from an older build (`uri` column, no
  `redeemed_at` / origin columns) is upgraded when opened or carried.
- **Audit table:** an older `events` table has `uri` renamed to `content`,
  `detail` to `reason`, and `valid_until`, `payload_hmac`, `payload_length`
  **dropped**. Take a `pg_dump` first if those values matter.

### From the old named volume

Early deploys kept the code store in a Docker volume (`regby-data`). To move
it to the `./data` bind mount:

```bash
docker volume ls | grep regby-data        # e.g. regby-middleware_regby-data
docker stop regby                         # closes today's db cleanly
mkdir -p data
cp -a "$(docker volume inspect -f '{{.Mountpoint}}' regby-middleware_regby-data)/." data/
find data -name 'regby-*.db' | wc -l      # one file per day served so far
docker compose up -d --build
```

After a few clean days, `docker volume rm regby-middleware_regby-data`. If
that deploy had `REGBY_DB_PATH=regby.db` in `.env`, the files were inside the
container under `/app/YYYY/...`: copy each year out with
`docker cp regby:/app/YYYY ./data/` before `docker compose up` recreates it.
