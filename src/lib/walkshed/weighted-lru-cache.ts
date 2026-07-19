/**
 * Small weighted LRU cache for memory-heavy runtime data.
 *
 * The newest entry is retained even when it alone exceeds the weight budget.
 * This keeps a usable result for unusually large queries while still evicting
 * every older entry that would compound the memory pressure.
 */
export class WeightedLruCache<K, V> {
  private readonly entries = new Map<K, { value: V; weight: number }>();
  private totalWeight = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxWeight: number,
  ) {
    if (maxEntries < 1 || maxWeight < 0) {
      throw new RangeError('WeightedLruCache limits must be positive');
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;

    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, weight: number): K[] {
    if (!Number.isFinite(weight) || weight < 0) {
      throw new RangeError('WeightedLruCache entry weight must be finite and non-negative');
    }

    const existing = this.entries.get(key);
    if (existing) this.totalWeight -= existing.weight;
    this.entries.delete(key);
    this.entries.set(key, { value, weight });
    this.totalWeight += weight;

    const evictedKeys: K[] = [];
    while (
      this.entries.size > this.maxEntries ||
      (this.entries.size > 1 && this.totalWeight > this.maxWeight)
    ) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      this.totalWeight -= oldest?.weight ?? 0;
      evictedKeys.push(oldestKey);
    }
    return evictedKeys;
  }

  clear(): void {
    this.entries.clear();
    this.totalWeight = 0;
  }
}
