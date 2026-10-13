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
SELECT to_timestamp(ts) AS at, event, reason, code, delivered,
       left(pubkey, 12) AS sender, content
FROM events
ORDER BY ts DESC
LIMIT 100;


-- Everything that happened to one code
SELECT to_timestamp(ts) AS at, event, reason, delivered, left(pubkey, 12) AS sender, content
FROM events
WHERE code = '48213907'  -- edit: the code
ORDER BY ts;


-- One merchant's or customer's activity
SELECT to_timestamp(ts) AS at, event, reason, code, delivered
FROM events
WHERE pubkey = '0000000000000000000000000000000000000000000000000000000000000000'  -- edit: full hex pubkey
ORDER BY ts DESC
LIMIT 100;


-- Codes used up but never delivered to the customer (see "delivered" in docs/audit-events.md)
SELECT to_timestamp(ts) AS at, code, left(pubkey, 12) AS customer, content
FROM events
WHERE event = 'redeem' AND delivered = false
ORDER BY ts DESC;


-- Every reply that reached no relay, by event
SELECT event, reason, count(*) AS undelivered, to_timestamp(max(ts)) AS latest
FROM events
WHERE delivered = false
GROUP BY event, reason
ORDER BY undelivered DESC;


-- Daily totals per event and reason
SELECT date_trunc('day', to_timestamp(ts)) AS day, event, reason, count(*) AS n
FROM events
GROUP BY 1, 2, 3
ORDER BY 1 DESC, 4 DESC;


-- Refused redeems and blacklisted guessers, newest first
SELECT to_timestamp(ts) AS at, event, reason, code, left(pubkey, 12) AS sender
FROM events
WHERE event IN ('redeem_refused', 'blacklisted')
ORDER BY ts DESC
LIMIT 100;


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
