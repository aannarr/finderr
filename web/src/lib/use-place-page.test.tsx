/**
 * The place page's state as BEHAVIOUR: one mounted hook whose `id` changes, which is what the
 * route does between places. The source is a fake whose first request stays open until the
 * test says so -- a navigation that lands mid-flight is the case every bug here lived in.
 */

import { describe, expect, test } from "bun:test";
import { act, renderHook } from "../test/interact";
import type { PlacePage, Title } from "./api";
import { type PlacePageSource, usePlacePage } from "./use-place-page";

const page = (id: string, shown: number, total: number): PlacePage => ({
  place: { id, label: id, kind: "site", studio: false, country: null, lat: null, lon: null, titles: total },
  titles: Array.from({ length: shown }, (_, i) => ({ tconst: `tt${id}${i}` })) as unknown as Title[],
  total,
  parts: {},
});

/** Q1 is not cached and its request never settles until `release`; Q2 is already cached. */
function openSource() {
  let release: (p: PlacePage) => void = () => {};
  const pending = new Promise<PlacePage>((resolve) => {
    release = resolve;
  });
  const source: PlacePageSource = {
    getPlace: ((id: string) => (id === "Q1" ? pending : Promise.reject(new Error("offline")))) as never,
    cachedPlaceRun: ((id: string) => (id === "Q2" ? page("Q2", 2, 5) : undefined)) as never,
  };
  return { source, release: (p: PlacePage) => release(p) };
}

describe("usePlacePage", () => {
  /*
    Found by the round-3 review of 2026-09-14. The first load of an uncached place set `loading`,
    the reader moved to a CACHED place before it settled, the cleanup threw away its
    `setLoading(false)`, and the cached place's effect loaded nothing -- so "Show more" read
    "Loading…" and stayed disabled for good.
  */
  test("moving to a cached place while another is still loading leaves Show more usable", async () => {
    const { source, release } = openSource();
    const { result, rerender } = renderHook(({ id }) => usePlacePage(id, 2, source), {
      initialProps: { id: "Q1" },
    });
    expect(result.current.loading).toBe(true);

    rerender({ id: "Q2" });
    expect(result.current.page?.place.id).toBe("Q2");
    expect(result.current.loading).toBe(false);
    expect(result.current.canLoadMore).toBe(true);

    // The abandoned request landing late must not replace the page on screen.
    await act(async () => release(page("Q1", 2, 9)));
    expect(result.current.page?.place.id).toBe("Q2");
    expect(result.current.loading).toBe(false);
  });

  test("a failed Show more belongs to the place it failed on", async () => {
    const { source } = openSource();
    const { result, rerender } = renderHook(({ id }) => usePlacePage(id, 2, source), {
      initialProps: { id: "Q2" },
    });
    await act(async () => result.current.loadMore());
    expect(result.current.moreFailed).toBe(true);
    expect(result.current.loading).toBe(false);

    rerender({ id: "Q1" });
    expect(result.current.moreFailed).toBe(false);
  });
});
