# Audit events reference

The audit history is the table `events` in the audit Postgres (schema
`public` unless the sink's role has another default). The
broker writes one row for each request it answered, plus one for each code
guesser it blacklists and one for each redeem notice it sends a merchant. The broker never writes to the database itself: it
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
| `content` | text | yes | The full content as sent: any text, a `defito://` invoice or empty included. Set **only** for served requests: `code_issued`, `regby_busy`, `redeem`. |
| `reason` | text | yes | Why the request was refused. See [reason values](#reason-values). |
| `delivered` | boolean | yes | Whether the reply reached at least one relay. Null when no reply was sent. See [delivered](#delivered). |
| `received_at` | bigint | no | Sink time, in unix seconds, when the row was stored. If it is much later than `ts`, the sink or the database was down and the broker kept retrying. |

## Events

| `event` | when | `pubkey` is | reply the app gets | `code` | `content` | `reason` | `delivered` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `code_issued` | content (any text) got a code | merchant | the code | issued code | yes | - | true / false |
| `regby_busy` | no free code: `REGBY_STORE_MAX` codes were already issued in the last 48 h | merchant | `Service Busy, Try Again` | - | yes | - | true / false |
| `redeem` | the code was valid and is now used up | customer | the content, tagged `from` = merchant | typed code | yes | - | true / false |
| `redeem_refused` | the code could not be used | customer | `Code Expired` / `Code Already Redeemed` / `Code Not Found` | typed code | - | `expired` / `redeemed` / `not-found` | true / false |
| `blacklisted` | a code guesser, blocked for `REGBY_BLACKLIST_SECONDS` (default 24 h) | customer | **no reply** | typed code | - | `guessing` | null |
| `merchant_notified` | after a `redeem`, the merchant was told their code is used up (`regby_redeemed`, tagged `deliver_to` = customer). Not a request: `request_event` is the merchant's original `code_issued` request | merchant | `regby_redeemed`, content = the code | redeemed code | - | - | true / false |

The broker never refuses content for what it says (see README), so no event
records a refused payload. History written by a broker from before that
change can still hold `invalid_request` (`reason` = `malformed`) and
`blacklisted` (`reason` = `malicious`): a `defito://` payload that broker
refused, with the sender blocked for the second. The payload itself was never
stored.

**One row is one exchange, not one message.** A Nostr message carries either
content or a code, never both, but a row records the request AND the reply,
so it can hold one of each:

| `event` | request carried | reply carried | row holds |
| --- | --- | --- | --- |
| `code_issued` | the content | the code | both |
| `redeem` | the code | the content | both |
| `redeem_refused`, `blacklisted` | the code | a reason, or nothing | the code |
| `merchant_notified` | (none: a notice) | the code | the code |

A "-" means the column is null for that event.

### The lifecycle of one code

```
code_issued ──▶ redeem                     (normal payment)
            ──▶ redeem_refused / expired   (customer was too late, the code lives 60 s)
            ──▶ redeem ──▶ redeem_refused / redeemed   (second attempt with the same code)

redeem ──▶ merchant_notified                  (always follows a redeem of a code with a known merchant)
```

To link them, query by `code`. Code numbers are not reused for 48 h, so within
two days a code identifies a single request.

## reason values

| `event` | `reason` | meaning | app shows |
| --- | --- | --- | --- |
| `redeem_refused` | `expired` | The code existed but its 60 s (`REGBY_CODE_TTL_SECONDS`) had passed, and it was never used. | Code Expired |
| `redeem_refused` | `redeemed` | The code was already used once. | Code Already Redeemed |
| `redeem_refused` | `not-found` | No such code, or it was issued more than `REGBY_CODE_RETAIN_SECONDS` (1 h) ago. | Code Not Found |
| `blacklisted` | `guessing` | One customer had more than `REGBY_REDEEM_FAIL_MAX` (default 10) `not-found` codes within `REGBY_REDEEM_RATE_WINDOW_SECONDS` (default 60 s). The earlier misses are on record as `redeem_refused` / `not-found`. No reply is sent, so the guesser can't tell a miss from a block. Blocked for 24 h. | nothing |

## delivered

- `true`: at least one relay accepted the reply. That does not prove the app
  read it.
- `false`: no relay accepted the reply. What it means depends on the event:
  - `code_issued`: the merchant never saw the code. The code still exists and
    expires unused.
  - `redeem`: **the code is used up but the customer never got the content**,
    because the broker uses the code up before it sends the reply. The customer's
    retry gets `Code Already Redeemed`, and the merchant has to issue a new
    code. This is the row to look for when a customer says "it said already
    redeemed but I never paid".
  - Refusals: the sender never saw the reason.
- `null`: no reply was sent (`blacklisted` / `guessing`).

## Times

| value | what it is |
| --- | --- |
| `ts` | When the broker answered (broker clock). |
| `received_at` | When the sink stored the row (sink clock). |
| code expiry | Not stored. It is about `ts` of `code_issued` plus `REGBY_CODE_TTL_SECONDS` (60 s). The exact value is anchored to the merchant's request time, clamped to the server clock within `REGBY_CLOCK_SKEW_SECONDS`. |

## What is not recorded

These requests are dropped before the broker does any work. They are
attacker-controlled volume with nothing to reconstruct:

- events from a sender who is currently blacklisted
- events over the per-sender rate limit (`REGBY_RATE_MAX`)
- events over the global mint or redeem ceilings (`REGBY_MINT_RATE_MAX`,
  `REGBY_REDEEM_RATE_MAX`). These get no reply either.
- events that fail to decrypt, or decrypt to bytes instead of text
- content over 4096 characters, a redeem whose content is not an 8-digit
  code, or the broker's own reply intents echoed back
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
totals, refusals, sink delay and table size. In
pgAdmin, open the file in the Query Tool (Open File), select a query and run
it with F5.
