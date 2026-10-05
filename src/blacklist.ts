/**
 * Per-pubkey temporary blacklist. A sender that submits a `request_regby_code` whose
 * decrypted payload is not a `defito://` invoice is deliberately abusing the
 * service (they hold the conversation key - this is not random noise), so we
 * block them for a fixed window. Memory is bounded: entries are pruned on
 * access and by the periodic sweep.
 */
import { nowSeconds } from './time.ts';

export class Blacklist {
  private readonly until = new Map<string, number>();

  constructor(
    private readonly blockSeconds: number,
    private readonly now: () => number = nowSeconds,
  ) {}

  /** Block `key` for the configured window (refreshes an existing block). */
  block(key: string): void {
    this.until.set(key, this.now() + this.blockSeconds);
  }

  /** True while `key` is blocked; lazily drops the entry once it lapses. */
  blocked(key: string): boolean {
    const expiry = this.until.get(key);
    if (expiry === undefined) return false;
    if (expiry <= this.now()) {
      this.until.delete(key);
      return false;
    }
    return true;
  }

  /** Drop lapsed entries, to cap memory. */
  sweep(): void {
    const t = this.now();
    for (const [key, expiry] of this.until) {
      if (expiry <= t) this.until.delete(key);
    }
  }
}
