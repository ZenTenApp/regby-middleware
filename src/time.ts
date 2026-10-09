/**
 * Wall-clock seconds - the single time base every TTL, expiry, and rate window
 * in the broker is measured against. Centralised so the `Math.floor(Date.now()
 * / 1000)` idiom lives in one place and the injectable-clock default is shared.
 */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * A clock that never goes back: each read is at least the latest one before
 * it. Day rotation and code expiry both read through it, so a wall clock
 * stepping backward neither revives a lapsed code nor rolls the store back
 * into a file it already retired. Per process: a restart starts from the
 * wall clock again.
 */
export function monotonic(clock: () => number): () => number {
  let latest = Number.NEGATIVE_INFINITY;
  return () => {
    latest = Math.max(latest, clock());
    return latest;
  };
}
