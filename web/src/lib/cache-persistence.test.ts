import { describe, expect, test } from "bun:test";
import {
  CACHE_MAX_AGE_MS,
  CACHE_SCHEMA_VERSION,
  CachePersistence,
  type CacheSnapshot,
  noSnapshotStore,
  type PersistableCache,
  type SnapshotStore,
  withDeadline,
} from "./cache-persistence";

/**
 * A stand-in for `api.ts`'s `Cache`, honouring exactly the contract `PersistableCache`
 * declares and nothing more.
 *
 * Deliberately not the real one: these tests are about the persistence policy -- what gets
 * written, what gets ignored, what happens on sign-out -- and using the real cache would
 * couple them to search keys and title shapes that have nothing to do with any of it. The
 * real cache is checked against this same interface by the compiler.
 */
class FakeCache implements PersistableCache {
  private map = new Map<string, unknown>();
  private writes = 0;

  get revision(): number {
    return this.writes;
  }
  entries(): [string, unknown][] {
    return [...this.map];
  }
  restore(entries: readonly [string, unknown][]): void {
    for (const [k, v] of entries) if (!this.map.has(k)) this.map.set(k, v);
  }
  set(key: string, value: unknown): void {
    this.map.delete(key);
    this.map.set(key, value);
    this.writes++;
  }
  has(key: string): boolean {
    return this.map.has(key);
  }
  get size(): number {
    return this.map.size;
  }
}

/** An in-memory `SnapshotStore` that also counts writes, so "did it skip" is observable. */
function fakeStore(seed: Record<string, CacheSnapshot> = {}) {
  const data = new Map(Object.entries(seed));
  const writes: string[] = [];
  const store: SnapshotStore = {
    read: async (name) => data.get(name) ?? null,
    write: async (name, snapshot) => {
      writes.push(name);
      data.set(name, snapshot);
    },
    clear: async () => data.clear(),
  };
  return { store, data, writes };
}

function snapshot(entries: [string, unknown][], over: Partial<CacheSnapshot> = {}): CacheSnapshot {
  return { version: CACHE_SCHEMA_VERSION, savedAt: 1_000_000, entries, ...over };
}

const NOW = 1_000_000;
const clock = () => NOW;

describe("hydrate", () => {
  test("a good snapshot fills the cache", async () => {
    const cache = new FakeCache();
    const { store } = fakeStore({ titles: snapshot([["tt1", { title: "Alien" }]]) });
    await new CachePersistence(store, [{ name: "titles", cache, keep: 10 }], clock).hydrate();
    expect(cache.has("tt1")).toBe(true);
  });

  /**
   * A snapshot written by a build with a different idea of what a `Title` looks like is
   * DROPPED, not migrated. Nothing stored here costs more than one request to fetch again,
   * so a migration would be real code with a real failure mode protecting nothing.
   */
  test("a snapshot from another schema version is ignored", async () => {
    const cache = new FakeCache();
    const { store } = fakeStore({
      titles: snapshot([["tt1", {}]], { version: CACHE_SCHEMA_VERSION + 1 }),
    });
    await new CachePersistence(store, [{ name: "titles", cache, keep: 10 }], clock).hydrate();
    expect(cache.size).toBe(0);
  });

  /**
   * The index rebuilds nightly and the library mirror runs every sixty seconds. A snapshot
   * older than the limit would be corrected by the refetch either way -- the point is not
   * to FLASH something visibly wrong first.
   */
  test("a snapshot past the age limit is ignored", async () => {
    const cache = new FakeCache();
    const { store } = fakeStore({
      titles: snapshot([["tt1", {}]], { savedAt: NOW - CACHE_MAX_AGE_MS - 1 }),
    });
    await new CachePersistence(store, [{ name: "titles", cache, keep: 10 }], clock).hydrate();
    expect(cache.size).toBe(0);

    // ...and one exactly at the limit still counts, so the boundary is not off by a day.
    const fresh = new FakeCache();
    const edge = fakeStore({ titles: snapshot([["tt1", {}]], { savedAt: NOW - CACHE_MAX_AGE_MS }) });
    await new CachePersistence(edge.store, [{ name: "titles", cache: fresh, keep: 10 }], clock).hydrate();
    expect(fresh.size).toBe(1);
  });

  test("a store with nothing in it is not an error", async () => {
    const cache = new FakeCache();
    await new CachePersistence(noSnapshotStore(), [{ name: "titles", cache, keep: 10 }], clock).hydrate();
    expect(cache.size).toBe(0);
  });
});

describe("flush", () => {
  test("it keeps the most recently used entries and drops the rest", async () => {
    const cache = new FakeCache();
    for (const id of ["tt1", "tt2", "tt3", "tt4"]) cache.set(id, id);
    const { store, data } = fakeStore();

    await new CachePersistence(store, [{ name: "titles", cache, keep: 2 }], clock).flush();

    // `entries()` is least-recently-used first, so the TAIL is what a bounded snapshot
    // should keep -- the pages the reader was just on, not the ones they left first.
    expect(data.get("titles")?.entries.map(([k]) => k)).toEqual(["tt3", "tt4"]);
  });

  test("it stamps the snapshot with the current version and time", async () => {
    const cache = new FakeCache();
    cache.set("tt1", {});
    const { store, data } = fakeStore();
    await new CachePersistence(store, [{ name: "titles", cache, keep: 10 }], clock).flush();
    expect(data.get("titles")).toMatchObject({ version: CACHE_SCHEMA_VERSION, savedAt: NOW });
  });

  /**
   * Backgrounding an app fires `visibilitychange` and `pagehide` together, so flush is
   * called twice within a tick on every single switch away. Writing the same bytes twice
   * on every app switch is the difference between this being free and being a tax.
   */
  test("nothing changed means nothing written", async () => {
    const cache = new FakeCache();
    cache.set("tt1", {});
    const { store, writes } = fakeStore();
    const persistence = new CachePersistence(store, [{ name: "titles", cache, keep: 10 }], clock);

    await persistence.flush();
    await persistence.flush();
    expect(writes).toEqual(["titles"]);

    cache.set("tt2", {});
    await persistence.flush();
    expect(writes).toEqual(["titles", "titles"]);
  });

  /**
   * A session that opens the app, reads a restored front page and closes it again has
   * changed nothing -- and rewriting the identical snapshot on the way out is exactly the
   * work this is meant to avoid.
   */
  test("restoring is not a change, so a read-only session writes nothing", async () => {
    const cache = new FakeCache();
    const { store, writes } = fakeStore({ titles: snapshot([["tt1", {}]]) });
    const persistence = new CachePersistence(store, [{ name: "titles", cache, keep: 10 }], clock);

    await persistence.hydrate();
    await persistence.flush();
    expect(writes).toEqual([]);
  });
});

describe("clear", () => {
  /**
   * Sign-out. A title row records what the library holds and what this reader asked for,
   * and unlike the in-memory cache a snapshot outlives the page.
   */
  test("it empties the store and lets the next flush write again", async () => {
    const cache = new FakeCache();
    cache.set("tt1", {});
    const { store, data, writes } = fakeStore();
    const persistence = new CachePersistence(store, [{ name: "titles", cache, keep: 10 }], clock);

    await persistence.flush();
    await persistence.clear();
    expect(data.size).toBe(0);

    // The revision bookkeeping is reset with it: believing the deleted snapshot is still
    // current would make the next flush skip, and the store would stay empty until
    // something else happened to change.
    await persistence.flush();
    expect(writes).toEqual(["titles", "titles"]);
  });
});

describe("withDeadline", () => {
  /**
   * Hydration is on the boot path, because the front page reads the cache in a `useState`
   * initialiser that runs exactly once. Anything on the boot path needs a way out: a
   * database another tab is mid-upgrade on can hang indefinitely, and "finderr does not
   * start" is far worse than "finderr started without its cache".
   */
  test("a hung read stops being waited for", async () => {
    const started = Date.now();
    await withDeadline(new Promise<void>(() => {}), 20);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });

  test("work that finishes first is not delayed by the deadline", async () => {
    const started = Date.now();
    await withDeadline(Promise.resolve(), 5_000);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
