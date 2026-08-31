/**
 * One async value per key, bought once however many callers ask at once.
 *
 * This is the shape four call sites in `src/plugins/` had each written out by hand, and it
 * exists because of ONE property of the facet resolver: it starts every provider for a
 * title in a single synchronous burst (see the header of `src/lib/facet-resolver.ts`). A
 * plugin serving thirteen facets from one upstream document therefore sees thirteen
 * simultaneous first calls, and without coalescing it buys thirteen copies of the same
 * payload from somebody else's free proxy.
 *
 * Two layers, and they answer different questions:
 *
 *   - **In-flight**, always on. Collapses one BURST. The entry is dropped the moment the
 *     call settles, so this remembers nothing between views -- that is the facet cache's
 *     job, not this one's.
 *   - **Persistent**, opt-in via `load`/`save`. For the expensive half of a lookup that
 *     never changes: a `tconst -> tmdbId` crosswalk survives its facet expiring, so a
 *     refresh re-fetches the data against a known id instead of re-buying the id.
 *
 * > [!IMPORTANT] `load` says "miss" with `undefined`, never with `null`
 * > `V` is frequently nullable here -- `resolveTmdbId` answers `number | null` -- so `null`
 * > is a VALUE and cannot also mean "nothing stored". Every caller that stores only its
 * > successes relies on this: an unstored key must fall through to the producer, and a
 * > stored one must never be bought again.
 *
 * Deliberately NOT used by `FacetResolver`, `ArtworkService` or `ImageCache`, which own the
 * other three copies of the bare in-flight map. Each carries semantics this does not model
 * -- a per-provider deadline and cancellation, a two-kind lookup, a `Response` that must be
 * cloned per caller -- and folding them in would mean growing options for one caller each.
 */

export interface AsyncCacheOptions<K, V> {
  /**
   * A previously saved value for this key, or `undefined` if there is none.
   *
   * Called on EVERY `getOrAdd` before anything else, so a hit costs neither a producer call
   * nor a map lookup. Must be cheap and synchronous -- `PluginKv.get` is one indexed SQLite
   * read, which is the intended weight.
   */
  load?: (key: K) => V | undefined;
  /**
   * Persist a produced value. Called once, after the producer resolves, before any caller
   * sees the value.
   *
   * The caller decides what is worth keeping: a provider that stores only its successes
   * simply returns without writing when the value is `null`. A permanently cached "no"
   * would keep a title invisible for good, which is why that judgement lives here rather
   * than in this class.
   */
  save?: (key: K, value: V) => void;
}

export class AsyncCache<K, V> {
  private readonly inFlight = new Map<K, Promise<V>>();
  private readonly load?: (key: K) => V | undefined;
  private readonly save?: (key: K, value: V) => void;

  constructor(opts: AsyncCacheOptions<K, V> = {}) {
    this.load = opts.load;
    this.save = opts.save;
  }

  /**
   * The value for `key`: the stored one, the one already being fetched, or a new one.
   *
   * A rejection is NOT cached -- the entry is dropped either way, so the next caller
   * retries. That is deliberate and matches every site this replaced: a 502 during a deploy
   * must not turn into a permanent absence, and the facet resolver has its own much shorter
   * TTL for a failure.
   */
  getOrAdd(key: K, producer: (key: K) => Promise<V>): Promise<V> {
    const stored = this.load?.(key);
    if (stored !== undefined) return Promise.resolve(stored);

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const save = this.save;
    const produced = save
      ? producer(key).then((value) => {
          save(key, value);
          return value;
        })
      : producer(key);

    // `finally` AFTER the save, so a caller arriving between the producer resolving and the
    // value being stored still joins this promise rather than starting a second call that
    // would race the write.
    const task = produced.finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, task);
    return task;
  }

  /** How many calls are outstanding. For tests and diagnostics; never a control signal. */
  get pending(): number {
    return this.inFlight.size;
  }
}
