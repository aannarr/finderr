import { describe, expect, test } from "bun:test";
import { type HealthDeps, healthPayload, warmHealth } from "./health";
import type { WarmStatus } from "./live-index";

/**
 * Guards the fix for the 2026-08-31 regression where `/api/health` took 1.9 seconds --
 * 400x a search -- because it rebuilt every discovery shelf on every call. Docker's
 * HEALTHCHECK polls this every 30 seconds, so the liveness probe alone burned ~6% of a
 * core forever.
 *
 * The invariant is not "coverage is absent from the response". It is "the expensive
 * function was NEVER CALLED". Asserting on the output would still pass if someone
 * computed coverage and then discarded it, which is the exact bug being guarded.
 */

function deps(onCoverage: () => void): HealthDeps {
  return {
    index: {
      rows: 1_275_341,
      builtAt: "2026-08-30T06:26:27.095Z",
      reload: null,
      origin: { available: true, configured: ["en", "sv"] },
      // The healthy shape: the prefault ran and the budget held nearly all of it. A
      // `residentMb` far below `readMb` here is the deployment that looks fine and is
      // serving half its index off the disk.
      warm: {
        state: "done",
        ok: true,
        last: { readMb: 1868, ms: 10_520, residentMb: 1851 },
        tuning: {
          budgetMb: 3072,
          budgetSource: "cgroup-v1",
          mmapMb: 1868,
          cacheMb: 154,
          prefault: true,
        },
      },
    },
    library: { radarr: 1371, sonarr: 596, episodes: 24_812 },
    plex: { items: 1730, machineId: "0123456789abcdef0123456789abcdef01234567" },
    upcoming: { radarr: 42, sonarr: 27, tmdbMovie: 19, tmdbSeries: 16 },
    trending: 18,
    awards: [
      {
        award: "oscars",
        rows: 12_137,
        sha: "c5e9716b7e020e70205d6b95f5a5678526c1b45f",
        importedAt: "2026-09-01T00:00:00.000Z",
      },
      // A Wikidata award beside it: no commit to name, which is the ordinary state for a
      // source with no revision rather than the failure `sha: null` means for `oscar_data`.
      { award: "palme-dor", rows: 83, sha: null, importedAt: "2026-09-01T00:00:00.000Z" },
    ],
    services: { radarr: true, sonarr: true, prowlarr: false },
    auth: { users: 3, admins: 1, sessions: 4, apiKey: true, noAuth: false },
    watchlist: { rows: 37, readers: 3 },
    push: { enabled: true, devices: 2 },
    webhook: { enabled: true, received: 14, applied: 9, refused: 0 },
    queue: { pending: 0 },
    artwork: { resolved: 2192 },
    shelves: { enabled: false, ready: false, tiers: { index: null, tmdb: null, arr: null }, rows: 0 },
    // A plugin WITH declared hosts and one with none. An addon that fetches nothing is the
    // ordinary case for anything reading only our own database, and `[]` is what says so.
    plugins: [
      { id: "servarr-metadata", hosts: ["api.radarr.video", "skyhook.sonarr.tv"] },
      { id: "rotten-tomatoes", hosts: [] },
    ],
    facetRows: 4321,
    facetImages: 87,
    facetRowsPruned: 12,
    searchLog: {
      enabled: true,
      pending: 3,
      searches: 118,
      clicks: 41,
      dropped: 0,
      stored: { searches: 4_902, clicks: 1_180 },
    },
    timings: {
      providers: { "servarr-metadata|cast": { n: 9, totalMs: 3100, maxMs: 800, p50Ms: 330, p95Ms: 780 } },
      outbound: {
        "api.themoviedb.org": {
          host: { n: 9, totalMs: 2900, maxMs: 700, p50Ms: 310, p95Ms: 690 },
          waitGateMs: 0,
          waitPaceMs: 1250,
        },
      },
      requests: { "GET /api/browse": { n: 4, totalMs: 6100, maxMs: 3657, p50Ms: 900, p95Ms: 3657 } },
      slow: [{ at: 1_700_000_000_000, label: "GET /api/browse", ms: 3657, detail: "?genre=Comedy" }],
    },
    runtime: {
      uptimeSeconds: 62,
      rss: 168_394_752,
      heapUsed: 7_316_867,
      cgroup: {
        current: 433_336_320,
        limit: 1_572_864_000,
        ratio: 0.2755,
        anon: 125_095_936,
        file: 307_867_648,
        atLimit: 0,
      },
      cpuSeconds: 8,
      gcSeconds: 0,
      peak: { job: "arr-library", rssMb: 231, heapMb: 42, at: "2026-09-07T03:00:00.000Z", ms: 3759 },
      fuzzy: "vocab 257,540 words (disk)",
    },
    coverage: () => {
      onCoverage();
      return [{ shelf: "recently-added", titles: 24, warm: 24 }];
    },
    load: () => ({
      windowSeconds: 60,
      busyMs: 1234,
      saturation: 0.02,
      contended: false,
      callers: [{ key: "user-1", ms: 1234, share: 1 }],
      tracked: 1,
      refusals: [],
      slowed: [],
    }),
  };
}

/**
 * Where every `HealthDeps` key must land in the detailed payload, as a dotted path.
 *
 * This table exists because `push` was declared, documented at length and collected on
 * every probe for weeks without ever being RETURNED. `healthPayload` spells its response
 * out field by field, so a field is dropped by the return literal saying nothing about it
 * -- and no assertion about the fields that ARE there can see that kind of hole.
 *
 * Two halves, and both are needed. `Record<keyof HealthDeps, ...>` makes adding a dep key
 * a TYPE error until somebody states where it goes; the walk below proves the value
 * actually arrives at the path claimed here. `null` means "deliberately not in the
 * payload" -- `coverage` is the opt-in thunk this whole file exists to keep unread.
 */
const LANDS_AT: Record<keyof HealthDeps, string | null> = {
  index: "index",
  library: "library",
  plex: "plex",
  upcoming: "upcoming",
  trending: "trending",
  awards: "awards",
  services: "services",
  auth: "auth",
  watchlist: "watchlist",
  push: "push",
  webhook: "webhook",
  queue: "queue",
  artwork: "artwork",
  shelves: "shelves",
  searchLog: "searchLog",
  timings: "timings",
  load: "load",
  runtime: "runtime",
  plugins: "plugins.loaded",
  facetRows: "facets.rows",
  facetImages: "facets.images",
  facetRowsPruned: "facets.pruned",
  coverage: null,
};

function valueAt(payload: Record<string, unknown>, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((held, key) => (held as Record<string, unknown> | undefined)?.[key], payload);
}

describe("healthPayload", () => {
  test("returns every dep it collects -- nothing is dropped by omission", () => {
    const d = deps(() => {});
    const out = healthPayload(d, { coverage: false, detailed: true });

    for (const [key, path] of Object.entries(LANDS_AT) as [keyof HealthDeps, string | null][]) {
      if (path === null) continue;
      // A dep declared as a THUNK lands as its RESULT, never as the function -- `load` is
      // one, because it snapshots a rolling window and must be read at call time rather
      // than when this object was built. Comparing the function itself would fail for
      // every such dep and would say nothing about whether the value arrived.
      const dep = d[key];
      const expected = typeof dep === "function" ? (dep as () => unknown)() : dep;
      // Keyed rather than bare, so a failure names the field that went missing instead of
      // printing two anonymous values.
      expect({ [key]: valueAt(out, path) }).toEqual({ [key]: expected });
    }
  });

  test("does NOT run the shelf queries unless coverage is asked for", () => {
    let calls = 0;
    const out = healthPayload(
      deps(() => calls++),
      { coverage: false, detailed: true },
    );

    // The whole point: the expensive thunk was never invoked.
    expect(calls).toBe(0);
    expect((out.facets as Record<string, unknown>).coverage).toBeUndefined();
  });

  test("runs them exactly once when asked", () => {
    let calls = 0;
    const out = healthPayload(
      deps(() => calls++),
      { coverage: true, detailed: true },
    );

    expect(calls).toBe(1);
    expect((out.facets as Record<string, unknown>).coverage).toEqual([
      { shelf: "recently-added", titles: 24, warm: 24 },
    ]);
  });

  test("still reports the cheap fields either way", () => {
    for (const coverage of [false, true]) {
      const out = healthPayload(
        deps(() => {}),
        { coverage, detailed: true },
      );
      expect(out.ok).toBe(true);
      expect(out.index).toEqual({
        rows: 1_275_341,
        builtAt: "2026-08-30T06:26:27.095Z",
        reload: null,
        // Cheap enough for the anonymous-detail path: two fields off the open engine and
        // the config, no query. `available: false` beside a non-empty `configured` is the
        // one combination worth alerting on -- an operator's filter silently not applied.
        origin: { available: true, configured: ["en", "sv"] },
        warm: {
          state: "done",
          ok: true,
          last: { readMb: 1868, ms: 10_520, residentMb: 1851 },
          tuning: {
            budgetMb: 3072,
            budgetSource: "cgroup-v1",
            mmapMb: 1868,
            cacheMb: 154,
            prefault: true,
          },
        },
      });
      expect(out.library).toEqual({ radarr: 1371, sonarr: 596, episodes: 24_812 });
      // Counts, not probes -- these are always safe to serve on a 30s poll.
      expect((out.facets as Record<string, unknown>).rows).toBe(4321);
      expect((out.facets as Record<string, unknown>).images).toBe(87);
    }
  });

  test("carries the cgroup ceiling beside the usage, not usage alone", () => {
    const out = healthPayload(
      deps(() => {}),
      { coverage: false, detailed: true },
    );
    // A byte count with no ceiling cannot be triaged; that omission is what made the
    // original 94%-of-limit diagnosis a manual dig through /sys/fs/cgroup.
    const rt = out.runtime as HealthRuntimeShape;
    expect(rt.cgroup?.limit).toBe(1_572_864_000);
    expect(rt.cgroup?.ratio).toBeCloseTo(0.2755, 3);
    expect(rt.cgroup?.atLimit).toBe(0);
    expect(rt.gcSeconds).toBe(0);
  });

  /*
    finderr went public on 2026-08-31 and `/api/health` is on the public path
    list because Docker's probe needs it. An anonymous caller was therefore being handed
    plex.machineId -- a stable identifier for somebody's Plex server -- plus the size of
    their library and live rss/cpu figures that say whether an attack is landing.
  */
  test("an anonymous caller gets liveness and NOTHING else", () => {
    const out = healthPayload(
      deps(() => {}),
      { coverage: false, detailed: false },
    );

    expect(out).toEqual({ ok: true });
    // Named individually rather than by key count, so adding a field to the detailed
    // payload cannot quietly start leaking it.
    for (const k of [
      "plex",
      "library",
      "index",
      "runtime",
      "auth",
      "push",
      "services",
      "plugins",
      "facets",
      "timings",
    ])
      expect(out[k]).toBeUndefined();
  });

  /*
    `timings.slow` carries the QUERY STRING of every slow request, which is our own
    vocabulary and exactly what makes the entry worth keeping -- and it is also the closest
    this payload comes to describing what real people asked for. It is detailed-only for the
    same reason plex.machineId is.
  */
  test("timings sit at the top level and carry all four halves", () => {
    const out = healthPayload(
      deps(() => {}),
      { coverage: false, detailed: true },
    );

    const timings = out.timings as Record<string, unknown>;
    expect(Object.keys(timings).sort()).toEqual(["outbound", "providers", "requests", "slow"]);
    // It used to live under `facets.timing`, which was wrong the moment a route's latency
    // joined it -- a route is not a fact about the facet cache.
    expect((out.facets as Record<string, unknown>).timing).toBeUndefined();
  });

  /*
    An addon can now hold a CREDENTIAL -- `meta.config` with a `type: "secret"` field -- and
    this endpoint lists every addon that is loaded. It is also on the public path list, so a
    field added to a plugin entry here is a field a probe on the internet can ask about.

    Asserted as an exact key set rather than "does not contain the key I thought of", because
    the failure this guards against is somebody widening the entry later for a good reason
    and taking the whole declaration along with it.
  */
  test("a plugin entry says what is loaded and where it reaches, and nothing about its config", () => {
    const out = healthPayload(
      deps(() => {}),
      { coverage: false, detailed: true },
    );

    const loaded = (out.plugins as { loaded: Record<string, unknown>[] }).loaded;
    for (const entry of loaded) expect(Object.keys(entry).sort()).toEqual(["hosts", "id"]);
  });

  /*
    The cheaper hole the same guard closes. `?coverage=1` costs ~1.9s of shelf queries --
    400x a search -- so an anonymous caller could ask for it in a loop. The early return
    has to happen BEFORE the thunk is read, which is what this asserts.
  */
  test("an anonymous caller cannot trigger the expensive coverage query", () => {
    let calls = 0;
    const out = healthPayload(
      deps(() => calls++),
      { coverage: true, detailed: false },
    );

    expect(calls).toBe(0);
    expect(out).toEqual({ ok: true });
  });
});

/**
 * The narrowing between the holder and the wire.
 *
 * Two things have to survive it and one has to be stopped. `state` and `ok` are the whole
 * point of the field -- a monitor keys on `ok` and never has to reason across three others --
 * and `notes` is prose written for an operator reading a boot log, which is not something this
 * endpoint hands out. The same rule `work.problems` follows for provider errors.
 */
describe("the warm report leaving the process", () => {
  const status = (over: Partial<WarmStatus> = {}): WarmStatus => ({
    state: "done",
    ok: true,
    last: { readMb: 1868, ms: 10_520, residentMb: 1851 },
    tuning: {
      budgetMb: 3072,
      budgetSource: "cgroup-v1",
      mmapBytes: 1868 * 1024 * 1024,
      cacheKib: 154 * 1024,
      prefault: true,
      notes: ["memory budget 3072 MB (cgroup-v1); index 1868 MB"],
    },
    ...over,
  });

  test("carries the state and the probe field through unchanged", () => {
    const out = warmHealth(status({ state: "partial", ok: false }));
    expect(out.state).toBe("partial");
    expect(out.ok).toBe(false);
  });

  test("converts the pragma units, so the page does not do arithmetic", () => {
    const out = warmHealth(status());
    expect(out.tuning).toEqual({
      budgetMb: 3072,
      budgetSource: "cgroup-v1",
      mmapMb: 1868,
      cacheMb: 154,
      prefault: true,
    });
  });

  test("the operator prose does NOT travel", () => {
    expect(warmHealth(status()).tuning).not.toHaveProperty("notes");
  });

  test("no engine open leaves tuning null rather than inventing zeroes", () => {
    expect(warmHealth(status({ state: "pending", last: null, tuning: null })).tuning).toBeNull();
  });
});

type HealthRuntimeShape = {
  cgroup: { limit: number | null; ratio: number | null; atLimit: number | null } | null;
  gcSeconds: number | null;
};

/**
 * `facets.pruned` is a REPORT of a sweep that already happened at boot, never a sweep.
 *
 * This is the same rule `coverage` is guarded by one file over ("asking a question must not
 * do the work"), and the prune is a far worse thing to get wrong than a shelf query: it
 * DELETES. A health probe that pruned would run every 30 seconds under Docker's HEALTHCHECK,
 * and any bug in the liveness rule would eat the cache 2,880 times a day instead of once a
 * boot. `HealthDeps` therefore takes a NUMBER, not a function -- the type makes the mistake
 * unavailable rather than merely discouraged, which is why there is nothing here to spy on.
 */
describe("the prune count", () => {
  test("is reported as a plain number, so the payload cannot trigger a sweep", () => {
    const d = deps(() => {});
    expect(typeof d.facetRowsPruned).toBe("number");

    const out = healthPayload(d, { coverage: false, detailed: true });
    expect((out.facets as Record<string, unknown>).pruned).toBe(12);
  });

  test("survives being zero -- a boot that found nothing still says so", () => {
    // Absent and zero are different facts. Zero means the sweep ran and the cache was
    // already clean; absent would mean nobody swept, which is a different bug.
    const out = healthPayload({ ...deps(() => {}), facetRowsPruned: 0 }, { coverage: false, detailed: true });
    expect((out.facets as Record<string, unknown>).pruned).toBe(0);
  });
});
