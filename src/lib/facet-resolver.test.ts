import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { BulkheadRejectedError } from "cockatiel";
import { loadConfig } from "./config";
import { FacetResolver, SLOW_PROVIDER_MS } from "./facet-resolver";
import type { FacetEntity } from "./facets";
import type { FacetProvider, LoadedPlugin, PluginMeta } from "./plugins";
import { DEFAULT_CONFIG_VERSION, PluginRegistry } from "./plugins";
import { Store } from "./store";

let dir: string;
let store: Store;
let logs: string[];

beforeEach(() => {
  dir = mkdtempSync(`${tmpdir()}/finderr-test-`);
  process.env.FINDERR_DATA_DIR = dir;
  store = new Store(loadConfig(true));
  logs = [];
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  process.env.FINDERR_DATA_DIR = undefined;
});

const INCEPTION: FacetEntity = {
  kind: "movie",
  tconst: "tt1375666",
  title: "Inception",
  originalTitle: "Inception",
  year: 2010,
  runtime: 148,
  ids: { imdb: "tt1375666" },
};

const GOT: FacetEntity = { ...INCEPTION, kind: "series", tconst: "tt0944947", title: "Game of Thrones" };

/**
 * A registry built by hand rather than loaded from disk.
 *
 * These tests are about what the resolver does with a provider's answer, so the loader
 * is not the subject; `plugins.test.ts` covers the on-disk half.
 */
function registryOf(
  ...providers: { id: string; facet: Parameters<PluginRegistry["providersFor"]>[0]; run: FacetProvider }[]
) {
  const registry = new PluginRegistry();
  for (const p of providers) {
    const meta: PluginMeta = { id: p.id, entities: ["movie", "series"] };
    const plugin: LoadedPlugin = {
      meta,
      file: `${p.id}.ts`,
      configVersion: DEFAULT_CONFIG_VERSION,
      config: [],
    };
    // No context to fake: a provider closes over its own, so what reaches the resolver is
    // already a bound `(entity) => ...`.
    registry.add(plugin, [{ pluginId: p.id, facet: p.facet, run: p.run }]);
  }
  return registry;
}

function resolverFor(registry: PluginRegistry, opts: { hardTimeoutMs?: number } = {}): FacetResolver {
  return new FacetResolver({ store, registry, log: (m) => logs.push(m), ...opts });
}

/** A provider that answers with one rating, after an optional delay. */
function ratingProvider(source: string, delayMs = 0): FacetProvider {
  return async () => {
    if (delayMs > 0) await Bun.sleep(delayMs);
    return { data: [{ source, kind: "critics", value: 86, outOf: 100 }] } as never;
  };
}

describe("a broken provider only ever removes itself", () => {
  /** Acceptance 4, first shape: a throw. */
  test("a provider that throws leaves the facet resolved without it", async () => {
    const resolver = resolverFor(
      registryOf(
        {
          id: "broken",
          facet: "ratings",
          run: async () => {
            throw new Error("upstream is down");
          },
        },
        { id: "working", facet: "ratings", run: ratingProvider("working") },
      ),
    );

    const facets = await resolver.resolve(INCEPTION, { deadlineMs: 2_000 });
    expect(facets.ratings?.status).toBe("ready");
    expect(facets.ratings?.data).toHaveLength(1);
    expect(logs.join("\n")).toMatch(/upstream is down/);
  });

  /** Acceptance 4, second shape: garbage that would break a merge or a renderer. */
  test("a provider returning the wrong shape is dropped, not merged", async () => {
    const resolver = resolverFor(
      registryOf(
        { id: "garbage", facet: "ratings", run: async () => "86%" as never },
        { id: "working", facet: "ratings", run: ratingProvider("working") },
      ),
    );

    const facets = await resolver.resolve(INCEPTION, { deadlineMs: 2_000 });
    expect(facets.ratings?.data).toEqual([{ source: "working", kind: "critics", value: 86, outOf: 100 }]);
    expect(logs.join("\n")).toMatch(/did not fit the facet shape/);
  });

  /** Acceptance 4, third shape: still running when the deadline passes. */
  test("a slow provider misses the response but its answer is still captured", async () => {
    const resolver = resolverFor(
      registryOf({ id: "slow", facet: "ratings", run: ratingProvider("slow", 80) }),
    );

    const first = await resolver.resolve(INCEPTION, { deadlineMs: 10 });
    expect(first.ratings?.status).toBe("pending");

    // The provider was never abandoned -- its promise carries the cache write.
    await Bun.sleep(150);
    expect(resolver.read(INCEPTION).ratings?.status).toBe("ready");
  });

  test("a provider answering null is 'nothing here', which is not a failure", async () => {
    const resolver = resolverFor(registryOf({ id: "nothing", facet: "ratings", run: async () => null }));

    const facets = await resolver.resolve(INCEPTION, { deadlineMs: 2_000 });
    expect(facets.ratings).toEqual({ status: "empty" });
    expect(store.facetContributions("tt1375666")[0]?.outcome).toBe("empty");
  });

  test("a facet only one provider failed on reports failed, not empty", async () => {
    const resolver = resolverFor(
      registryOf({
        id: "broken",
        facet: "ratings",
        run: async () => {
          throw new Error("nope");
        },
      }),
    );
    expect((await resolver.resolve(INCEPTION, { deadlineMs: 2_000 })).ratings?.status).toBe("failed");
  });
});

describe("statuses the page renders on", () => {
  test("a facet nobody provides is empty, so its pane hides instead of waiting", async () => {
    const facets = resolverFor(registryOf()).read(INCEPTION);
    expect(facets.ratings).toEqual({ status: "empty" });
  });

  test("only the facets that exist for this kind are reported", () => {
    const resolver = resolverFor(registryOf());
    expect(resolver.read(INCEPTION)).toHaveProperty("releaseDates");
    expect(resolver.read(INCEPTION).seasons).toBeUndefined();
    expect(resolver.read(GOT)).toHaveProperty("seasons");
    expect(resolver.read(GOT).releaseDates).toBeUndefined();
    // Core owns availability; it is never a facet a provider fills.
    expect(resolver.read(INCEPTION).availability).toBeUndefined();
  });

  /** Showing the score we have beats holding it back until the slow one replies. */
  test("one answer is enough to be ready, even while another provider is still out", async () => {
    const resolver = resolverFor(
      registryOf(
        { id: "fast", facet: "ratings", run: ratingProvider("fast") },
        { id: "slow", facet: "ratings", run: ratingProvider("slow", 200) },
      ),
    );

    const facets = await resolver.resolve(INCEPTION, { deadlineMs: 30 });
    expect(facets.ratings?.status).toBe("ready");
    expect(facets.ratings?.data).toHaveLength(1);

    await Bun.sleep(300);
    expect(resolver.read(INCEPTION).ratings?.data).toHaveLength(2);
  });
});

describe("the render path reads cache only", () => {
  test("read() never calls a provider", async () => {
    let calls = 0;
    const resolver = resolverFor(
      registryOf({
        id: "counted",
        facet: "ratings",
        run: async () => {
          calls++;
          return { data: [{ source: "counted", kind: "critics", value: 86, outOf: 100 }] } as never;
        },
      }),
    );

    await resolver.resolve(INCEPTION, { deadlineMs: 2_000 });
    expect(calls).toBe(1);

    for (let i = 0; i < 5; i++) expect(resolver.read(INCEPTION).ratings?.status).toBe("ready");
    expect(calls).toBe(1);
  });

  test("a cached answer is not re-fetched, and warm() is free to call on every view", async () => {
    let calls = 0;
    const resolver = resolverFor(
      registryOf({
        id: "counted",
        facet: "ratings",
        run: async () => {
          calls++;
          return { data: [{ source: "counted", kind: "critics", value: 86, outOf: 100 }] } as never;
        },
      }),
    );

    await resolver.resolve(INCEPTION, { deadlineMs: 2_000 });
    resolver.warm(INCEPTION);
    resolver.warm(INCEPTION);
    await Bun.sleep(20);
    expect(calls).toBe(1);
  });

  /**
   * The client's re-read schedule must not multiply upstream calls.
   *
   * `useTitleDetail` re-reads `/api/title/:tconst` up to three more times over 3.3 s for a
   * cold title (`FACET_RETRY_GAPS_MS`), and that handler calls `warm()` every time. The
   * `ok` path is covered above; these two are the ones that would be RUDE rather than
   * merely wasteful, because a provider that answers `empty` or throws is exactly the one
   * an unthrottled retry would hammer. Both are safe for the same reason: `callProvider`
   * writes a row for EVERY outcome, and the shortest of those TTLs (`FAILED_TTL_MS`, 10
   * minutes) outlives the whole schedule by orders of magnitude, so `outstanding()` stops
   * offering the provider long before the last re-read.
   */
  test("a FAILING provider is asked once across the client's whole re-read schedule", async () => {
    let calls = 0;
    const resolver = resolverFor(
      registryOf({
        id: "counted",
        facet: "ratings",
        run: async () => {
          calls++;
          throw new Error("upstream is having a day");
        },
      }),
    );

    await resolver.resolve(INCEPTION, { deadlineMs: 2_000 });
    // The three re-reads the backoff schedule makes, each after the previous settled.
    for (let i = 0; i < 3; i++) {
      resolver.warm(INCEPTION);
      await Bun.sleep(5);
    }
    expect(calls).toBe(1);
    expect(resolver.read(INCEPTION).ratings?.status).toBe("failed");
  });

  test("an EMPTY answer is asked once across the client's whole re-read schedule", async () => {
    let calls = 0;
    const resolver = resolverFor(
      registryOf({
        id: "counted",
        facet: "ratings",
        run: async () => {
          calls++;
          return null;
        },
      }),
    );

    await resolver.resolve(INCEPTION, { deadlineMs: 2_000 });
    for (let i = 0; i < 3; i++) {
      resolver.warm(INCEPTION);
      await Bun.sleep(5);
    }
    expect(calls).toBe(1);
    expect(resolver.read(INCEPTION).ratings?.status).toBe("empty");
  });

  /** Two views of one title while the first lookup is in flight must not ask twice. */
  test("concurrent resolves of the same title collapse into one provider call", async () => {
    let calls = 0;
    const resolver = resolverFor(
      registryOf({
        id: "counted",
        facet: "ratings",
        run: async () => {
          calls++;
          await Bun.sleep(30);
          return { data: [{ source: "counted", kind: "critics", value: 86, outOf: 100 }] } as never;
        },
      }),
    );

    await Promise.all([
      resolver.resolve(INCEPTION, { deadlineMs: 500 }),
      resolver.resolve(INCEPTION, { deadlineMs: 500 }),
    ]);
    expect(calls).toBe(1);
  });
});

describe("expiry", () => {
  test("an immutable facet is cached forever, a mutable one is not", async () => {
    const resolver = resolverFor(
      registryOf(
        { id: "p", facet: "cast", run: async () => ({ data: [{ name: "Leonardo DiCaprio" }] }) as never },
        { id: "p2", facet: "ratings", run: ratingProvider("p2") },
      ),
    );

    await resolver.resolve(INCEPTION, { deadlineMs: 2_000 });
    const rows = store.facetContributions("tt1375666");
    expect(rows.find((r) => r.facet === "cast")?.expires_at).toBeNull();
    expect(rows.find((r) => r.facet === "ratings")?.expires_at).not.toBeNull();
  });

  /**
   * "We looked and found nothing" is cached even on an immutable facet, but never
   * forever -- an empty answer is often just a provider that has not indexed the title.
   */
  test("an empty answer on an immutable facet still expires", async () => {
    const resolver = resolverFor(registryOf({ id: "p", facet: "cast", run: async () => null }));
    await resolver.resolve(INCEPTION, { deadlineMs: 2_000 });
    expect(store.facetContributions("tt1375666")[0]?.expires_at).not.toBeNull();
  });

  test("an expired contribution is not read, and is asked for again", async () => {
    let calls = 0;
    const registry = registryOf({
      id: "p",
      facet: "ratings",
      run: async () => {
        calls++;
        return { data: [{ source: "p", kind: "critics", value: 86, outOf: 100 }] } as never;
      },
    });

    // A clock the test moves, rather than a sleep the test waits out.
    let now = Date.now();
    const resolver = new FacetResolver({ store, registry, now: () => now });

    await resolver.resolve(INCEPTION, { deadlineMs: 2_000 });
    expect(calls).toBe(1);

    now += 365 * 24 * 60 * 60 * 1000;
    expect(resolver.read(INCEPTION).ratings?.status).toBe("pending");
    await resolver.resolve(INCEPTION, { deadlineMs: 2_000 });
    expect(calls).toBe(2);
  });

  /**
   * The provider's class is an input to the ladder, never the answer. Both shipped
   * providers claim `moving` for `ratings`; on a 2010 film that must still become 90 days.
   */
  test("the row records the class the ladder picked, not the one the provider claimed", async () => {
    const registry = registryOf({
      id: "p",
      facet: "ratings",
      run: async () =>
        ({ data: [{ source: "p", kind: "critics", value: 86, outOf: 100 }], freshness: "moving" }) as never,
    });
    const now = Date.parse("2026-06-15T00:00:00Z");
    const resolver = new FacetResolver({ store, registry, now: () => now });

    await resolver.resolve(INCEPTION, { deadlineMs: 2_000 });
    const row = store.facetContributions("tt1375666", new Date(now).toISOString())[0];
    expect(row?.freshness).toBe("settled");
    expect(Date.parse(row?.expires_at ?? "")).toBe(now + 90 * 24 * 60 * 60 * 1000);
  });

  /**
   * The one facet whose whole purpose is that it changes weekly. Classifying it by the
   * title's release year would cache next week's episode away for three months.
   */
  test("a continuing series' episodes stay on the short rung despite a 2011 title", async () => {
    const now = Date.parse("2026-06-15T00:00:00Z");
    const registry = registryOf({
      id: "p",
      facet: "episodes",
      run: async () =>
        ({
          data: [
            {
              season: 8,
              number: 1,
              title: "now",
              airDate: "2026-06-10",
              overview: null,
              image: null,
              runtime: 60,
            },
          ],
        }) as never,
    });
    const resolver = new FacetResolver({ store, registry, now: () => now });

    await resolver.resolve({ ...GOT, year: 2011 }, { deadlineMs: 2_000 });
    const row = store.facetContributions(GOT.tconst, new Date(now).toISOString())[0];
    expect(row?.freshness).toBe("moving");
    expect(Date.parse(row?.expires_at ?? "")).toBe(now + 12 * 60 * 60 * 1000);
  });
});

describe("pre-warming a shelf", () => {
  /** Two titles, one provider each, so "how many pauses" is unambiguous. */
  const SHELF: FacetEntity[] = [INCEPTION, { ...INCEPTION, tconst: "tt0133093", title: "The Matrix" }];

  function pacedResolver(registry: PluginRegistry, pauses: number[]) {
    return new FacetResolver({
      store,
      registry,
      sleep: async (ms) => {
        pauses.push(ms);
      },
    });
  }

  test("titles are fetched one at a time, with a pause between them", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const registry = registryOf({
      id: "p",
      facet: "ratings",
      run: async () => {
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        await Bun.sleep(5);
        inFlight--;
        return { data: [{ source: "p", kind: "critics", value: 86, outOf: 100 }] } as never;
      },
    });
    const pauses: number[] = [];

    const res = await pacedResolver(registry, pauses).prewarm(SHELF, { pauseMs: 40 });

    expect(res).toEqual({ fetched: 2, alreadyWarm: 0 });
    // A bounded queue, never a fan-out: the whole point of pacing a third party.
    expect(maxInFlight).toBe(1);
    expect(pauses).toEqual([40, 40]);
  });

  test("it waits for the answer, so the shelf is warm when it returns", async () => {
    const registry = registryOf({ id: "p", facet: "ratings", run: ratingProvider("p", 30) });
    const resolver = pacedResolver(registry, []);

    await resolver.prewarm(SHELF, { pauseMs: 0 });

    for (const entity of SHELF) {
      expect(resolver.read(entity).ratings?.status).toBe("ready");
      expect(resolver.isWarm(entity)).toBe(true);
    }
  });

  /** What makes the six-hourly re-run of a warm shelf effectively free. */
  test("a title that is already warm costs neither a call nor a pause", async () => {
    let calls = 0;
    const registry = registryOf({
      id: "p",
      facet: "ratings",
      run: async () => {
        calls++;
        return { data: [{ source: "p", kind: "critics", value: 86, outOf: 100 }] } as never;
      },
    });
    const pauses: number[] = [];
    const resolver = pacedResolver(registry, pauses);

    await resolver.prewarm(SHELF, { pauseMs: 40 });
    const second = await resolver.prewarm(SHELF, { pauseMs: 40 });

    expect(calls).toBe(2);
    expect(second).toEqual({ fetched: 0, alreadyWarm: 2 });
    expect(pauses).toHaveLength(2);
  });

  /** A health check that warmed the cache would only ever be reporting on itself. */
  test("isWarm asks no provider", async () => {
    let calls = 0;
    const registry = registryOf({
      id: "p",
      facet: "ratings",
      run: async () => {
        calls++;
        return null;
      },
    });
    const resolver = resolverFor(registry);

    expect(resolver.isWarm(INCEPTION)).toBe(false);
    await Bun.sleep(10);
    expect(calls).toBe(0);
  });
});

describe("cache invalidation", () => {
  /**
   * A corrected API key must actually take effect, which is why the key carries it.
   *
   * What changed on 2026-09-01 is only WHAT IS DRAWN WHILE THAT HAPPENS. A superseded row
   * used to be invisible, so an upgrade meant a page of skeletons and a burst of re-fetches
   * against third parties -- measured at the live deployment as 5,379 cached rows dropping
   * to 3,495 at one restart. It now renders its last known value while its provider is
   * asked again, and the correction still lands on this same view.
   */
  test("a superseded contribution is DRAWN while its provider is asked again", async () => {
    const registry = registryOf({ id: "p", facet: "ratings", run: ratingProvider("p") });
    store.putFacetContribution({
      reason: null,
      entity_id: INCEPTION.tconst,
      facet: "ratings",
      plugin_id: "p",
      config_version: "stale",
      outcome: "ok",
      data: JSON.stringify([{ source: "stale", kind: "critics", value: 1, outOf: 100 }]),
      freshness: "settled",
      resolved_at: new Date().toISOString(),
      expires_at: null,
    });

    const resolver = resolverFor(registry);

    // Drawn, at the old value, rather than held back as a skeleton.
    const before = resolver.read(INCEPTION);
    expect(before.ratings?.status).toBe("ready");
    expect(before.ratings?.data).toEqual([{ source: "stale", kind: "critics", value: 1, outOf: 100 }]);

    // And the provider is STILL owed an answer, which is what makes this a fallback rather
    // than a stale cache: the page polls while `working` is above zero.
    expect(resolver.isWarm(INCEPTION)).toBe(false);
    expect(resolver.workState(INCEPTION).working).toBe(1);

    // The correction lands on this view, not after the facet's own TTL -- which for a
    // `settled` rating is 90 days, and was the failure the version key was added for.
    const facets = await resolver.resolve(INCEPTION, { deadlineMs: 2_000 });
    expect(facets.ratings?.data).toEqual([{ source: "p", kind: "critics", value: 86, outOf: 100 }]);
  });

  test("a row whose PLUGIN is gone is not drawn -- that rule does not soften", async () => {
    // An uninstalled addon's facts must leave the page. Nobody will ever answer for them
    // again, so there is nothing to fall back to and no correction coming.
    const registry = registryOf({ id: "p", facet: "ratings", run: ratingProvider("p") });
    store.putFacetContribution({
      reason: null,
      entity_id: INCEPTION.tconst,
      facet: "ratings",
      plugin_id: "uninstalled",
      config_version: "whatever",
      outcome: "ok",
      data: JSON.stringify([{ source: "ghost", kind: "critics", value: 1, outOf: 100 }]),
      freshness: "settled",
      resolved_at: new Date().toISOString(),
      expires_at: null,
    });

    const facets = await resolverFor(registry).resolve(INCEPTION, { deadlineMs: 2_000 });
    expect(facets.ratings?.data).toEqual([{ source: "p", kind: "critics", value: 86, outOf: 100 }]);
  });
});

describe("the deadline is a cancellation, not a discard", () => {
  /**
   * The defect `withTimeout` carried: it stopped waiting while the provider ran on, so the
   * socket stayed open and the answer was thrown away. The signal is how a provider learns
   * the host has stopped caring.
   */
  test("a hung provider is CANCELLED at the hard cap, and told so through its signal", async () => {
    let abortedWhileRunning = false;
    const resolver = resolverFor(
      registryOf({
        id: "hung",
        facet: "ratings",
        run: (_entity, signal) =>
          new Promise((resolve) => {
            signal?.addEventListener("abort", () => {
              abortedWhileRunning = true;
              // A real provider hands this to `c.fetch`; here it is the whole point.
              resolve(null);
            });
            // Never settles on its own -- exactly the shape `withTimeout` used to abandon.
            setTimeout(() => resolve(null), 60_000).unref?.();
          }),
      }),
      { hardTimeoutMs: 40 },
    );

    await resolver.resolve(INCEPTION, { deadlineMs: 300 });

    expect(abortedWhileRunning).toBe(true);
    expect(resolver.read(INCEPTION).ratings?.status).toBe("failed");
  });

  /**
   * A plugin is free to catch its own cancellation and return normally, and if its resolve
   * beats cockatiel's rejection we hold a value from a call we had already abandoned.
   * Usually that value is `null`, which would otherwise be cached as `empty` -- a
   * permanent-ish "there is nothing here" about a title we never got an answer for.
   */
  test("an answer arriving from a call we already cancelled is dropped, not cached as empty", async () => {
    const resolver = resolverFor(
      registryOf({
        id: "swallower",
        facet: "ratings",
        run: (_entity, signal) =>
          new Promise((resolve) => {
            signal?.addEventListener("abort", () => resolve(null)); // swallows it
            setTimeout(() => resolve(null), 60_000).unref?.();
          }),
      }),
      { hardTimeoutMs: 40 },
    );

    await resolver.resolve(INCEPTION, { deadlineMs: 300 });

    // NOT `empty`: we never learned anything, and a 10-minute failed TTL is the honest cost.
    expect(resolver.read(INCEPTION).ratings?.status).toBe("failed");
    expect(logs.some((l) => l.includes("answered AFTER being cancelled"))).toBe(true);
  });

  /**
   * > [!CAUTION] The signal aborts on SUCCESS too, not only on the deadline
   * > cockatiel disposes the controller when the call settles either way, so
   * > `signal.aborted` after your own work has finished says nothing about whether you were
   * > cancelled. Measured, because the obvious reading is the wrong one. A provider must
   * > only ever react to `abort` while it is still working -- passing the signal to
   * > `c.fetch` is safe (the request is done), but latching a boolean off it and checking
   * > that boolean afterwards reports "cancelled" for every successful call.
   */
  test("the signal also aborts after a SUCCESSFUL call, so it cannot be read as a verdict", async () => {
    let abortedAfterSuccess = false;
    const resolver = resolverFor(
      registryOf({
        id: "quick",
        facet: "ratings",
        run: async (_entity, signal) => {
          signal?.addEventListener("abort", () => {
            abortedAfterSuccess = true;
          });
          return { data: [{ source: "quick", kind: "critics", value: 1, outOf: 100 }] } as never;
        },
      }),
    );

    await resolver.resolve(INCEPTION, { deadlineMs: 300 });

    expect(resolver.read(INCEPTION).ratings?.status).toBe("ready");
    expect(abortedAfterSuccess).toBe(true);
  });

  test("a provider ignoring the signal still type-checks and still resolves", async () => {
    const resolver = resolverFor(registryOf({ id: "old", facet: "ratings", run: ratingProvider("old") }));
    await resolver.resolve(INCEPTION, { deadlineMs: 500 });
    expect(resolver.read(INCEPTION).ratings?.status).toBe("ready");
  });
});

describe("naming the plugin that failed, and why", () => {
  test("a thrown provider is attributed by plugin id with reason 'error'", async () => {
    const resolver = resolverFor(
      registryOf({
        id: "rotten-tomatoes",
        facet: "ratings",
        run: async () => {
          throw new Error("algolia said 503");
        },
      }),
    );

    await resolver.resolve(INCEPTION, { deadlineMs: 500 });

    expect(resolver.workState(INCEPTION).problems).toEqual([
      { pluginId: "rotten-tomatoes", facet: "ratings", reason: "error" },
    ]);
  });

  test("a provider cancelled at the deadline is attributed as 'timeout', not 'error'", async () => {
    const resolver = resolverFor(
      registryOf({
        id: "hung",
        facet: "ratings",
        run: (_e, signal) =>
          new Promise((resolve) => {
            signal?.addEventListener("abort", () => resolve(null));
            setTimeout(() => resolve(null), 60_000).unref?.();
          }),
      }),
      { hardTimeoutMs: 40 },
    );

    await resolver.resolve(INCEPTION, { deadlineMs: 300 });

    expect(resolver.workState(INCEPTION).problems).toEqual([
      { pluginId: "hung", facet: "ratings", reason: "timeout" },
    ]);
  });

  test("a contribution of the wrong shape is 'invalid-shape' -- our contract, not their outage", async () => {
    const resolver = resolverFor(
      registryOf({ id: "garbage", facet: "ratings", run: async () => "86%" as never }),
    );

    await resolver.resolve(INCEPTION, { deadlineMs: 500 });

    expect(resolver.workState(INCEPTION).problems).toEqual([
      { pluginId: "garbage", facet: "ratings", reason: "invalid-shape" },
    ]);
  });

  /**
   * The reason code exists so a page can say "which addon" without quoting an exception at
   * a stranger. An upstream URL can carry a credential in its query string -- `safeUrl` is
   * in the tree precisely for that -- so the message stays in the log and only the log.
   */
  test("the raw error message never reaches the reported problem", async () => {
    const resolver = resolverFor(
      registryOf({
        id: "leaky",
        facet: "ratings",
        run: async () => {
          throw new Error("https://api.example.com/x?api_key=SECRET answered 500");
        },
      }),
    );

    await resolver.resolve(INCEPTION, { deadlineMs: 500 });

    expect(JSON.stringify(resolver.workState(INCEPTION).problems)).not.toContain("SECRET");
    // ...and the operator can still find it, because the log has the whole thing.
    expect(logs.some((l) => l.includes("SECRET"))).toBe(true);
  });

  test("workState reports who is still working, and asks nobody", async () => {
    let calls = 0;
    const resolver = resolverFor(
      registryOf({
        id: "slow",
        facet: "ratings",
        run: async () => {
          calls++;
          await Bun.sleep(60);
          return { data: [{ source: "slow", kind: "critics", value: 1, outOf: 100 }] } as never;
        },
      }),
    );

    // Before anything is asked: one provider owes an answer, and asking did not start it.
    expect(resolver.workState(INCEPTION)).toMatchObject({ working: 1, facets: ["ratings"] });
    expect(calls).toBe(0);

    await resolver.resolve(INCEPTION, { deadlineMs: 300 });
    expect(resolver.workState(INCEPTION)).toMatchObject({ working: 0, facets: [], problems: [] });
  });
});

/**
 * Which plugin is slow was, until this landed, a question you answered by writing a
 * throwaway harness. Twice.
 */
describe("timing report", () => {
  test("names the pluginId|facet pair and records what the call took", async () => {
    const resolver = resolverFor(
      registryOf({ id: "slowly", facet: "ratings", run: ratingProvider("x", 40) }),
    );
    await resolver.resolve(INCEPTION, { deadlineMs: 500 });

    const report = resolver.timingReport();
    expect(Object.keys(report)).toEqual(["slowly|ratings"]);
    expect(report["slowly|ratings"]?.n).toBe(1);
    expect(report["slowly|ratings"]?.maxMs).toBeGreaterThanOrEqual(35);
  });

  test("a provider slower than the threshold is named in the log", async () => {
    // The threshold is injected via the clock rather than by actually waiting three
    // seconds: `callProvider` measures with `this.now`, so a fake one proves the branch.
    let now = 0;
    const resolver = new FacetResolver({
      store,
      registry: registryOf({
        id: "glacial",
        facet: "ratings",
        run: async () => {
          now += SLOW_PROVIDER_MS + 1;
          return { data: [{ source: "x", kind: "critics", value: 1, outOf: 100 }] } as never;
        },
      }),
      log: (m) => logs.push(m),
      now: () => now,
    });

    await resolver.resolve(INCEPTION, { deadlineMs: 50 });
    expect(logs.some((l) => l.includes("glacial") && l.includes("took"))).toBe(true);
  });

  test("a gate refusal is NOT counted, because we never asked", async () => {
    // A refusal returns in about no time; counting it would drag the provider's own
    // distribution down and make a slow plugin read as a fast one.
    const resolver = resolverFor(
      registryOf({
        id: "refused",
        facet: "ratings",
        run: () => Promise.reject(new BulkheadRejectedError(1, 0)),
      }),
    );

    await resolver.resolve(INCEPTION, { deadlineMs: 200 });
    expect(resolver.refusedCount()).toBe(1);
    expect(resolver.timingReport()).toEqual({});
  });
});
