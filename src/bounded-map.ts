/**
 * A `Map` with a hard entry cap. When full, inserting a new key first evicts the
 * oldest-inserted one (`Map` preserves insertion order) - cheap FIFO eviction.
 * Used wherever an untrusted, unbounded key space (peer pubkeys, event ids)
 * feeds a cache or seen-set, so a flood of distinct keys can't grow memory
 * without limit.
 */
export class BoundedMap<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly max: number) {}

  get(key: K): V | undefined {
    return this.map.get(key);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  /** Insert/replace `key`; if at capacity for a NEW key, drop the oldest first. */
  set(key: K, value: V): void {
    if (!this.map.has(key) && this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, value);
  }

  get size(): number {
    return this.map.size;
  }
}
