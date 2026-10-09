/**
 * Audit wire contract between the broker (sender, `audit-sender.ts`) and the
 * audit sink (`audit-sink/`), which runs on a separate machine and owns the
 * permanent history: storage, retention, access. The broker keeps none of it.
 *
 * One record per request the broker ANSWERED (or deliberately left unanswered
 * after doing work, like a guesser it blacklisted). Not recorded: events
 * dropped before any work (blacklisted sender, rate limited, undecryptable,
 * unusable content) - attacker-controlled volume with nothing to reconstruct.
 *
 * A full invoice travels only for a request that was SERVED (code_issued,
 * regby_busy, redeem). A refused payload is never sent as text: it may be a
 * near-miss invoice with real payment data in it, or arbitrary attacker
 * content, so the record carries its length and an HMAC keyed with the audit
 * token. Whoever holds the token can match a merchant's report against it; a
 * leaked copy of the history alone can't confirm a guessed invoice.
 */
import { createHmac } from 'node:crypto';
import { MAX_STORED_LENGTH, REGBY_CODE_RE } from './protocol.ts';
import { required } from './env.ts';

export const AUDIT_EVENTS = [
  'code_issued',
  'regby_busy',
  'redeem',
  'redeem_refused',
  'invalid_request',
  'blacklisted',
] as const;

export type AuditEvent = (typeof AUDIT_EVENTS)[number];

export interface AuditRecord {
  /** Random UUID; the sink ignores a repeat, so a retried batch can't double rows. */
  id: string;
  /** Broker clock, unix seconds. */
  ts: number;
  event: AuditEvent;
  /** Full hex pubkey of the sender. */
  pubkey: string;
  /** Id of the inbound Nostr event this record answers. */
  requestEvent: string;
  code: string | null;
  /** Full invoice; only on a served request (see header). */
  uri: string | null;
  /** Earliest `valid_until` across the invoice's rails. */
  validUntil: number | null;
  /** Refused payloads: keyed hash and length in place of the text. */
  payloadHmac: string | null;
  payloadLength: number | null;
  /** Refusal reason, e.g. `malformed`, `guessing`, `expired`. */
  detail: string | null;
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

/** Keyed hash and length of a refused payload, in place of its text. */
export function redactPayload(
  plaintext: string,
  key: string,
): Pick<AuditRecord, 'payloadHmac' | 'payloadLength'> {
  return {
    payloadHmac: createHmac('sha256', key).update(plaintext).digest('hex'),
    payloadLength: plaintext.length,
  };
}

const HEX64_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DETAIL_MAX = 64;

type Check = (value: unknown) => boolean;

const isUint: Check = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const matches = (re: RegExp): Check => (v) => typeof v === 'string' && re.test(v);
const shortString = (max: number): Check => (v) => typeof v === 'string' && v.length <= max;
const orNull = (check: Check): Check => (v) => v === null || check(v);

/** One check per field: the sink stores nothing the broker could not have sent. */
const RECORD_FIELDS: Record<keyof AuditRecord, Check> = {
  id: matches(UUID_RE),
  ts: isUint,
  event: (v) => typeof v === 'string' && (AUDIT_EVENTS as readonly string[]).includes(v),
  pubkey: matches(HEX64_RE),
  requestEvent: matches(HEX64_RE),
  code: orNull(matches(REGBY_CODE_RE)),
  uri: orNull(shortString(MAX_STORED_LENGTH)),
  validUntil: orNull(isUint),
  payloadHmac: orNull(matches(HEX64_RE)),
  payloadLength: orNull(isUint),
  detail: orNull(shortString(DETAIL_MAX)),
  delivered: orNull((v) => typeof v === 'boolean'),
};

const FIELD_NAMES = Object.keys(RECORD_FIELDS) as (keyof AuditRecord)[];

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
  return records.every(isAuditRecord) ? (records as AuditRecord[]) : null;
}
