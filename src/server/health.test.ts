import { describe, expect, test } from "bun:test";
import { type HealthDeps, healthPayload } from "./health";

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
    index: { rows: 1_275_341, builtAt: "2026-08-30T06:26:27.095Z", reload: null },
    library: { radarr: 1371, sonarr: 596, episodes: 24_812 },
    plex: { items: 1730, machineId: "0123456789abcdef0123456789abcdef01234567" },
    upcoming: { radarr: 42, sonarr: 27, tmdbMovie: 19, tmdbSeries: 16 },
    services: { radarr: true, sonarr: true },
    auth: { users: 3, admins: 1, sessions: 4, apiKey: true },
    queue: { pending: 0 },
    artwork: { resolved: 2192 },
    plugins: ["servarr-metadata", "rotten-tomatoes"],
    facetRows: 4321,
    facetImages: 87,
    facetRowsPruned: 12,
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
      fuzzy: "vocab 257,540 words (disk)",
    },
    coverage: () => {
      onCoverage();
      return [{ shelf: "recently-added", titles: 24, warm: 24 }];
    },
  };
}

describe("healthPayload", () => {
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
    for (const k of ["plex", "library", "index", "runtime", "auth", "services", "plugins", "facets"])
      expect(out[k]).toBeUndefined();
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
