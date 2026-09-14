/**
 * The state of one place page: the pages we hold, whether the next is loading, and what failed.
 *
 * A hook of its own rather than the body of `PlaceRoute`, so the state machine can be driven by
 * a test with no router, no `AppProvider` and no network. `PlaceRoute` is not remounted between
 * places, so every piece of state here has to answer "which place is this about?" -- and the
 * round-3 review of 2026-09-14 found one that did not.
 */

import { useEffect, useRef, useState } from "react";
import { cachedPlaceRun, getPlace, type PlacePage } from "./api";

/** Where the pages come from. Injected, so a test can hold a request open. */
export interface PlacePageSource {
  getPlace: typeof getPlace;
  cachedPlaceRun: typeof cachedPlaceRun;
}

const LIVE: PlacePageSource = { getPlace, cachedPlaceRun };

export interface PlacePageState {
  page: PlacePage | null;
  error: string | null;
  loading: boolean;
  /** "Show more" failed for THIS place. Beside the grid, never `error`, which replaces the page. */
  moreFailed: boolean;
  canLoadMore: boolean;
  loadMore: () => Promise<void>;
  /** Fetch the first page again after `error`. */
  retry: () => void;
}

/**
 * Fetch a place's first page into whichever setters the caller hands over.
 *
 * ONE body for the two callers -- the load effect, whose setters are guarded against a stale
 * navigation, and `retry`, which runs in a click on the page that is already mounted.
 */
function loadFirstPage(
  source: PlacePageSource,
  id: string,
  pageSize: number,
  set: {
    setPage: (p: PlacePage) => void;
    setError: (e: string) => void;
    setLoading: (l: boolean) => void;
  },
): void {
  set.setLoading(true);
  source
    .getPlace(id, { limit: pageSize, offset: 0 })
    .then((p) => set.setPage(p))
    .catch((e: Error) => set.setError(e.message))
    .finally(() => set.setLoading(false));
}

export function usePlacePage(id: string, pageSize: number, source: PlacePageSource = LIVE): PlacePageState {
  const [page, setPage] = useState<PlacePage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /*
    Held as WHICH place failed rather than a boolean: a failure on Almería used to follow the
    reader onto Tabernas.
  */
  const [moreFailedFor, setMoreFailedFor] = useState<string | null>(null);

  // Seeded during render, for the reason every grid route is: opening a title unmounts the
  // page, and a null first state would blank it on the way back.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (seededFor !== id) {
    setSeededFor(id);
    setError(null);
    /*
      `loading` belongs to the place that set it. The last place's first load may still be in
      flight, and its effect cleanup throws that load's `setLoading(false)` away -- so a move to
      a CACHED place, whose effect loads nothing, left "Show more" reading "Loading…" and
      disabled for good. Found by the round-3 review of 2026-09-14. An uncached place sets it
      again in its own effect.
    */
    setLoading(false);
    setPage(source.cachedPlaceRun(id, pageSize) ?? null);
  }

  // The place on screen NOW, for a `loadMore` that settles after the reader has moved on.
  const current = useRef(id);
  useEffect(() => {
    current.current = id;
  }, [id]);

  useEffect(() => {
    // The index only changes at a rebuild, so a page we already hold IS the answer. No
    // revalidation -- unlike a term page, whose membership grows as the facet cache warms.
    if (source.cachedPlaceRun(id, pageSize)) return;
    let stale = false;
    loadFirstPage(source, id, pageSize, {
      setPage: (p) => !stale && setPage(p),
      setError: (e) => !stale && setError(e),
      setLoading: (l) => !stale && setLoading(l),
    });
    return () => {
      stale = true;
    };
  }, [id, pageSize, source]);

  const canLoadMore = Boolean(page && !loading && page.titles.length < page.total);

  const loadMore = async () => {
    if (!page || !canLoadMore) return;
    const forId = id;
    setLoading(true);
    setMoreFailedFor(null);
    try {
      const next = await source.getPlace(forId, { limit: pageSize, offset: page.titles.length });
      // Appended only onto the SAME place: a reader who navigated away mid-fetch must not get
      // this page's rows stitched under another place's header.
      setPage((prev) =>
        prev && prev.place.id === next.place.id
          ? {
              ...next,
              titles: [...prev.titles, ...next.titles],
              episodes: { ...prev.episodes, ...next.episodes },
            }
          : prev,
      );
    } catch {
      setMoreFailedFor(forId);
    } finally {
      // Only the place that asked may clear the flag, or a slow page 2 of Almería would mark
      // Tabernas' first load finished while it is still in flight.
      if (current.current === forId) setLoading(false);
    }
  };

  const retry = () => {
    setError(null);
    loadFirstPage(source, id, pageSize, { setPage, setError, setLoading });
  };

  return { page, error, loading, moreFailed: moreFailedFor === id, canLoadMore, loadMore, retry };
}
