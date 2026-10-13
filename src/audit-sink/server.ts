/**
 * HTTP intake for the broker's audit batches: `POST /events` with the shared
 * bearer token and an `AuditBatch` body. Plain http by design: it is reached
 * only over the compose network beside the broker, or through a TLS proxy if
 * it ever runs elsewhere, which keeps certificates out of the app.
 *
 * Every answer is a bare status the sender acts on: 204 stored, 401 bad token,
 * 400/413 off-contract (dropped, never retried), 5xx retried (a database
 * outage lands here, so the broker keeps the batch queued).
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { AUDIT_BATCH_MAX, parseAuditBatch, type AuditRecord } from '../audit.ts';
import { MAX_CONTENT_LENGTH } from '../protocol.ts';
import { errorMessage, logger } from '../logger.ts';

/** What the intake stores into; `AuditStore` is the production one. */
export interface AuditSink {
  /** Store a batch atomically; a record id seen before is skipped (a retry). Resolves to the rows added. */
  insert(records: readonly AuditRecord[]): Promise<number>;
}

/**
 * A full batch of maximal records at worst-case encoding: a `content` character
 * can cost 6 bytes as JSON (`\u00XX`), plus a margin for the other fields. A
 * 413 is never retried, so this must never refuse a batch the broker can send.
 */
const MAX_RECORD_BYTES = MAX_CONTENT_LENGTH * 6 + 1024;
const MAX_BODY_BYTES = AUDIT_BATCH_MAX * MAX_RECORD_BYTES;

/** Compare digests, not raw strings: equal length always, so no timing leak. */
function tokenMatches(header: string | undefined, token: string): boolean {
  const presented = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  const digest = (s: string): Buffer => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(presented), digest(token));
}

/** The request body, or null once it passes the cap (reading stops there). */
async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function handle(req: IncomingMessage, store: AuditSink, token: string): Promise<number> {
  if (req.url === '/health' && req.method === 'GET') return 204;
  if (req.url !== '/events') return 404;
  if (req.method !== 'POST') return 405;
  if (!tokenMatches(req.headers.authorization, token)) return 401;
  const raw = await readBody(req);
  if (raw === null) return 413;
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return 400;
  }
  const records = parseAuditBatch(body);
  if (!records) return 400;
  await store.insert(records);
  return 204;
}

export function createSinkServer(store: AuditSink, token: string): Server {
  return createServer((req, res) => {
    handle(req, store, token)
      .catch((err: unknown) => {
        logger.error('Audit request failed', { error: errorMessage(err) });
        return 500;
      })
      .then((status) => {
        if (status >= 400) logger.warn('Audit request refused', { status, url: req.url });
        // An unread body on a refusal must not keep the socket waiting.
        res.writeHead(status, { connection: status >= 400 ? 'close' : 'keep-alive' });
        res.end();
      });
  });
}
