-- ReGBY audit queries, read-only. Open in pgAdmin's Query Tool (Open File),
-- select one query and run it with F5 (Execute selection).
-- Columns, events and reasons are explained in docs/audit-events.md.
-- Values marked "edit" are examples: replace them before running.


-- Column descriptions (the same text pgAdmin shows under each column's Comment)
SELECT a.attname AS column_name, col_description(a.attrelid, a.attnum) AS description
FROM pg_attribute a
WHERE a.attrelid = 'events'::regclass AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attnum;


-- Latest activity, readable times
SELECT to_timestamp(ts) AS at, event, detail, code, delivered,
       left(pubkey, 12) AS sender, valid_until, uri
FROM events
ORDER BY ts DESC
LIMIT 100;


-- Everything that happened to one code
SELECT to_timestamp(ts) AS at, event, detail, delivered, left(pubkey, 12) AS sender, uri
FROM events
WHERE code = '48213907'  -- edit: the code
ORDER BY ts;


-- One merchant's or customer's activity
SELECT to_timestamp(ts) AS at, event, detail, code, delivered
FROM events
WHERE pubkey = '0000000000000000000000000000000000000000000000000000000000000000'  -- edit: full hex pubkey
ORDER BY ts DESC
LIMIT 100;


-- Codes used up but never delivered to the customer (see "delivered" in docs/audit-events.md)
SELECT to_timestamp(ts) AS at, code, left(pubkey, 12) AS customer, uri
FROM events
WHERE event = 'redeem' AND delivered = false
ORDER BY ts DESC;


-- Every reply that reached no relay, by event
SELECT event, detail, count(*) AS undelivered, to_timestamp(max(ts)) AS latest
FROM events
WHERE delivered = false
GROUP BY event, detail
ORDER BY undelivered DESC;


-- Daily totals per event and reason
SELECT date_trunc('day', to_timestamp(ts)) AS day, event, detail, count(*) AS n
FROM events
GROUP BY 1, 2, 3
ORDER BY 1 DESC, 4 DESC;


-- Refused requests and blacklistings, newest first
SELECT to_timestamp(ts) AS at, event, detail, code, payload_length,
       left(pubkey, 12) AS sender, payload_hmac
FROM events
WHERE event IN ('redeem_refused', 'invalid_request', 'blacklisted')
ORDER BY ts DESC
LIMIT 100;


-- Match a payload a merchant reported. Compute the hex on a machine that has
-- the token, never paste the token here:
--   printf '%s' 'exact text' | openssl dgst -sha256 -hmac "$REGBY_AUDIT_TOKEN" -r | cut -d' ' -f1
SELECT to_timestamp(ts) AS at, event, detail, payload_length, delivered, left(pubkey, 12) AS sender
FROM events
WHERE payload_hmac = '0000000000000000000000000000000000000000000000000000000000000000';  -- edit: hex from above


-- How long records waited before reaching the database (last 24 h).
-- Large values mean the sink or the database was down and the broker retried.
SELECT max(received_at - ts) AS worst_delay_s, round(avg(received_at - ts), 1) AS avg_delay_s, count(*) AS rows
FROM events
WHERE ts > extract(epoch FROM now() - interval '1 day');


-- Table size and row count
SELECT count(*) AS rows,
       to_timestamp(min(ts)) AS oldest,
       to_timestamp(max(ts)) AS newest,
       pg_size_pretty(pg_total_relation_size('events')) AS size_on_disk
FROM events;
