/**
 * Per-pubkey sliding-window rate limiter. Bounds how many events a single
 * sender can have us process per window, so one key can't exhaust the store or
 * spam replies. Memory is bounded: empty buckets are pruned on access.
 */
import { nowSeconds } from './time.ts';

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowSeconds: number,
    private readonly now: () => number = nowSeconds,
  ) {}

  /** Record a hit for `key`; returns false when the window is already full. */
  allow(key: string): boolean {
    const t = this.now();
    const cutoff = t - this.windowSeconds;
    const recent = (this.hits.get(key) ?? []).filter((ts) => ts > cutoff);
    const ok = recent.length < this.max;
    if (ok) recent.push(t);
    this.hits.set(key, recent);
    return ok;
  }

  /** Drop buckets whose hits have all aged out, to cap memory. */
  sweep(): void {
    const cutoff = this.now() - this.windowSeconds;
    for (const [key, times] of this.hits) {
      const recent = times.filter((t) => t > cutoff);
      if (recent.length === 0) this.hits.delete(key);
      else this.hits.set(key, recent);
    }
  }
}
