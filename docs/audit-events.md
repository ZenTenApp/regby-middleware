# Audit events reference

The audit history is the table `events` in the audit Postgres (schema
`public` unless the sink's role has another default). The
broker writes one row for each request it answered, plus one for each code
guesser it blacklists. The broker never writes to the database itself: it
queues records in memory and posts them to the audit sink, and the sink is
the only process that holds the database credentials.

The column descriptions below are also stored in the database, so pgAdmin
shows them under the table's and columns' Properties, and `psql` shows them
with `\d+ events`.

## Flow of one record

```
merchant / customer ──request──▶ broker ──reply──▶ relays ──▶ app
                                   │
                                   └─ record (after the reply) ──▶ in-memory queue
                                                                     │  POST /events, retried with backoff
                                                                     ▼
                                                    audit sink ──▶ Postgres events
```

The broker builds the record **after** it publishes the reply, so the record
can say whether the reply reached a relay (`delivered`).

## Columns

| column | type | null | meaning |
| --- | --- | --- | --- |
| `id` | uuid | no | Random id set by the broker. If a batch is sent twice, rows with an id already in the table are skipped, so no record is stored twice. |
| `ts` | bigint | no | Broker time, in unix seconds, when the request was answered. Use `to_timestamp(ts)` to read it as a date. |
| `event` | text | no | What happened. See [Events](#events). |
| `pubkey` | text | no | Full 64-character hex pubkey of whoever sent the request. See [Events](#events) for whether that is the merchant or the customer. |
| `request_event` | text | no | Id of the incoming Nostr event (kind 4) this row answers. The relays keep events for at most 72 h. |
| `code` | text | yes | The 8-digit code. For `code_issued` it is the code that was issued. For `redeem`, `redeem_refused` and `blacklisted`/`guessing` it is the code the customer typed. |
| `uri` | text | yes | The full `defito://` invoice. Set **only** for served requests: `code_issued`, `regby_busy`, `redeem`. A refused payload is never stored as text. |
| `valid_until` | bigint | yes | The invoice's own expiry: the earliest `valid_until` across its rails, in unix seconds. It is **not** the code's expiry (see [Times](#times)). Null when `uri` is null or the invoice has no `valid_until`. |
| `payload_hmac` | text | yes | Only for refused payloads (`invalid_request`, `blacklisted`/`malicious`). A keyed hash of the decrypted text. See [payload_hmac and payload_length](#payload_hmac-and-payload_length). |
| `payload_length` | integer | yes | Only for refused payloads. Length of the decrypted text, in characters. |
| `detail` | text | yes | The reason. See [detail values](#detail-values). |
| `delivered` | boolean | yes | Whether the reply reached at least one relay. Null when no reply was sent. See [delivered](#delivered). |
| `received_at` | bigint | no | Sink time, in unix seconds, when the row was stored. If it is much later than `ts`, the sink or the database was down and the broker kept retrying. |

## Events

| `event` | when | `pubkey` is | reply the app gets | `code` | `uri` + `valid_until` | `payload_*` | `detail` | `delivered` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `code_issued` | a valid invoice got a code | merchant | the code | issued code | yes | - | - | true / false |
| `regby_busy` | valid invoice, but no free code: `REGBY_STORE_MAX` codes were already issued in the last 24 h | merchant | `Service Busy, Try Again` | - | yes | - | - | true / false |
| `redeem` | the code was valid and is now used up | customer | the invoice | typed code | yes | - | - | true / false |
| `redeem_refused` | the code could not be used | customer | `Code Expired` / `Code Already Redeemed` / `Code Not Found` | typed code | - | - | `expired` / `redeemed` / `not-found` | true / false |
| `invalid_request` | `defito://` invoice that the wallet would refuse | merchant | `Invalid Request` | - | - | yes | `malformed` | true / false |
| `blacklisted` | sender blocked for `REGBY_BLACKLIST_SECONDS` (default 24 h) | merchant (`malicious`) or customer (`guessing`) | `malicious`: `Invalid Request`. `guessing`: **no reply** | `guessing`: typed code | - | `malicious` only | `malicious` / `guessing` | `malicious`: true / false. `guessing`: null |

A "-" means the column is null for that event.

### The lifecycle of one code

```
code_issued ──▶ redeem                     (normal payment)
            ──▶ redeem_refused / expired   (customer was too late, the code lives 60 s)
            ──▶ redeem ──▶ redeem_refused / redeemed   (second attempt with the same code)
```

To link them, query by `code`. Code numbers are not reused for 24 h, so within
a day a code identifies a single invoice.

## detail values

| `event` | `detail` | meaning | app shows |
| --- | --- | --- | --- |
| `redeem_refused` | `expired` | The code existed but its 60 s (`REGBY_CODE_TTL_SECONDS`) had passed, and it was never used. | Code Expired |
| `redeem_refused` | `redeemed` | The code was already used once. | Code Already Redeemed |
| `redeem_refused` | `not-found` | No such code, or it was issued more than `REGBY_CODE_RETAIN_SECONDS` (1 h) ago. | Code Not Found |
| `invalid_request` | `malformed` | The payload starts with `defito://`, but no rail has the required fields in the right shape, or it fails a safety screen (hostile text, too many lines). This is a POS or client bug, so the sender is **not** blocked. | Invalid Request |
| `blacklisted` | `malicious` | A `request_regby_code` whose payload is not `defito://` at all. The sender holds the conversation key, so this is deliberate. Blocked for 24 h. | Invalid Request |
| `blacklisted` | `guessing` | One customer had more than `REGBY_REDEEM_FAIL_MAX` (default 10) `not-found` codes within `REGBY_REDEEM_RATE_WINDOW_SECONDS` (default 60 s). The earlier misses are on record as `redeem_refused` / `not-found`. No reply is sent, so the guesser can't tell a miss from a block. Blocked for 24 h. | nothing |

## delivered

- `true`: at least one relay accepted the reply. That does not prove the app
  read it.
- `false`: no relay accepted the reply. What it means depends on the event:
  - `code_issued`: the merchant never saw the code. The code still exists and
    expires unused.
  - `redeem`: **the code is used up but the customer never got the invoice**,
    because the broker uses the code up before it sends the reply. The customer's
    retry gets `Code Already Redeemed`, and the merchant has to issue a new
    code. This is the row to look for when a customer says "it said already
    redeemed but I never paid".
  - Refusals: the sender never saw the reason.
- `null`: no reply was sent (`blacklisted` / `guessing`).

## payload_hmac and payload_length

When the broker refuses a payload (`invalid_request`, `blacklisted`/`malicious`),
it does not store the text, because:

- a near-miss invoice can carry real payment data (recipient, amount) that
  was never served, and
- a payload from an attacker is arbitrary content we don't want in a database.

The row stores two fields instead:

- `payload_length`: the length in characters. It tells a 200-character
  invoice apart from 3 KB of junk.
- `payload_hmac`: `HMAC-SHA256(decrypted text, key = REGBY_AUDIT_TOKEN)`, as
  lowercase hex. The text can't be read back from it, but anyone who holds the
  token can check whether a given text matches.

**Matching a report.** A merchant says "I sent this and got Invalid Request".
Take their exact text (byte for byte, no added newline) and compute:

```bash
printf '%s' 'defito://...exact text...' \
  | openssl dgst -sha256 -hmac "$REGBY_AUDIT_TOKEN" -r | cut -d' ' -f1
```

```sql
SELECT to_timestamp(ts), event, detail, payload_length, delivered
FROM events WHERE payload_hmac = '<hex from above>';
```

**Why the hash is keyed.** A plain SHA-256 needs no key, so anyone with a copy
of the table could test guesses ("recipient X, amount Y") against it. With the
HMAC, a leaked table alone confirms nothing.

**Changing the token** stops old rows from matching under the new token.
Keep the old token somewhere safe if you will need to match older reports.

## Times

| value | what it is |
| --- | --- |
| `ts` | When the broker answered (broker clock). |
| `received_at` | When the sink stored the row (sink clock). |
| `valid_until` | The merchant's invoice expiry, taken from the invoice itself. |
| code expiry | Not stored. It is about `ts` of `code_issued` plus `REGBY_CODE_TTL_SECONDS` (60 s). The exact value is anchored to the merchant's request time, clamped to the server clock within `REGBY_CLOCK_SKEW_SECONDS`. |

## What is not recorded

These requests are dropped before the broker does any work. They are
attacker-controlled volume with nothing to reconstruct:

- events from a sender who is currently blacklisted
- events over the per-sender rate limit (`REGBY_RATE_MAX`)
- events over the global mint or redeem ceilings (`REGBY_MINT_RATE_MAX`,
  `REGBY_REDEEM_RATE_MAX`). These get no reply either.
- events that fail to decrypt, or decrypt to bytes instead of text
- unusable content: empty, oversized, a code that is not 8 digits, or the
  broker's own reply intents echoed back
- events without a ReGBY intent tag

## Gaps and limits

- **Restart:** records still in the broker's memory queue when it restarts are
  lost. A clean shutdown makes one last attempt to send them first.
- **Long outage:** if the sink or the database is down long enough for the
  queue to pass `REGBY_AUDIT_QUEUE_MAX` (default 10 000), the oldest records are
  dropped and the broker logs `Audit queue overflowed`.
- **Retention:** every hour the sink deletes rows older than
  `REGBY_AUDIT_RETAIN_DAYS` (default 365) and trims the table to
  `REGBY_AUDIT_MAX_ROWS` (default 10 000 000), oldest first. Deleted rows
  remain in the database provider's backups for the backup retention window.
- **One sink per table:** the sink keeps the row count in memory. Two sinks
  writing to the same table would each enforce the cap on their own count.

## Useful queries

Ready-to-run queries are in [audit-queries.sql](audit-queries.sql): latest
activity, the history of one code or one pubkey, undelivered redeems, daily
totals, refusals, matching a payload HMAC, sink delay and table size. In
pgAdmin, open the file in the Query Tool (Open File), select a query and run
it with F5.
