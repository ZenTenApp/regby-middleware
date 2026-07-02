/**
 * Wall-clock seconds — the single time base every TTL, expiry, and rate window
 * in the broker is measured against. Centralised so the `Math.floor(Date.now()
 * / 1000)` idiom lives in one place and the injectable-clock default is shared.
 */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
