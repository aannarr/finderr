import { describe, expect, test } from "bun:test";
import { AsyncCache } from "./async-cache";

/** A promise plus the handle to settle it, so a test can hold a call open. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("AsyncCache in-flight coalescing", () => {
  test("a burst of callers costs ONE producer call", async () => {
    const cache = new AsyncCache<string, number>();
    let calls = 0;
    const gate = deferred<number>();

    // The shape the facet resolver actually produces: every provider started in one
    // synchronous burst, before any of them has had a chance to settle.
    const all = Promise.all([
      cache.getOrAdd("tt1", () => {
        calls++;
        return gate.promise;
      }),
      cache.getOrAdd("tt1", () => {
        calls++;
        return gate.promise;
      }),
      cache.getOrAdd("tt1", () => {
        calls++;
        return gate.promise;
      }),
    ]);

    expect(calls).toBe(1);
    expect(cache.pending).toBe(1);
    gate.resolve(7);
    expect(await all).toEqual([7, 7, 7]);
  });

  test("different keys do not coalesce with each other", async () => {
    const cache = new AsyncCache<string, string>();
    const seen: string[] = [];
    const [a, b] = await Promise.all([
      cache.getOrAdd("tt1", async (k) => {
        seen.push(k);
        return k.toUpperCase();
      }),
      cache.getOrAdd("tt2", async (k) => {
        seen.push(k);
        return k.toUpperCase();
      }),
    ]);
    expect(seen.sort()).toEqual(["tt1", "tt2"]);
    expect([a, b]).toEqual(["TT1", "TT2"]);
  });

  test("the entry is dropped once the call settles, so a later view asks again", async () => {
    const cache = new AsyncCache<string, number>();
    let calls = 0;
    const produce = async () => ++calls;

    expect(await cache.getOrAdd("tt1", produce)).toBe(1);
    expect(cache.pending).toBe(0);
    // This cache coalesces a BURST. Remembering across views is the facet cache's job,
    // and a second call here proves this one is not quietly doing it.
    expect(await cache.getOrAdd("tt1", produce)).toBe(2);
  });

  test("a rejection is not cached and does not strand the key", async () => {
    const cache = new AsyncCache<string, number>();
    let calls = 0;

    await expect(
      cache.getOrAdd("tt1", async () => {
        calls++;
        throw new Error("502 from upstream");
      }),
    ).rejects.toThrow("502 from upstream");

    expect(cache.pending).toBe(0);
    // A transport failure during a deploy must not become a permanent absence.
    expect(await cache.getOrAdd("tt1", async () => 42)).toBe(42);
    expect(calls).toBe(1);
  });

  test("every caller in a burst sees the same rejection", async () => {
    const cache = new AsyncCache<string, number>();
    const gate = deferred<number>();
    const producer = () => gate.promise;

    const first = cache.getOrAdd("tt1", producer);
    const second = cache.getOrAdd("tt1", producer);
    gate.reject(new Error("boom"));

    await expect(first).rejects.toThrow("boom");
    await expect(second).rejects.toThrow("boom");
  });
});

describe("AsyncCache persistence", () => {
  test("a stored value skips the producer entirely", async () => {
    const kv = new Map<string, number>([["tt1", 603]]);
    let calls = 0;
    const cache = new AsyncCache<string, number>({
      load: (k) => kv.get(k),
      save: (k, v) => kv.set(k, v),
    });

    expect(await cache.getOrAdd("tt1", async () => ++calls)).toBe(603);
    expect(calls).toBe(0);
  });

  test("a produced value is saved before any caller sees it", async () => {
    const kv = new Map<string, number>();
    const cache = new AsyncCache<string, number>({
      load: (k) => kv.get(k),
      save: (k, v) => kv.set(k, v),
    });

    const value = await cache.getOrAdd("tt1", async () => 603);
    expect(value).toBe(603);
    expect(kv.get("tt1")).toBe(603);
  });

  test("null is a VALUE, so only `undefined` from load means miss", async () => {
    // The tmdb crosswalk answers `number | null` and stores only its successes. If `null`
    // read as a miss, a stored value could never be nullable; if it read as a hit, an
    // unstored key would resolve to `null` forever and the title would stay invisible.
    const kv = new Map<string, number | null>([["known", null]]);
    let calls = 0;
    const cache = new AsyncCache<string, number | null>({
      load: (k) => (kv.has(k) ? (kv.get(k) as number | null) : undefined),
    });

    const produce = async () => {
      calls++;
      return 1;
    };

    expect(await cache.getOrAdd("known", produce)).toBe(null);
    expect(calls).toBe(0);
    expect(await cache.getOrAdd("unknown", produce)).toBe(1);
    expect(calls).toBe(1);
  });

  test("save can decline, and the declined key is bought again next time", async () => {
    const kv = new Map<string, number>();
    let calls = 0;
    const cache = new AsyncCache<string, number | null>({
      load: (k) => (kv.has(k) ? kv.get(k) : undefined),
      // Only successes are stored: a title the provider has not indexed yet may well be
      // there next month, so a cached "no" would hide it permanently.
      save: (k, v) => {
        if (v !== null) kv.set(k, v);
      },
    });

    const produce = async (answer: number | null) => {
      calls++;
      return answer;
    };

    expect(await cache.getOrAdd("tt1", () => produce(null))).toBe(null);
    expect(kv.has("tt1")).toBe(false);
    expect(await cache.getOrAdd("tt1", () => produce(5))).toBe(5);
    expect(kv.get("tt1")).toBe(5);
    expect(calls).toBe(2);
  });

  test("one burst saves once", async () => {
    const writes: number[] = [];
    const gate = deferred<number>();
    const cache = new AsyncCache<string, number>({ save: (_k, v) => writes.push(v) });
    const producer = () => gate.promise;

    const all = Promise.all([
      cache.getOrAdd("tt1", producer),
      cache.getOrAdd("tt1", producer),
      cache.getOrAdd("tt1", producer),
    ]);
    gate.resolve(9);
    await all;
    expect(writes).toEqual([9]);
  });

  test("a caller joining between resolve and save still gets the coalesced call", async () => {
    let calls = 0;
    const gate = deferred<number>();
    const cache = new AsyncCache<string, number>({ save: () => {} });

    const first = cache.getOrAdd("tt1", () => {
      calls++;
      return gate.promise;
    });
    gate.resolve(3);
    // One microtask: the producer has resolved, the save/cleanup chain has not run out.
    await Promise.resolve();
    const second = cache.getOrAdd("tt1", () => {
      calls++;
      return Promise.resolve(99);
    });

    expect(await first).toBe(3);
    expect(await second).toBe(3);
    expect(calls).toBe(1);
  });
});
