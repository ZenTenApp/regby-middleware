/**
 * Ships audit records to the external sink (`audit-sink/`) over HTTPS. The
 * broker never waits on it and never writes the history to its own disk: a
 * record goes into a bounded in-memory queue, and a background flush POSTs
 * batches with a bearer token.
 *
 * Sink down: batches go back to the queue and retry with exponential backoff.
 * Queue full: the OLDEST records are dropped and counted, so a long outage
 * costs history, never memory or a reply. Records still queued at a restart
 * are lost - the price of keeping plaintext payment data off this machine.
 */
import { randomUUID } from 'node:crypto';
import {
  AUDIT_BATCH_MAX,
  redactPayload,
  type AuditBatch,
  type AuditRecord,
} from './audit.ts';
import { validUntilOf } from './protocol.ts';
import { nowSeconds } from './time.ts';
import { errorMessage, logger } from './logger.ts';

/**
 * What a broker call site knows; id, time and expiry are filled in here. A
 * `refusedPayload` is hashed here too and never leaves this process as text.
 */
export type AuditEntry = Pick<AuditRecord, 'event' | 'pubkey' | 'requestEvent'> &
  Partial<Pick<AuditRecord, 'code' | 'uri' | 'detail' | 'delivered'>> & {
    refusedPayload?: string;
  };

export interface AuditSink {
  record(entry: AuditEntry): void;
  /** Stop retrying and make one last attempt at whatever is queued. */
  close(): Promise<void>;
}

/** Audit disabled (`REGBY_AUDIT_URL` unset). */
export const NO_AUDIT: AuditSink = {
  record: () => {},
  close: async () => {},
};

export interface AuditConfig {
  url: URL;
  token: string;
  /** Records held while the sink is unreachable before the oldest are dropped. */
  queueMax: number;
}

export interface HttpAuditOptions extends AuditConfig {
  fetch?: typeof fetch;
  now?: () => number;
}

const REQUEST_TIMEOUT_MS = 10_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
/** Overflow is reported at most this often while the sink stays down. */
const DROP_REPORT_SECONDS = 60;

/**
 * A 4xx other than these fails the same way on every retry. 401 is here: a
 * token mismatch is a config error a redeploy fixes, which is exactly when the
 * queue should be holding records rather than throwing them away.
 */
const RETRYABLE_CLIENT_STATUS = new Set([401, 408, 429]);

export class HttpAuditSink implements AuditSink {
  private readonly queue: AuditRecord[] = [];
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private inFlight: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private failures = 0;
  private dropped = 0;
  private droppedReportedAt = 0;
  private closed = false;

  constructor(private readonly options: HttpAuditOptions) {
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? nowSeconds;
  }

  /** Test seam. */
  get pending(): number {
    return this.queue.length;
  }

  record(entry: AuditEntry): void {
    const { refusedPayload, ...fields } = entry;
    this.queue.push({
      id: randomUUID(),
      ts: this.now(),
      code: null,
      uri: null,
      detail: null,
      delivered: null,
      ...fields,
      validUntil: fields.uri ? validUntilOf(fields.uri) : null,
      ...(refusedPayload === undefined
        ? { payloadHmac: null, payloadLength: null }
        : redactPayload(refusedPayload, this.options.token)),
    });
    this.trimToCap();
    this.kick();
  }

  /** Send queued batches until the queue is empty or a send fails. */
  flush(): Promise<void> {
    this.inFlight ??= this.drain().finally(() => {
      this.inFlight = null;
      // A record that arrived after the drain's last look found a send still
      // "in flight" and scheduled nothing; pick it up now.
      this.kick();
    });
    return this.inFlight;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.flush();
    if (this.queue.length > 0 || this.dropped > 0) {
      logger.warn('Audit records lost at shutdown', {
        unsent: this.queue.length,
        dropped: this.dropped,
      });
    }
  }

  /** Start a send soon, unless one is running, waiting out a backoff, or closed. */
  private kick(): void {
    if (this.queue.length > 0 && !this.timer && !this.inFlight && !this.closed) this.schedule(0);
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, AUDIT_BATCH_MAX);
      const verdict = await this.send(batch);
      if (verdict === 'retry') {
        this.queue.unshift(...batch);
        this.trimToCap();
        this.failures++;
        if (!this.closed) this.schedule(backoffMs(this.failures));
        return;
      }
      this.failures = 0;
    }
    this.reportDrops(true);
  }

  private async send(records: AuditRecord[]): Promise<'sent' | 'retry' | 'rejected'> {
    try {
      const res = await this.fetch(this.options.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ records } satisfies AuditBatch),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) return 'sent';
      if (res.status >= 500 || RETRYABLE_CLIENT_STATUS.has(res.status)) {
        logger.warn('Audit sink refused batch - will retry', { status: res.status });
        return 'retry';
      }
      // A record off-contract: resending can't help, and holding the batch
      // would block every record behind it.
      logger.error('Audit sink rejected batch - dropped', {
        status: res.status,
        records: records.length,
      });
      return 'rejected';
    } catch (err) {
      logger.warn('Audit sink unreachable - will retry', { error: errorMessage(err) });
      return 'retry';
    }
  }

  /** Drop the oldest records past the cap. */
  private trimToCap(): void {
    const excess = this.queue.length - this.options.queueMax;
    if (excess <= 0) return;
    this.queue.splice(0, excess);
    this.dropped += excess;
    this.reportDrops(false);
  }

  /** Log the overflow count: throttled while the sink is down, always once it is back. */
  private reportDrops(force: boolean): void {
    if (this.dropped === 0) return;
    const now = this.now();
    if (!force && now - this.droppedReportedAt < DROP_REPORT_SECONDS) return;
    logger.warn('Audit queue overflowed - oldest records dropped', { dropped: this.dropped });
    this.dropped = 0;
    this.droppedReportedAt = now;
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, ms);
    this.timer.unref();
  }
}

function backoffMs(failures: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
}
