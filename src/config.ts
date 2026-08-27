/**
 * Environment-driven configuration. The middleman secret key is read once at
 * boot, the public key derived from it, and the secret kept only in memory.
 */
import 'dotenv/config';
import { getPublicKey } from 'nostr-tools/pure';
import { hexToBytes } from 'nostr-tools/utils';

export interface Config {
  /** 32-byte middleman secret key. */
  secretKey: Uint8Array;
  /** Derived hex public key. */
  publicKey: string;
  relays: string[];
  /** Code validity window (anchored to the request's created_at). */
  codeTtlSeconds: number;
  /** How long an expired code row is kept (redeem → `Code Expired`) before purge. */
  codeRetainSeconds: number;
  /** Base SQLite path; a per-UTC-day file (`regby-YYYY-MM-DD.db`) is derived from it. */
  dbPath: string;
  /** NIP-40 event expiry — relay-retention buffer past code validity. */
  eventExpirySeconds: number;
  /** Tolerance for a merchant event's `created_at` vs server clock (seconds). */
  clockSkewSeconds: number;
  rateMax: number;
  rateWindowSeconds: number;
  /** Global (all-sender) cap on redeem attempts per window — bounds code
   * enumeration by an attacker who rotates through cheap, fresh pubkeys. */
  redeemRateMax: number;
  redeemRateWindowSeconds: number;
  /** Not-found redeems from one sender within the window before it's blacklisted
   * as a code-guesser (expired redeems don't count — those are real lapsed codes). */
  redeemFailMax: number;
  storeMax: number;
  /** How long a malicious-request sender stays blacklisted (seconds). */
  blacklistSeconds: number;
  logLevel: string | undefined;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env var ${name}`);
  }
  return value.trim();
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Env var ${name} must be a positive integer, got "${raw}"`);
  }
  return n;
}

const HEX64_RE = /^[0-9a-f]{64}$/i;

/**
 * Hard ceiling the dedicated ReGBY DM relays (`wss://dm1.zentext.me`,
 * `wss://dm2.nostr.box`) put on
 * NIP-40 expiration: they drop any event stamped further out than 72h. Every
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

  const codeTtlSeconds = intEnv('REGBY_CODE_TTL_SECONDS', 120);
  const codeRetainSeconds = intEnv('REGBY_CODE_RETAIN_SECONDS', 3600);
  if (codeRetainSeconds < codeTtlSeconds) {
    throw new Error('REGBY_CODE_RETAIN_SECONDS must be >= REGBY_CODE_TTL_SECONDS');
  }

  const eventExpirySeconds = intEnv('REGBY_EVENT_EXPIRY_SECONDS', 3600);
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
    clockSkewSeconds: intEnv('REGBY_CLOCK_SKEW_SECONDS', 120),
    rateMax: intEnv('REGBY_RATE_MAX', 30),
    rateWindowSeconds: intEnv('REGBY_RATE_WINDOW_SECONDS', 60),
    redeemRateMax: intEnv('REGBY_REDEEM_RATE_MAX', 300),
    redeemRateWindowSeconds: intEnv('REGBY_REDEEM_RATE_WINDOW_SECONDS', 60),
    redeemFailMax: intEnv('REGBY_REDEEM_FAIL_MAX', 10),
    storeMax: intEnv('REGBY_STORE_MAX', 10_000),
    blacklistSeconds: intEnv('REGBY_BLACKLIST_SECONDS', 86_400),
    logLevel: process.env.REGBY_LOG_LEVEL,
  };
}
