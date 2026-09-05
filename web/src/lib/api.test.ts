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
  type SearchResponse,
  search,
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
 * ONE CALLER'S ABORT IS NEVER ANOTHER CALLER'S ANSWER.
 *
 * `dedupe()` hands every concurrent caller for a key the same promise, and that promise used
 * to carry the FIRST caller's `AbortSignal` -- so an unmounting route cancelling its own
 * request rejected the request of everybody still on screen, with an `AbortError` they had
 * no way to tell from their own. A route that swallows `AbortError`, which is the correct
 * thing to do about your own abort, then waits forever.
 *
 * `search()` is the only caller passing a signal today, so it is what these are written
 * against -- but the rule lives in `dedupe`, which backs a dozen calls, and that is the
 * point: the next function to take a signal inherits this rather than re-deciding it.
 */
describe("a shared request under abort", () => {
  /** One entry per fetch that is still waiting, so a test decides when the server answers. */
  interface Gate {
    url: string;
    signal: AbortSignal | null;
    answer: (body: unknown) => void;
  }

  /**
   * A fetch that hangs until the test answers it, and honours the signal it was handed.
   *
   * `stubFetch` resolves immediately, which cannot express any of this: every question here
   * is about what happens to callers of a request that has NOT come back yet.
   */
  function gatedFetch(): Gate[] {
    const gates: Gate[] = [];
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      calls.push(String(url));
      return new Promise<Response>((resolve, reject) => {
        const signal = init?.signal ?? null;
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        gates.push({
          url: String(url),
          signal,
          answer: (body) => resolve({ ok: true, json: async () => body } as unknown as Response),
        });
      });
    }) as unknown as typeof fetch;
    return gates;
  }

  /** The smallest thing the server could truthfully answer with. */
  const answer: SearchResponse = {
    hits: [],
    facets: { genre: [], decade: [], year: [], kind: [] },
    tier: "exact",
    ms: 1,
    candidates: 0,
    parsed: { text: "", stripped: [] },
  };

  /**
   * Assert a caller's wait ended in an abort, and SETTLED.
   *
   * `.rejects.toThrow()` cannot say this: `signal.reason` is a `DOMException`, which is not
   * an `Error`, so that matcher rethrows the rejection instead of asserting on it. The name
   * is the thing worth pinning anyway -- it is exactly what `SearchRoute` branches on.
   *
   * The deadline is the other half. The bug being pinned here leaves a promise that never
   * settles, and a bare `await` on one of those hangs the whole suite rather than failing
   * it -- which is how this regression would arrive next time.
   */
  async function expectAborted(promise: Promise<unknown>): Promise<void> {
    const outcome = await Promise.race([
      promise.then(
        () => "resolved",
        (e: { name?: string }) => e?.name ?? "rejected without a name",
      ),
      Bun.sleep(500).then(() => "never settled"),
    ]);
    expect(outcome).toBe("AbortError");
  }

  test("the caller that stayed still gets the real answer after the other one aborts", async () => {
    const gates = gatedFetch();
    const leaving = new AbortController();
    const staying = new AbortController();

    const abandoned = search("inception", {}, leaving.signal);
    const wanted = search("inception", {}, staying.signal);
    expect(calls).toEqual(["/api/search?q=inception"]);

    leaving.abort();
    await expectAborted(abandoned);

    gates[0]?.answer(answer);
    expect(await wanted).toEqual(answer);
  });

  test("a caller that never aborted keeps the underlying fetch alive", async () => {
    const gates = gatedFetch();
    const leaving = new AbortController();

    const wanted = search("dune", {});
    const abandoned = search("dune", {}, leaving.signal);

    leaving.abort();
    await expectAborted(abandoned);
    expect(gates[0]?.signal?.aborted).toBe(false);

    gates[0]?.answer(answer);
    expect(await wanted).toEqual(answer);
  });

  test("the fetch IS cancelled once every caller has walked away", async () => {
    const gates = gatedFetch();
    const first = new AbortController();
    const second = new AbortController();

    const a = search("alien", {}, first.signal);
    const b = search("alien", {}, second.signal);

    first.abort();
    expect(gates[0]?.signal?.aborted).toBe(false);
    second.abort();
    expect(gates[0]?.signal?.aborted).toBe(true);

    await expectAborted(a);
    await expectAborted(b);
  });

  /**
   * THE `?q=` DEEP LINK, as a test.
   *
   * React double-invokes effects in development, so a deep link fires `search()`, aborts it
   * in the cleanup, and fires it again -- all in one tick, while the abandoned entry is still
   * in `inFlight`. Joining that entry is joining a request already being cancelled, which is
   * how the page came to sit on "Searching..." forever.
   */
  test("a caller arriving after the last one left starts a fresh request", async () => {
    const gates = gatedFetch();
    const mount = new AbortController();
    const remount = new AbortController();

    const first = search("blade runner", {}, mount.signal);
    mount.abort();
    await expectAborted(first);

    const second = search("blade runner", {}, remount.signal);
    expect(calls.length).toBe(2);

    gates[1]?.answer(answer);
    expect(await second).toEqual(answer);
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

  test("sends ONE post naming the seasons, and no episode list", async () => {
    stubSeasonFetch({ ok: true, body: { queued: { tconst: "tt1", seasons: [3], episodes: 4 } } });
    await postSeasonRequest("tt1", [3]);

    expect(calls).toEqual(["/api/requests/season"]);
    expect(JSON.parse(bodies[0] ?? "{}")).toEqual({ tconst: "tt1", seasons: [3] });
  });

  test("six seasons are ONE post, not six", async () => {
    // The whole point of the list form: the season header's button and the chooser's
    // "Request 85 episodes" reach Sonarr through one queue entry and one toast.
    stubSeasonFetch({
      ok: true,
      body: { queued: { tconst: "tt1", seasons: [2, 3, 4, 5, 6, 7], episodes: 85 } },
    });
    await postSeasonRequest("tt1", [2, 3, 4, 5, 6, 7]);

    expect(calls).toEqual(["/api/requests/season"]);
    expect(JSON.parse(bodies[0] ?? "{}")).toEqual({ tconst: "tt1", seasons: [2, 3, 4, 5, 6, 7] });
  });

  test("reports the count the SERVER queued, not the one the button was drawn from", async () => {
    // The mirror can move between the render and the click, and the toast has to be true
    // when it is read rather than when the page was assembled.
    stubSeasonFetch({ ok: true, body: { queued: { tconst: "tt1", seasons: [3], episodes: 2 } } });
    expect(await postSeasonRequest("tt1", [3])).toEqual({ episodes: 2, seasons: [3] });
  });

  test("reports the seasons that HAD a hole, which is not always the ones asked for", async () => {
    stubSeasonFetch({ ok: true, body: { queued: { tconst: "tt1", seasons: [3], episodes: 2 } } });
    expect(await postSeasonRequest("tt1", [1, 3])).toEqual({ episodes: 2, seasons: [3] });
  });

  test("an older server that echoes no seasons still reports its count", async () => {
    stubSeasonFetch({ ok: true, body: { queued: { tconst: "tt1", season: 3, episodes: 2 } } });
    expect(await postSeasonRequest("tt1", [3])).toEqual({ episodes: 2, seasons: [] });
  });

  test("surfaces the server's own sentence on a refusal", async () => {
    stubSeasonFetch({ ok: false, status: 409, body: { error: "request the series first" } });
    await expect(postSeasonRequest("tt1", [3])).rejects.toThrow("request the series first");
  });

  test("falls back to the status when a refusal carries no sentence", async () => {
    stubSeasonFetch({ ok: false, status: 503 });
    await expect(postSeasonRequest("tt1", [3])).rejects.toThrow("season request failed: 503");
  });
});
