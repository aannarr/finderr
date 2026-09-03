/**
 * The client cache, tested at the seam that back-navigation actually crosses.
 *
 * `api.ts` opens by promising that "a repeated query, a back navigation, retyping a
 * character you just deleted -- none of these should produce a network request." Search
 * kept that promise and the other two views never did: `dedupe()` collapses requests that
 * are IN FLIGHT and then drops the entry in `.finally()`, so it is a stampede guard, not
 * a cache. Two sequential calls paid twice.
 *
 * These tests pin the distinction, because it is invisible from the outside until you
 * count fetches: the concurrent case and the sequential case must BOTH cost one call, and
 * they are served by two different mechanisms.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  browse,
  cachedBrowse,
  cachedBrowseRun,
  cachedDiscover,
  getDiscover,
  getTitleDetail,
  postRequest,
  postSeasonRequest,
  prefetchTitle,
  resetCaches,
} from "./api";

const realFetch = globalThis.fetch;

/** Every call recorded, so an assertion counts requests rather than trusting a shape. */
let calls: string[] = [];

function stubFetch(body: unknown = { shelves: [], rows: [], total: 0 }) {
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    return { ok: true, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  calls = [];
  resetCaches();
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("getDiscover", () => {
  test("a second call is served from cache -- this is the Back-to-home path", async () => {
    await getDiscover();
    await getDiscover();
    expect(calls).toEqual(["/api/discover"]);
  });

  test("concurrent callers still share one request", async () => {
    await Promise.all([getDiscover(), getDiscover(), getDiscover()]);
    expect(calls).toEqual(["/api/discover"]);
  });

  test("cachedDiscover is the synchronous read a remounting route needs", async () => {
    // Undefined before anything has landed: the route must fall through to a fetch
    // rather than render a permanently empty page.
    expect(cachedDiscover()).toBeUndefined();
    const fetched = await getDiscover();
    expect(cachedDiscover()).toEqual(fetched);
  });

  /**
   * THE SHELF NAMED AFTER HAVING ASKED.
   *
   * `POST /api/requests` rebuilds the arr tier on the server for exactly this reason. Before
   * this, the asker's own browser was the one client guaranteed not to see the result: it had
   * fetched the front page once and would not fetch it again for the rest of the session.
   */
  test("requesting a title makes the next front page a fetch, not a cache hit", async () => {
    await getDiscover();
    await postRequest("tt1375666");
    await getDiscover();
    expect(calls).toEqual(["/api/discover", "/api/requests", "/api/discover"]);
  });

  test("the held page still PAINTS while it waits to be asked about again", async () => {
    const fetched = await getDiscover();
    await postRequest("tt1375666");
    // Dropping the entry would refetch too, and would cost the reader a blank front page
    // for the length of that request on the way Back from the title they just asked for.
    expect(cachedDiscover()).toEqual(fetched);
  });

  test("a failed request is not invalidation -- nothing changed, so nothing is stale", async () => {
    await getDiscover();
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      return { ok: false, status: 403, json: async () => ({ error: "over quota" }) } as unknown as Response;
    }) as unknown as typeof fetch;
    await expect(postRequest("tt1375666")).rejects.toThrow("over quota");

    stubFetch();
    await getDiscover();
    expect(calls).toEqual(["/api/discover", "/api/requests"]);
  });

  test("a failed request is not cached, so a retry can still succeed", async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
    await expect(getDiscover()).rejects.toThrow();
    expect(cachedDiscover()).toBeUndefined();

    stubFetch();
    await getDiscover();
    expect(calls).toEqual(["/api/discover"]);
  });
});

describe("browse", () => {
  test("returning to the same filter costs nothing -- the Back-to-/browse path", async () => {
    await browse({ genre: "Horror", decade: 1980 });
    await browse({ genre: "Horror", decade: 1980 });
    expect(calls.length).toBe(1);
  });

  test("a different page is a different entry, not a cache hit", async () => {
    await browse({ genre: "Horror" }, { offset: 0, limit: 60 });
    await browse({ genre: "Horror" }, { offset: 60, limit: 60 });
    expect(calls.length).toBe(2);
  });

  test("minVotes is part of the key -- lifting the floor must not read the floored rows", async () => {
    // The escape hatch re-runs the SAME filter with the floor dropped. If the key
    // ignored minVotes, "Show all 1,132" would hand back the empty floored response.
    await browse({ year: 1901 });
    await browse({ year: 1901 }, { minVotes: 0 });
    expect(calls.length).toBe(2);
  });

  test("cachedBrowse mirrors the key browse() actually used", async () => {
    const filters = { genre: "Horror", decade: 1980 };
    const opts = { offset: 0, limit: 60 };
    expect(cachedBrowse(filters, opts)).toBeUndefined();
    const fetched = await browse(filters, opts);
    expect(cachedBrowse(filters, opts)).toEqual(fetched);
    // A filter we never asked for stays a miss.
    expect(cachedBrowse({ genre: "Comedy" }, opts)).toBeUndefined();
  });

  test("filter key is order-independent -- same filter, one request", async () => {
    // The routes build this object from URL params, and property order is not a
    // guarantee anybody should have to think about.
    await browse({ genre: "Horror", decade: 1980 });
    await browse({ decade: 1980, genre: "Horror" });
    expect(calls.length).toBe(1);
  });
});

describe("prefetchTitle", () => {
  const detail = {
    tconst: "tt1",
    title: "X",
    facets: { cast: { status: "ready", data: [{ name: "A" }] } },
  };

  function detailFetch() {
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      return { ok: true, json: async () => detail } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  test("warms a title we do not hold", async () => {
    detailFetch();
    prefetchTitle("tt1");
    await Bun.sleep(0);
    expect(calls).toEqual(["/api/title/tt1"]);
  });

  test("does nothing once the title is fully resolved", async () => {
    detailFetch();
    await getTitleDetail("tt1");
    calls = [];
    prefetchTitle("tt1");
    await Bun.sleep(0);
    // getTitleDetail would go to the network anyway to re-kick the resolver -- correct
    // on a real navigation, pure waste on a hover.
    expect(calls).toEqual([]);
  });

  test("dragging across a grid costs one request per card, not one per event", async () => {
    detailFetch();
    prefetchTitle("tt1");
    prefetchTitle("tt1");
    prefetchTitle("tt1");
    await Bun.sleep(0);
    expect(calls).toEqual(["/api/title/tt1"]);
  });

  test("a failed prefetch is swallowed -- moving the mouse must not raise an error", async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    expect(() => prefetchTitle("tt-boom")).not.toThrow();
    await Bun.sleep(0);
  });
});

describe("cachedBrowseRun", () => {
  const filters = { genre: "Horror" };

  /** Pages of distinct rows, so concatenation order is observable. */
  function pagedFetch(pages: string[][]) {
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      const offset = Number(new URL(String(url), "http://x").searchParams.get("offset") ?? 0);
      const rows = (pages[offset / 2] ?? []).map((tconst) => ({ tconst }));
      return { ok: true, json: async () => ({ rows, total: 6 }) } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  test("a miss is undefined, so the route falls through to a fetch", () => {
    expect(cachedBrowseRun(filters, { limit: 2 })).toBeUndefined();
  });

  test("rebuilds every page the user had paged through, in order", async () => {
    pagedFetch([
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
    ]);
    await browse(filters, { limit: 2, offset: 0 });
    await browse(filters, { limit: 2, offset: 2 });
    await browse(filters, { limit: 2, offset: 4 });

    const run = cachedBrowseRun(filters, { limit: 2 });
    expect(run?.rows.map((r) => r.tconst)).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(run?.total).toBe(6);
  });

  test("stops at the first gap rather than splicing pages out of order", async () => {
    pagedFetch([
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
    ]);
    // Page 2 was never fetched -- concatenating page 3 onto page 1 would render rows
    // in an order that no "load more" offset could then continue from.
    await browse(filters, { limit: 2, offset: 0 });
    await browse(filters, { limit: 2, offset: 4 });

    expect(cachedBrowseRun(filters, { limit: 2 })?.rows.map((r) => r.tconst)).toEqual(["a", "b"]);
  });

  test("a run is per-filter, so switching genre does not inherit the old rows", async () => {
    pagedFetch([["a", "b"]]);
    await browse(filters, { limit: 2, offset: 0 });
    expect(cachedBrowseRun({ genre: "Comedy" }, { limit: 2 })).toBeUndefined();
  });
});

/**
 * The whole reason the season grain exists on the server rather than in the browser: a
 * ten-episode gap must cost ONE request, and the episodes must be the server's choice.
 */
describe("postSeasonRequest", () => {
  let bodies: string[] = [];

  function stubSeasonFetch(res: { ok: boolean; status?: number; body?: unknown }) {
    bodies = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push(String(url));
      bodies.push(String(init?.body));
      return {
        ok: res.ok,
        status: res.status ?? 202,
        json: async () => res.body ?? {},
      } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  test("sends ONE post naming a season, and no episode list", async () => {
    stubSeasonFetch({ ok: true, body: { queued: { tconst: "tt1", season: 3, episodes: 4 } } });
    await postSeasonRequest("tt1", 3);

    expect(calls).toEqual(["/api/requests/season"]);
    expect(JSON.parse(bodies[0] ?? "{}")).toEqual({ tconst: "tt1", season: 3 });
  });

  test("reports the count the SERVER queued, not the one the button was drawn from", async () => {
    // The mirror can move between the render and the click, and the toast has to be true
    // when it is read rather than when the page was assembled.
    stubSeasonFetch({ ok: true, body: { queued: { tconst: "tt1", season: 3, episodes: 2 } } });
    expect(await postSeasonRequest("tt1", 3)).toEqual({ episodes: 2 });
  });

  test("surfaces the server's own sentence on a refusal", async () => {
    stubSeasonFetch({ ok: false, status: 409, body: { error: "request the series first" } });
    await expect(postSeasonRequest("tt1", 3)).rejects.toThrow("request the series first");
  });

  test("falls back to the status when a refusal carries no sentence", async () => {
    stubSeasonFetch({ ok: false, status: 503 });
    await expect(postSeasonRequest("tt1", 3)).rejects.toThrow("season request failed: 503");
  });
});
