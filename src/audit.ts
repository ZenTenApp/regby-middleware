/**
 * Audit wire contract between the broker (sender, `audit-sender.ts`) and the
 * audit sink (`audit-sink/`), a separate process that alone holds the database
 * credentials and owns the permanent history: storage, retention, access. The
 * broker keeps none of it.
 *
 * One record per request the broker ANSWERED (or deliberately left unanswered
 * after doing work, like a guesser it blacklisted), plus one per merchant
 * redeem notice it sent. Not recorded: events
 * dropped before any work (blacklisted sender, rate limited, undecryptable,
 * unusable content) - attacker-controlled volume with nothing to reconstruct.
 *
 * The full content travels for a SERVED request (code_issued, regby_busy,
 * redeem). Content is opaque, so nothing here reads or redacts it.
 */
import { MAX_CONTENT_LENGTH, REGBY_CODE_RE } from './protocol.ts';
import { required } from './env.ts';

export const AUDIT_EVENTS = [
  'code_issued',
  'regby_busy',
  'redeem',
  'redeem_refused',
  'blacklisted',
  // Not a request: the notice sent to the merchant after a redeem. `pubkey` and
  // `requestEvent` are the merchant's and their original request's.
  'merchant_notified',
] as const;

export type AuditEvent = (typeof AUDIT_EVENTS)[number];

/**
 * Events only a broker from before content became opaque sends. Accepted (see
 * `fromLegacyShape`) so records in flight across that deploy are not lost; the
 * current broker never emits them.
 */
const LEGACY_EVENTS = ['invalid_request'] as const;

/** What the sink stores: today's events, plus the legacy ones still in history. */
export type StoredEvent = AuditEvent | (typeof LEGACY_EVENTS)[number];

export interface AuditRecord {
  /** Random UUID; the sink ignores a repeat, so a retried batch can't double rows. */
  id: string;
  /** Broker clock, unix seconds. */
  ts: number;
  event: StoredEvent;
  /** Full hex pubkey of the sender. */
  pubkey: string;
  /** Id of the inbound Nostr event this record answers. */
  requestEvent: string;
  code: string | null;
  /** Full content, opaque; only on a served request (see header). */
  content: string | null;
  /** Why a request was refused: `expired`, `redeemed`, `not-found`, `guessing`. */
  reason: string | null;
  /** Whether the reply reached a relay; null when none was sent. */
  delivered: boolean | null;
}

export interface AuditBatch {
  records: AuditRecord[];
}

/** Records per POST. Bounds both the sender's request and the sink's body. */
export const AUDIT_BATCH_MAX = 200;

/** The token authenticates the broker to the sink; short ones are guessable. */
const AUDIT_TOKEN_MIN_LENGTH = 32;

/** `REGBY_AUDIT_TOKEN`, shared by both sides and checked the same way. */
export function loadAuditToken(): string {
  const token = required('REGBY_AUDIT_TOKEN');
  if (token.length < AUDIT_TOKEN_MIN_LENGTH) {
    throw new Error(`REGBY_AUDIT_TOKEN must be at least ${AUDIT_TOKEN_MIN_LENGTH} characters`);
  }
  return token;
}

const HEX64_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REASON_MAX = 64;

type Check = (value: unknown) => boolean;

const isUint: Check = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const matches = (re: RegExp): Check => (v) => typeof v === 'string' && re.test(v);
const shortString = (max: number): Check => (v) => typeof v === 'string' && v.length <= max;
const orNull = (check: Check): Check => (v) => v === null || check(v);

/** One check per field: the sink stores nothing the broker could not have sent. */
const RECORD_FIELDS: Record<keyof AuditRecord, Check> = {
  id: matches(UUID_RE),
  ts: isUint,
  event: (v) => typeof v === 'string' && ([...AUDIT_EVENTS, ...LEGACY_EVENTS] as readonly string[]).includes(v),
  pubkey: matches(HEX64_RE),
  requestEvent: matches(HEX64_RE),
  code: orNull(matches(REGBY_CODE_RE)),
  content: orNull(shortString(MAX_CONTENT_LENGTH)),
  reason: orNull(shortString(REASON_MAX)),
  delivered: orNull((v) => typeof v === 'boolean'),
};

const FIELD_NAMES = Object.keys(RECORD_FIELDS) as (keyof AuditRecord)[];

/**
 * A record in the shape the broker sent before content became opaque (`uri`,
 * `detail`, plus three fields it no longer has), mapped to today's shape;
 * anything else is returned as is. During a deploy the sink is replaced before
 * the broker, so the old broker's last batches arrive here, and a 400 would
 * drop them for good. Remove once no broker of that age can still be running.
 */
function fromLegacyShape(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || !('uri' in value)) return value;
  const { uri, detail, validUntil, payloadHmac, payloadLength, ...rest } = value as Record<string, unknown>;
  const dropped = [validUntil, payloadHmac, payloadLength];
  if (!dropped.every((v) => v === null || typeof v === 'number' || typeof v === 'string')) return value;
  return { ...rest, content: uri, reason: detail };
}

function isAuditRecord(value: unknown): value is AuditRecord {
  if (typeof value !== 'object' || value === null) return false;
  if (Object.keys(value).length !== FIELD_NAMES.length) return false;
  const fields = value as Record<string, unknown>;
  return FIELD_NAMES.every((k) => k in fields && RECORD_FIELDS[k](fields[k]));
}

/** The records of a POSTed batch, or null if anything in it is off-contract. */
export function parseAuditBatch(body: unknown): AuditRecord[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const { records } = body as { records?: unknown };
  if (!Array.isArray(records) || records.length === 0 || records.length > AUDIT_BATCH_MAX) {
    return null;
  }
  const current = records.map(fromLegacyShape);
  return current.every(isAuditRecord) ? current : null;
}
