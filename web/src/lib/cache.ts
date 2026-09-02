/**
 * The in-memory cache every fetched response lands in.
 *
 * Extracted from `./api.ts`, which owns the INSTANCES and the routes that fill them. This
 * file owns the container: what it keeps, in what order, and the one distinction that
 * matters once entries can also arrive from disk.
 *
 * It satisfies `PersistableCache` in `./cache-persistence.ts` without importing it, so the
 * dependency runs one way -- storage knows about caches, the cache knows nothing about
 * storage.
 */

/**
 * LRU-ish cache. Entries never expire during a session -- the index only changes
 * once a day, and library state is patched in separately rather than invalidating
 * the whole search cache.
 *
 * > [!IMPORTANT] `get` PAINTS, `fresh` ANSWERS, and the difference is only visible once
 * > entries can arrive from disk
 * > A cache restored by `./cache-persistence.ts` holds rows written during an earlier
 * > session, so a request may have completed and a film may have arrived since. `get`
 * > returns them, because painting last session's header instantly and correcting it a
 * > moment later is exactly what a reader wants. `fresh` does not, so the fetch that
 * > would have happened still happens. Everything a caller SHORT-CIRCUITS on must go
 * > through `fresh`; everything a caller merely DRAWS may use `get`.
 */
export class Cache<T> {
  private map = new Map<string, T>();
  /**
   * Keys that came from a previous session rather than from this one's network.
   *
   * A set beside the map rather than a wrapper object per entry: the flag is about where
   * a value came from, not part of the value, and wrapping would put it in front of every
   * reader of every cached row.
   */
  private restored = new Set<string>();
  /** Bumped on every write. `CachePersistence` uses it to skip an unchanged snapshot. */
  private writes = 0;

  constructor(private max = 500) {}

  /** Anything held, including a copy restored from disk. For DRAWING. */
  get(key: string): T | undefined {
    const v = this.map.get(key);
    // Re-insert so the most recently used entry is last, making eviction correct.
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  /** Only what this session fetched. For deciding NOT to fetch. */
  fresh(key: string): T | undefined {
    if (this.restored.has(key)) return undefined;
    return this.get(key);
  }

  set(key: string, value: T): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    // A real response supersedes the restored copy, so this key stops being second-hand.
    this.restored.delete(key);
    this.writes++;
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) {
        this.map.delete(oldest);
        this.restored.delete(oldest);
      }
    }
  }

  clear(): void {
    this.map.clear();
    this.restored.clear();
    this.writes++;
  }

  get size(): number {
    return this.map.size;
  }

  /** The values, oldest first. How `patchTitleState` walks a cache it does not own. */
  values(): IterableIterator<T> {
    return this.map.values();
  }

  // --- persistence, via the `PersistableCache` shape in ./cache-persistence.ts ---------

  get revision(): number {
    return this.writes;
  }

  /** Least-recently-used FIRST, so a bounded snapshot keeps the tail. */
  entries(): [string, T][] {
    return [...this.map];
  }

  /**
   * Add entries from a previous session, UNDER anything already here.
   *
   * Under, because hydration races the first fetches on a slow start: a response that has
   * already landed is this session's answer and must not be replaced by last session's
   * picture of it. Restored keys are remembered so `fresh` keeps refusing them.
   *
   * The values are cast rather than validated. Nothing else could be honestly done with a
   * structured clone of our own objects, and the guard that makes it safe is upstream --
   * `CACHE_SCHEMA_VERSION` retires every snapshot whose shape this build no longer
   * recognises.
   */
  restore(entries: readonly [string, unknown][]): void {
    for (const [key, value] of entries) {
      if (this.map.has(key)) continue;
      this.map.set(key, value as T);
      this.restored.add(key);
      // Deliberately NOT `this.writes++`: restoring is not a change worth writing back,
      // and counting it would make the first flush of every session rewrite what it just
      // read.
    }
    // Restoring past the cap is possible when a snapshot outlives a shrunk limit. Trim
    // oldest-first, exactly as `set` does.
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
      this.restored.delete(oldest);
    }
  }
}
