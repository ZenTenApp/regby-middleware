# Protocol and behaviour

ReGBY is a **transport**. A merchant encrypts any text to the broker's npub
(a `defito://` payment request, anything else, or nothing at all). The broker
never reads it: it mints an 8-digit code and returns it. A customer redeems
the code; the broker returns the original content, then **pairs the two
peers**: the customer learns who the content came from (`from`), the merchant
who received it (`to`).

A `defifrom://` payment confirmation never passes through here. It goes
straight to the npub named in the invoice it answers. The broker exists to fit
an invoice into eight digits a customer can type, and nobody types a
confirmation.

Full event examples for every hop: [flow-examples.md](flow-examples.md).

## Wire format

Every message is a Nostr **DM, kind 4**, with NIP-04 encrypted `content`.

- **Content** is the raw value, no JSON wrapper: the merchant's text (up to
  4096 characters, empty included) or a bare eight-digit code.
- **Empty content is never encrypted**, in either direction. A failure reply,
  a success carrying empty content, and an empty request all travel as a raw
  `""`. A receiver checks for `""` before it decrypts.
- **Intent** rides the `["i", <intent>]` tag (single letter, so relays index
  it and the broker subscribes to inbound intents only).
- **Correlation** is the `["e", <request event id>]` tag on every reply. No
  in-band id.
- **Routing** is `["p", <recipient hex pubkey>]`.
- **Retention** is NIP-40 `["expiration", <unix seconds>]` on every event the
  broker publishes, `created_at + REGBY_EVENT_EXPIRY_SECONDS` (72 h less a
  minute). Relay housekeeping only; it says nothing about code validity.
- Every published event also carries `["client", "regby-middleware"]`: the DM
  relays reject writes without a `client` tag.

NIP-04 is required on this kind because it is what every client reading these
relays opens a kind 4 with; a NIP-44 payload would simply never be seen.
NIP-04 is unauthenticated, so **sender authenticity comes from the event
signature alone**, never from a successful decrypt. Tags are covered by the
signature, so intents and pairing tags are authenticated too.

### Intents

| direction | `i` tag | content (decrypted) | extra tags |
| --- | --- | --- | --- |
| merchant to broker | `request_regby_code` | any text, e.g. `defito://...` | |
| broker to merchant | `regby_code` | the code, e.g. `42891337` | |
| customer to broker | `request_regby_content` | the code | |
| broker to customer | `regby_content` | the merchant's text | `from` = merchant hex pubkey |
| broker to merchant | `regby_content_delivered` | the code | `to` = customer hex pubkey; `e` = the merchant's original request |

### Failures

A failure has its own intent, empty content and no pairing tag. There is no
free error text, so the untrusted broker has no channel into the app's UI.
Because a success can carry empty content too, **clients read the intent
first**, never the content.

| intent | answers | when |
| --- | --- | --- |
| `regby_code_busy` | `request_regby_code` | No free code: `REGBY_STORE_MAX` codes issued in the last 72 h. |
| `regby_code_already_redeemed` | `request_regby_content` | The code was used and is still inside its minute. |
| `regby_code_expired` | `request_regby_content` | Past its minute, used or not, under `REGBY_CODE_RETAIN_SECONDS` (1 h) old. |
| `regby_code_locked` | `request_regby_content` | 1 h to 72 h old; the number is held back from reuse. |
| `regby_code_not_found` | `request_regby_content` | Never issued, or over 72 h old. |

A client that does not recognise an intent never matches it to its pending
request. **A new intent therefore needs an app release first.**

### Pairing tags are public

`from` and `to` are plaintext hex pubkeys, like `p`. Anyone reading the relay
sees which merchant and customer met. The merchant key is the one that signed
the request, not anything claimed inside the content. A refused redeem sends
neither tag.

`regby_content_delivered` is sent whether or not the customer's reply reached
a relay: the code is used up either way, so "delivered" means released by the
broker, not received by the customer.

## Behaviour

### Minting (`request_regby_code`)

1. Decrypt. Drop silently, with no reply and nothing stored, if the content
   is **binary** (contains `U+FFFD`, NUL or C0 controls other than tab and line
   breaks; NIP-04 decrypts bytes leniently into such text) or over 4096
   characters. Empty and whitespace-only text are valid content.
2. Clamp the request's `created_at` to the server clock within
   `REGBY_CLOCK_SKEW_SECONDS`.
3. Store `code -> { content, expires_at, retain_until, merchant, request event }`,
   content verbatim (not trimmed).
4. Reply `regby_code` with the code.

**Validity is anchored to the request's `created_at`**, not to when the broker
received it, so the POS and the broker count down from the same instant. The
merchant signed that timestamp, so nothing is echoed back.

**Content is opaque.** Whatever the text says, it gets a code. Validating it
(for a `defito://` invoice: networks, recipients, amounts) is the
recipient's job. What the app must check now that the broker checks nothing:
[recipient-checks.md](recipient-checks.md).

### Redeeming (`request_regby_content`)

The content must be exactly eight digits after trimming, otherwise the event
is dropped. Then:

- **Valid and unused**: the code is consumed, the customer gets
  `regby_content` (with `from`), and the merchant gets
  `regby_content_delivered` (with `to`).
- **Otherwise** the code is in exactly one state, decided by its age from the
  merchant's request. Each later state overrides the earlier, so a used code
  reads `expired` once its minute is over:

  | age | reply |
  | --- | --- |
  | under 1 min, already used | `regby_code_already_redeemed` |
  | 1 min to 1 h, used or not | `regby_code_expired` |
  | 1 h to 72 h | `regby_code_locked` |
  | never issued, or over 72 h | `regby_code_not_found` |

**Single use, at most once.** The code is consumed before the reply is
published. A reply no relay accepted still burns the code (logged as
`Code consumed but its reply reached no relay`); the customer's retry is
refused and the merchant re-mints.

### Code store

- **SQLite** through `node:sqlite`, so codes survive a restart. No extra
  dependency, no async driver.
- **One file per UTC day**, `YYYY/MM/regby-YYYY-MM-DD.db` derived from
  `REGBY_DB_PATH`, switched at 00:00 UTC. Opening a day's file copies in every
  code from the last 72 h out of the earlier files, so midnight neither frees
  a number nor cuts short a code minted at 23:59.
- **No number reuse for 72 h.** A row is deleted 72 h after it was issued,
  never sooner, so a customer holding an old code can never open someone
  else's content with it.
- **Content stays for debugging** in the live file until the row is deleted.
  Old day files are kept as an archive but **wiped of every content and
  pubkey**: on rotation for the file being left, and at startup for any older
  file. Deleted rows are zeroed (`secure_delete`) and the WAL is checkpointed.
- A 60 s timer deletes rows past 72 h, prunes rate-limit buckets and
  blacklist entries, rotates the file after midnight, and publishes deletions.

### Relay housekeeping

- **Keep-alive.** A long-lived subscription goes deaf when a relay drops the
  idle socket, so the broker re-subscribes every 120 s with an overlapping
  `since`. Re-delivered events are filtered by a seen-id set (last 50 000 ids),
  so the overlap can't double-mint.
- **AUTH first.** The DM relays gate reads and writes behind NIP-42. The
  broker waits for the relay's challenge and authenticates before it
  subscribes or publishes; every connect, auth and publish step is time
  bounded so one stuck relay can't hold back the others.
- **Active deletion.** Once a reply's `expiration` passes, the broker
  publishes a NIP-09 kind 5 deletion for it (its own events only). The queue is
  in memory and the dedicated DM relays reject kind 5, so on them retention
  rests on the NIP-40 tag, which they enforce.

### Dedicated relays

ReGBY runs on operator-run DM relays (`wss://dm1.zentext.me`,
`wss://dm2.nostr.box`, `wss://dm3.npub.cx`). They accept kind 4 only, require
AUTH and a `client` tag, cap NIP-40 expiration at 72 h and cap the
**encrypted** content at 4 KB. NIP-04 adds about a third, so plaintext of
roughly 3000 ASCII characters already fails at the relay even though the
broker accepts 4096.

## Safeguards

| threat | guard |
| --- | --- |
| One key flooding the broker | Per-sender sliding window (`REGBY_RATE_MAX`). |
| Fresh keys filling the store | Global mint ceiling (`REGBY_MINT_RATE_MAX`), boot-checked to fit `REGBY_STORE_MAX` over 72 h; past capacity, `regby_code_busy`. |
| Guessing codes to harvest content | Global redeem ceiling (`REGBY_REDEEM_RATE_MAX`), plus `not-found` / `locked` strikes per sender leading to a 24 h blacklist with no reply. |
| A forged `created_at` stretching a code | Skew clamp (`REGBY_CLOCK_SKEW_SECONDS`). |
| Relay re-delivery double-minting | Seen-id set. |
| A wall clock stepping back reviving a code | Store time is monotonic within a process. |
| Oversized or binary payloads | 4096-character cap and binary screen. |
| Secrets in logs | Decrypted content and live codes are logged at `debug` only. |

> **Trust note.** For 72 h after issue the live store holds the plaintext
> content, so a compromised broker could hand the customer different content
> (for an invoice, a different recipient). Recipients must treat every
> content as untrusted: the wallet validates the invoice and the customer
> confirms recipient and amount on-device before signing. Future hardening,
> out of scope today: the merchant signs the content and the customer verifies
> it against the merchant's npub.

## Known open points

- Not yet verified that every relay and NIP-04 client accepts a kind 4 with
  empty content; some clients may try to decrypt `""` and throw.
