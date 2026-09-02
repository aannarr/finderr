/**
 * The client cache, across a reload.
 *
 * `../lib/api.ts` holds everything this app has fetched in a `Map`, which dies with the
 * page. On a desktop that costs one round trip nobody notices. On a phone -- the device
 * this product is mostly used from -- a reload is a routine event: the OS evicts a
 * backgrounded tab, the reader comes back an hour later, and the front page is a blank
 * skeleton for as long as the network takes. This module keeps a bounded copy on disk so
 * coming back paints the page that was there when you left.
 *
 * > [!IMPORTANT] EVERYTHING RESTORED HERE IS FOR PAINTING, NEVER FOR ANSWERING
 * > `api.ts` already draws that line -- "the cache is for painting, not for answering" is
 * > its own note on `cachedCollection` -- and persistence is what makes the distinction
 * > matter. A title row carries library state, request status and download progress, all of
 * > which move while the app is closed. A restored row is a picture of the last session, so
 * > `Cache.get` returns it (the header paints instantly) and `Cache.fresh` does not (the
 * > fetch that would have happened still happens, and corrects it).
 * >
 * > That is what lets this be generous with what it stores without ever showing a stale
 * > answer. Take the distinction away and the top of a title page would go on claiming a
 * > film is missing hours after it arrived.
 *
 * The store is INJECTED. IndexedDB does not exist in the test runner, and a module that
 * reached for it directly could only be tested by pretending to be a browser.
 */

/**
 * Bumped when the SHAPE of a persisted value changes -- a field added to `Title`, a
 * response envelope reworked.
 *
 * A snapshot at a different version is DROPPED rather than migrated. There is no data here
 * that cannot be re-fetched in one request, so a migration would be code with a real
 * failure mode written to protect something worth nothing.
 */
export const CACHE_SCHEMA_VERSION = 1;

/**
 * How old a snapshot may be before it is ignored.
 *
 * The index rebuilds nightly and the library mirror runs every sixty seconds, so a
 * week-old poster grid is a page about a library that has moved on. It would be corrected
 * by the refetch either way -- this is about not FLASHING something visibly wrong first.
 */
export const CACHE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

/** One cache, as it sits on disk. */
export interface CacheSnapshot {
  version: number;
  /** Epoch milliseconds. Compared against `CACHE_MAX_AGE_MS` on the way back in. */
  savedAt: number;
  /** Least-recently-used FIRST, matching the iteration order of the `Map` behind a cache. */
  entries: [string, unknown][];
}

/**
 * Where snapshots live. One implementation talks to IndexedDB; one does nothing.
 *
 * NOTHING HERE MAY REJECT. Every caller is on a path where the correct response to a
 * storage failure is to carry on without persistence, so the failure is handled at the
 * boundary rather than being propagated to code that could only swallow it.
 */
export interface SnapshotStore {
  read(name: string): Promise<CacheSnapshot | null>;
  write(name: string, snapshot: CacheSnapshot): Promise<void>;
  clear(): Promise<void>;
}

/**
 * The part of `api.ts`'s `Cache` this module needs.
 *
 * Declared here rather than imported, so the dependency points one way: `api.ts` knows
 * about persistence, persistence knows nothing about titles, searches or shelves.
 */
export interface PersistableCache {
  /** Least-recently-used first, so the tail is what a bounded snapshot should keep. */
  entries(): [string, unknown][];
  /** Add entries beneath whatever the cache already holds, marked as restored. */
  restore(entries: readonly [string, unknown][]): void;
  /** Increments on every write. Unchanged since the last flush means nothing to save. */
  readonly revision: number;
}

/** One cache, and how much of it is worth keeping. */
export interface PersistedCacheSpec {
  /** The key it is stored under. Stable -- renaming one orphans its snapshot. */
  name: string;
  cache: PersistableCache;
  /**
   * The most-recently-used N entries to write.
   *
   * Deliberately smaller than the in-memory cap. What a reload needs is the handful of
   * pages the reader was just on, and every extra entry is bytes to read back before the
   * first paint -- which is the one moment this feature is trying to make faster.
   */
  keep: number;
}

/**
 * Reads and writes a set of caches as a group.
 *
 * The clock is injected for the same reason the store is: a test for "a snapshot older
 * than the limit is ignored" that has to wait three days is not a test.
 */
export class CachePersistence {
  private lastFlushed = new Map<string, number>();

  constructor(
    private readonly store: SnapshotStore,
    private readonly specs: readonly PersistedCacheSpec[],
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Fill the caches from disk. Called once, before the first render.
   *
   * Rejecting is not among the outcomes: a browser in private mode, a device out of
   * storage and a corrupt database all mean "no head start", never "the app does not
   * start".
   */
  async hydrate(): Promise<void> {
    await Promise.all(
      this.specs.map(async (spec) => {
        const snapshot = await this.store.read(spec.name);
        if (!usable(snapshot, this.now())) return;
        spec.cache.restore(snapshot.entries);
        // Recorded as already-saved, so a session that restores and changes nothing does
        // not rewrite the identical bytes when the reader backgrounds the app.
        this.lastFlushed.set(spec.name, spec.cache.revision);
      }),
    );
  }

  /** Write back anything that has changed since the last write. */
  async flush(): Promise<void> {
    const savedAt = this.now();
    await Promise.all(
      this.specs.map(async (spec) => {
        const revision = spec.cache.revision;
        if (this.lastFlushed.get(spec.name) === revision) return;
        // Set BEFORE the await: two flushes can overlap (backgrounding while a pagehide is
        // already in flight) and the second would otherwise write the same snapshot again.
        this.lastFlushed.set(spec.name, revision);
        const entries = spec.cache.entries();
        await this.store.write(spec.name, {
          version: CACHE_SCHEMA_VERSION,
          savedAt,
          // The TAIL, because `entries()` is least-recently-used first.
          entries: entries.slice(Math.max(0, entries.length - spec.keep)),
        });
      }),
    );
  }

  /**
   * Forget everything on disk.
   *
   * SIGNING OUT IS THE CALLER THAT MATTERS. A title row records what the library holds and
   * what this reader has asked for; leaving that on a shared iPad after somebody signs out
   * is a disclosure the in-memory cache never made, because it died with the page. The
   * revision bookkeeping is reset too, so the next flush writes rather than believing the
   * deleted snapshot is still current.
   */
  async clear(): Promise<void> {
    this.lastFlushed.clear();
    await this.store.clear();
  }
}

/** Is this snapshot worth restoring? */
function usable(snapshot: CacheSnapshot | null, now: number): snapshot is CacheSnapshot {
  if (!snapshot) return false;
  if (snapshot.version !== CACHE_SCHEMA_VERSION) return false;
  return now - snapshot.savedAt <= CACHE_MAX_AGE_MS;
}

/**
 * A store that keeps nothing, for every browser that cannot or will not persist.
 *
 * A real implementation of the interface rather than a `null` the caller checks for: a
 * store that answers "nothing here" honestly needs no special case anywhere else, and the
 * alternative is an `if` at every call site that one day gets forgotten at one of them.
 */
export function noSnapshotStore(): SnapshotStore {
  return {
    read: async () => null,
    write: async () => {},
    clear: async () => {},
  };
}

const DB_NAME = "finderr-cache";
const DB_VERSION = 1;
const STORE = "snapshots";

/**
 * IndexedDB, wrapped so the rest of this file never sees an event-based API.
 *
 * IndexedDB rather than `localStorage`, and the reason is the shape of the data: entries
 * are arrays of objects, which `localStorage` can only hold as JSON -- a string to
 * serialise on write and parse on read, SYNCHRONOUSLY, on the main thread, at exactly the
 * moment the app is trying to paint. IndexedDB stores the structured clone and hands it
 * back as objects, off-thread, with no parse at all.
 *
 * Returns the do-nothing store where IndexedDB is missing, which includes every non-browser
 * context this module is imported into.
 */
export function indexedDbSnapshotStore(): SnapshotStore {
  if (typeof indexedDB === "undefined") return noSnapshotStore();

  // One connection for the life of the page, opened lazily on the first read or write.
  // Re-opening per operation would pay the upgrade check every time.
  let db: Promise<IDBDatabase> | undefined;
  const open = (): Promise<IDBDatabase> => {
    db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        // Out-of-line keys: the cache's name is passed to `put`, so nothing has to be
        // embedded in the value.
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("indexedDB open failed"));
      // Another tab holding an older version open. Failing here is correct -- the caller
      // treats it as "no persistence" -- and the alternative is blocking the app on a tab
      // the reader may never close.
      request.onblocked = () => reject(new Error("indexedDB upgrade blocked"));
    });
    return db;
  };

  /** Run one transaction and resolve with whatever `body` asked for. */
  const run = async <T>(
    mode: IDBTransactionMode,
    body: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> => {
    const connection = await open();
    return await new Promise<T>((resolve, reject) => {
      const tx = connection.transaction(STORE, mode);
      const request = body(tx.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("indexedDB request failed"));
      tx.onabort = () => reject(tx.error ?? new Error("indexedDB transaction aborted"));
    });
  };

  /*
    EVERY FAILURE IS SWALLOWED HERE, at the boundary, and nowhere else.

    Safari in private browsing, a device at its storage quota and a database another tab is
    upgrading all throw from IndexedDB, and every one of them means the same thing to
    finderr: this load has no head start. Letting any of them past this function would put
    a `catch` on a caller whose only honest response is the one already written here.
  */
  return {
    read: async (name) => {
      try {
        return (await run<CacheSnapshot | undefined>("readonly", (s) => s.get(name))) ?? null;
      } catch {
        return null;
      }
    },
    write: async (name, snapshot) => {
      try {
        await run("readwrite", (s) => s.put(snapshot, name));
      } catch {
        /* storage is a nicety; losing it changes nothing the reader can see */
      }
    },
    clear: async () => {
      try {
        await run("readwrite", (s) => s.clear());
      } catch {
        /* see above -- and a clear that fails leaves a snapshot the version check will
           eventually retire anyway */
      }
    },
  };
}

/**
 * Resolve when `work` finishes or when `ms` have passed, whichever is first.
 *
 * The app awaits `hydrate()` before its first render, because the front page reads the
 * cache in a `useState` initialiser and a snapshot that arrives one tick late is a snapshot
 * that is never used. That makes storage part of the boot path, and anything on the boot
 * path needs a way out: a database another tab is upgrading can hang indefinitely, and
 * "finderr does not start" is a far worse outcome than "finderr started without its cache".
 *
 * It does not cancel the work -- there is nothing to cancel -- it stops WAITING for it.
 */
export function withDeadline(work: Promise<void>, ms: number): Promise<void> {
  return Promise.race([
    work,
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }),
  ]);
}
