/**
 * The search grid, and the discover shelf when the box is empty.
 *
 * Deliberately NOT a router loader. The existing client cache returns a hit
 * synchronously, so a repeat query renders with no flash, no spinner and no network
 * -- a loader would introduce a pending state on exactly the path that is already
 * instant. The router owns the URL here; it does not own the data.
 */

import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ClearChip } from "../components/Chip";
import { CollectionJump } from "../components/CollectionJump";
import { FacetBar } from "../components/FacetBar";
import { useKeyAction } from "../components/Kbd";
import { Shelf, TitleGrid } from "../components/TitleGrid";
import {
  cachedDiscover,
  cachedSearch,
  type DiscoverShelf,
  getDiscover,
  type SearchResponse,
  search,
  subscribeTitleState,
  titleStateVersion,
} from "../lib/api";
import { collectionTokenOf, filtersOf, type SearchParams, toggleFilter } from "../lib/search-params";

const EMPTY_FACETS = { genre: [], decade: [], year: [], kind: [] };

export function SearchRoute() {
  const params = useSearch({ strict: false }) as SearchParams;
  const navigate = useNavigate();

  const [result, setResult] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Seeded from the cache, not from `null`. This route unmounts every time you open a
  // title, so on the way Back a `null` initial state paints an empty front page and then
  // repaints when the refetch lands -- the flash that made Back feel like a page load.
  const [shelves, setShelves] = useState<DiscoverShelf[] | null>(() => cachedDiscover()?.shelves ?? null);

  // Requesting a title patches the rows inside the cached response in place, which
  // React cannot observe. This is what makes the optimistic badge appear.
  useSyncExternalStore(subscribeTitleState, titleStateVersion);

  const query = params.q ?? "";
  // Stable as long as the URL is: the router structurally shares `params` across
  // renders, so this memo only produces a new object when a facet actually changes.
  const filters = useMemo(() => filtersOf(params), [params]);

  /**
   * `collection:"the matrix"` is an ADDRESS, so it never reaches `/api/search`.
   *
   * Blanking the search query rather than branching around the search machinery: the
   * empty-query path already means "do not search, do not seed, do not fetch", so the
   * token needs no second copy of any of those rules -- only a different thing to render.
   */
  const collectionToken = collectionTokenOf(query);
  const searchQuery = collectionToken ? "" : query;

  // Deferred so typing never blocks on rendering a 25-card grid. The input stays
  // responsive at any speed; the results catch up a frame later.
  const deferredQuery = useDeferredValue(searchQuery);
  const abortRef = useRef<AbortController | null>(null);

  /**
   * Seed from cache DURING RENDER, so a repeat query and a Back both paint at once.
   *
   * This used to live in the effect below, under a comment claiming a cache hit rendered
   * "synchronously -- no flash". It did not: an effect runs AFTER the paint, so returning
   * to a search rendered one frame of an empty grid before the cached results appeared.
   * The same pattern BrowseRoute uses, and for the same reason.
   */
  const seedKey = `${deferredQuery.trim()}|${JSON.stringify(filters)}`;
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (seededFor !== seedKey) {
    const q = deferredQuery.trim();
    const hit = q.length > 0 ? cachedSearch(q, filters) : null;
    // Only ADOPT a hit here. A miss must not clear the current results, or every
    // keystroke of a new query would blank the grid it is refining.
    if (hit || q.length === 0) setResult(hit ?? null);
    setSeededFor(seedKey);
    setError(null);
  }

  useEffect(() => {
    const q = deferredQuery.trim();
    if (q.length === 0) return;
    // Already painted from cache above.
    if (cachedSearch(q, filters)) return;

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    search(q, filters, ctrl.signal)
      .then((r) => {
        if (!ctrl.signal.aborted) {
          setResult(r);
          setError(null);
        }
      })
      .catch((e: Error) => {
        if (e.name !== "AbortError") setError(e.message);
      });

    return () => ctrl.abort();
  }, [deferredQuery, filters]);

  useEffect(() => {
    // A cache hit already painted above, so there is nothing to fetch and nothing to
    // set -- setting state here would be a wasted render on every Back.
    if (shelves) return;
    getDiscover()
      .then((d) => setShelves(d.shelves))
      .catch(() => setShelves([]));
  }, [shelves]);

  const activeFilters = useMemo(
    () => Object.entries(filters).filter(([, v]) => v !== undefined && v !== ""),
    [filters],
  );

  const searching = searchQuery.trim().length > 0;

  /** One owner for "drop the refinements, keep the query", shared by the chip and `esc`. */
  const clearFilters = useCallback(
    () => navigate({ to: "/", search: query ? { q: query } : {} }),
    [navigate, query],
  );

  /*
    `esc` survives a focused search box (see `firesFrom`), which matters here more than
    anywhere: the caret is almost always in that box, and undoing a refinement without
    reaching for the mouse is the whole gesture.
  */
  const clearKey = useKeyAction("clearFilters", clearFilters, activeFilters.length > 0);

  return (
    <>
      {result && (
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span>
            {result.hits.length} of {result.candidates} in{" "}
            <span className="tabular-nums text-ink">{result.ms.toFixed(1)}ms</span>
          </span>
          <span className="rounded bg-surface-2 px-1.5 py-0.5 uppercase tracking-wide">{result.tier}</span>
          {result.parsed.year && <span>year {result.parsed.year}</span>}
          {result.parsed.kind && <span>{result.parsed.kind}</span>}
          {result.parsed.season && <span>season {result.parsed.season}</span>}
          {result.parsed.stripped.length > 0 && (
            <span className="italic">ignored {result.parsed.stripped.join(", ")}</span>
          )}
        </div>
      )}

      {result && result.hits.length > 0 && (
        <div className="mb-4">
          <FacetBar
            facets={result.facets ?? EMPTY_FACETS}
            active={filters}
            onToggle={(patch) =>
              // A facet change PUSHES, unlike a keystroke -- refining is a step you
              // should be able to undo with Back.
              navigate({ to: "/", search: toggleFilter(params, patch) })
            }
            onClear={clearFilters}
            clearShortcut={clearKey}
            activeCount={activeFilters.length}
          />
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-sm">{error}</div>
      )}

      {searching && result && result.hits.length === 0 && (
        <div className="py-16 text-center text-muted">
          <p>Nothing for “{query}”.</p>
          {/*
            THE ESCAPE HATCH CARRIES ITS OWN AFFORDANCE HERE, and it has to.

            `FacetBar` -- and with it the only other `ClearChip` -- draws nothing when the
            result set is empty, because it has no facet counts to offer. But `esc` stays
            bound whenever a filter is active, so refining down to zero hits used to leave
            a working shortcut with nothing on screen naming it: the one state the hatch
            exists for was the one state it was invisible in. The chip is the same
            component wearing the same binding, so there is still exactly one affordance
            for one key.
          */}
          {activeFilters.length > 0 && (
            <p className="mt-3 flex justify-center">
              <ClearChip count={activeFilters.length} onClick={clearFilters} shortcut={clearKey} />
            </p>
          )}
        </div>
      )}

      {collectionToken ? (
        <CollectionJump name={collectionToken.name} closed={collectionToken.closed} />
      ) : searching ? (
        <TitleGrid titles={result?.hits ?? []} />
      ) : (
        /*
          Every shelf is a local index query costing zero external calls. The server
          decides which shelves exist and in what order; this just renders them, so a
          new shelf never needs a change here.
        */
        shelves?.map((s) => (
          <Shelf
            key={s.id}
            title={s.title}
            subtitle={s.subtitle}
            titles={s.titles}
            action={
              s.browse && (
                <Link
                  to="/browse"
                  search={s.browse as Record<string, never>}
                  className="shrink-0 text-xs text-muted hover:text-ink"
                >
                  See all →
                </Link>
              )
            }
          />
        ))
      )}
    </>
  );
}
