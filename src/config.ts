/**
 * Environment-driven configuration. The middleman secret key is read once at
 * boot, the public key derived from it, and the secret kept only in memory.
 */
import 'dotenv/config';
import { getPublicKey } from 'nostr-tools/pure';
import { hexToBytes } from 'nostr-tools/utils';
import { CODE_REUSE_SECONDS } from './store.ts';
import { intEnv, optional, required } from './env.ts';
import { loadAuditToken } from './audit.ts';
import type { AuditConfig } from './audit-sender.ts';

export interface Config {
  /** 32-byte middleman secret key. */
  secretKey: Uint8Array;
  /** Derived hex public key. */
  publicKey: string;
  relays: string[];
  /** Code validity window (anchored to the request's created_at). */
  codeTtlSeconds: number;
  /** How long a lapsed code still answers `regby_code_expired`.
   * Past it the row is kept, answering `regby_code_locked`, until 72 h
   * (`CODE_REUSE_SECONDS`) so its number is not reused. */
  codeRetainSeconds: number;
  /** Base SQLite path; a per-UTC-day file (`regby-YYYY-MM-DD.db`) is derived from it. */
  dbPath: string;
  /** NIP-40 event expiry - relay-retention buffer past code validity. */
  eventExpirySeconds: number;
  /** Tolerance for a merchant event's `created_at` vs server clock (seconds). */
  clockSkewSeconds: number;
  rateMax: number;
  rateWindowSeconds: number;
  /** Global (all-sender) cap on redeem attempts per window - bounds code
   * enumeration by an attacker who rotates through cheap, fresh pubkeys. */
  redeemRateMax: number;
  redeemRateWindowSeconds: number;
  /** Global (all-sender) cap on mints per window. Each mint holds a store row
   * for the 72 h reuse window, so without it fresh pubkeys could fill `storeMax`
   * and leave every merchant on `regby_code_busy` for three days after the flood stops. */
  mintRateMax: number;
  mintRateWindowSeconds: number;
  /** Not-found or locked redeems from one sender within the window before it's
   * blacklisted as a code-guesser (expired / redeemed don't count - a real
   * customer is late with a real code). */
  redeemFailMax: number;
  storeMax: number;
  /** How long a code guesser stays blacklisted (seconds). */
  blacklistSeconds: number;
  /** External audit sink (see `audit-sender.ts`); null disables the audit. */
  audit: AuditConfig | null;
  logLevel: string | undefined;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** A dotless name such as `audit-sink`: a compose service on the host's private network, never public DNS. */
const SERVICE_NAME_RE = /^[a-z0-9-]+$/i;

/**
 * The token and full invoices ride this connection, so plain http is allowed
 * only to this machine: loopback, or a container beside the broker reached by
 * its service name (docker-compose.audit.yml).
 */
function loadAuditConfig(): AuditConfig | null {
  const raw = optional('REGBY_AUDIT_URL');
  if (raw === null) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`REGBY_AUDIT_URL is not a URL: "${raw}"`);
  }
  const local = LOOPBACK_HOSTS.has(url.hostname) || SERVICE_NAME_RE.test(url.hostname);
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && local);
  if (!secure) {
    throw new Error('REGBY_AUDIT_URL must be https:// (http:// only to localhost or a compose service name)');
  }
  return {
    url,
    token: loadAuditToken(),
    queueMax: intEnv('REGBY_AUDIT_QUEUE_MAX', 10_000),
  };
}

const HEX64_RE = /^[0-9a-f]{64}$/i;

/**
 * Hard ceiling the dedicated ReGBY DM relays (`REGBY_RELAYS`) put on NIP-40
 * expiration: they drop any event stamped further out than 72h. Every
 * reply we publish carries `eventExpirySeconds`, so a value above this would
 * silently get every reply bounced. Fail loud at boot instead.
 */
const REGBY_RELAY_MAX_EXPIRY_SECONDS = 72 * 60 * 60;

/** Decode a 64-char hex private key to raw secret bytes. */
function parseSecretKey(value: string): Uint8Array {
  if (!HEX64_RE.test(value)) {
    throw new Error('REGBY_PRIVATE_KEY must be a 64-char hex private key');
  }
  return hexToBytes(value);
}

function parseRelays(value: string): string[] {
  const relays = value
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
  for (const r of relays) {
    if (!r.startsWith('wss://') && !r.startsWith('ws://')) {
      throw new Error(`Relay "${r}" must be a ws:// or wss:// URL`);
    }
  }
  if (relays.length === 0) throw new Error('REGBY_RELAYS lists no relays');
  return relays;
}

export function loadConfig(): Config {
  const secretKey = parseSecretKey(required('REGBY_PRIVATE_KEY'));
  const publicKey = getPublicKey(secretKey);

  const expected = process.env.REGBY_EXPECTED_PUBKEY?.trim();
  if (expected && expected.toLowerCase() !== publicKey.toLowerCase()) {
    throw new Error(
      `Derived pubkey ${publicKey} does not match REGBY_EXPECTED_PUBKEY ${expected}`,
    );
  }

  const codeTtlSeconds = intEnv('REGBY_CODE_TTL_SECONDS', 60);
  const codeRetainSeconds = intEnv('REGBY_CODE_RETAIN_SECONDS', 3600);
  if (codeRetainSeconds < codeTtlSeconds) {
    throw new Error('REGBY_CODE_RETAIN_SECONDS must be >= REGBY_CODE_TTL_SECONDS');
  }
  // A stale stamp is clamped to `now - skew`, so a skew at or past the TTL
  // anchors the code at or before its own expiry: mint refuses it and the
  // merchant is told `regby_code_busy` on every retry, since the next request is
  // just as stale.
  const clockSkewSeconds = intEnv('REGBY_CLOCK_SKEW_SECONDS', 30);
  if (clockSkewSeconds >= codeTtlSeconds) {
    throw new Error('REGBY_CLOCK_SKEW_SECONDS must be < REGBY_CODE_TTL_SECONDS');
  }
  // Rows are deleted, and not carried across midnight, once the 72 h reuse
  // window ends. A stamp up to `skew` ahead of the server anchors the answer
  // window that much later, so it must still close inside the reuse window.
  if (codeRetainSeconds + clockSkewSeconds > CODE_REUSE_SECONDS) {
    throw new Error(
      `REGBY_CODE_RETAIN_SECONDS + REGBY_CLOCK_SKEW_SECONDS must be <= ${CODE_REUSE_SECONDS}`,
    );
  }

  // A full reuse window at the mint ceiling must fit the store (see `Config.mintRateMax`).
  const storeMax = intEnv('REGBY_STORE_MAX', 1_500_000);
  const mintRateMax = intEnv('REGBY_MINT_RATE_MAX', 300);
  const mintRateWindowSeconds = intEnv('REGBY_MINT_RATE_WINDOW_SECONDS', 60);
  const mintsPerWindow = mintRateMax * Math.ceil(CODE_REUSE_SECONDS / mintRateWindowSeconds);
  if (mintsPerWindow > storeMax) {
    throw new Error(
      `REGBY_MINT_RATE_MAX admits up to ${mintsPerWindow} codes per ${CODE_REUSE_SECONDS / 3600} h, over REGBY_STORE_MAX (${storeMax})`,
    );
  }

  // Default is the relays' full 72h window less a one-minute clock-skew margin:
  // they compare the stamp against THEIR clock, so an exact-72h stamp bounces
  // on a host running even a second fast. Mirrors the app's `RELAY_EXPIRY_MS`.
  const eventExpirySeconds = intEnv('REGBY_EVENT_EXPIRY_SECONDS', REGBY_RELAY_MAX_EXPIRY_SECONDS - 60);
  if (eventExpirySeconds > REGBY_RELAY_MAX_EXPIRY_SECONDS) {
    throw new Error(
      `REGBY_EVENT_EXPIRY_SECONDS (${eventExpirySeconds}) exceeds the DM relay max (${REGBY_RELAY_MAX_EXPIRY_SECONDS} = 72h)`,
    );
  }

  return {
    secretKey,
    publicKey,
    relays: parseRelays(required('REGBY_RELAYS')),
    codeTtlSeconds,
    codeRetainSeconds,
    dbPath: process.env.REGBY_DB_PATH?.trim() || 'regby.db',
    eventExpirySeconds,
    clockSkewSeconds,
    rateMax: intEnv('REGBY_RATE_MAX', 30),
    rateWindowSeconds: intEnv('REGBY_RATE_WINDOW_SECONDS', 60),
    redeemRateMax: intEnv('REGBY_REDEEM_RATE_MAX', 300),
    redeemRateWindowSeconds: intEnv('REGBY_REDEEM_RATE_WINDOW_SECONDS', 60),
    mintRateMax,
    mintRateWindowSeconds,
    redeemFailMax: intEnv('REGBY_REDEEM_FAIL_MAX', 10),
    storeMax,
    blacklistSeconds: intEnv('REGBY_BLACKLIST_SECONDS', 86_400),
    audit: loadAuditConfig(),
    logLevel: process.env.REGBY_LOG_LEVEL,
  };
}
