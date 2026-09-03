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
import { PeopleRow } from "../components/PeopleRow";
import { GridSkeleton, Shelf, ShelfSkeleton, StaleResults, TitleGrid } from "../components/TitleGrid";
import {
  cachedDiscover,
  cachedSearch,
  type DiscoverShelf,
  type Filters,
  getDiscover,
  reportSearchClick,
  type SearchResponse,
  search,
  subscribeTitleState,
  titleStateVersion,
} from "../lib/api";
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from "../lib/debounce";
import { collectionTokenOf, filtersOf, type SearchParams, toggleFilter } from "../lib/search-params";
import { isSearching, searchPhase } from "../lib/search-view";

const EMPTY_FACETS = { genre: [], decade: [], year: [], kind: [] };

/**
 * What an answer on screen is an answer TO: the query and the refinements together.
 *
 * One owner, because a facet toggle changes the answer without changing the query text --
 * so the two halves have to travel as one string or `searchPhase` cannot tell a settled
 * grid from a stale one. It was spelt out at both call sites before.
 */
function answerKey(query: string, filters: Filters): string {
  return `${query}|${JSON.stringify(filters)}`;
}

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

  /*
    DEBOUNCED, and this is the one that stopped the server falling over.

    `useDeferredValue` above defers RENDERING, not fetching -- it was already here and the
    box still fired `/api/search` on every keystroke. Measured 2026-09-02 against the live
    deployment: typing "the matrix" sent TEN requests in 3.1s, two of which were the 1033ms
    stopword query, and because `bun:sqlite` is synchronous each of those held the entire
    server. `/api/health` went from 90ms to 981ms beside one of them.

    Aborting was not a fix and could not be: `AbortController` ends the browser's interest in
    a response the server is already computing synchronously. The request has to not be SENT.

    Only the fetch waits. The URL and the input are untouched -- see `debounce.ts` for why
    debouncing the navigation instead would have put the lag in the caret.
  */
  const debouncedQuery = useDebouncedValue(deferredQuery, SEARCH_DEBOUNCE_MS);
  const abortRef = useRef<AbortController | null>(null);

  /**
   * Seed from cache DURING RENDER, so a repeat query and a Back both paint at once.
   *
   * This used to live in the effect below, under a comment claiming a cache hit rendered
   * "synchronously -- no flash". It did not: an effect runs AFTER the paint, so returning
   * to a search rendered one frame of an empty grid before the cached results appeared.
   * The same pattern BrowseRoute uses, and for the same reason.
   */
  const seedKey = answerKey(deferredQuery.trim(), filters);
  const [seededFor, setSeededFor] = useState<string | null>(null);
  /*
    WHICH QUESTION the painted result answers, so the view can tell "this is the answer" from
    "this is the previous answer, still on screen while we fetch". Before the debounce there
    was barely a window between those two; now there is always one, and a reader watching a
    stale grid with nothing moving is how a fast search reads as a broken one.

    The `key` drives that comparison and the `query` is what a click reports, and they are
    ONE state rather than two because they are one fact: reporting a click against whatever
    is in the box right now would attribute it to a query the reader never saw results for.
  */
  const [answered, setAnswered] = useState<{ key: string; query: string } | null>(null);
  if (seededFor !== seedKey) {
    const q = deferredQuery.trim();
    const hit = q.length > 0 ? cachedSearch(q, filters) : null;
    // Only ADOPT a hit here. A miss must not clear the current results, or every
    // keystroke of a new query would blank the grid it is refining.
    if (hit || q.length === 0) {
      setResult(hit ?? null);
      setAnswered(hit ? { key: seedKey, query: q } : null);
    }
    setSeededFor(seedKey);
    setError(null);
  }

  useEffect(() => {
    const q = debouncedQuery.trim();
    if (q.length === 0) return;
    const key = answerKey(q, filters);
    // Already painted from cache above.
    if (cachedSearch(q, filters)) return;

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    search(q, filters, ctrl.signal)
      .then((r) => {
        if (!ctrl.signal.aborted) {
          setResult(r);
          setAnswered({ key, query: q });
          setError(null);
        }
      })
      .catch((e: Error) => {
        if (e.name !== "AbortError") setError(e.message);
      });

    return () => ctrl.abort();
  }, [debouncedQuery, filters]);

  /*
    THE FRONT PAGE IS ASKED FOR ON EVERY MOUNT, even when state already holds one.

    This used to open with `if (shelves) return`, which made the seeded copy above the last
    word for the rest of the session: a reader who requested a title then came Back was
    shown a page assembled before they asked, on a shelf named after having asked. The
    server was already rebuilding for exactly that click (`primeShelves("arr")`); nothing
    on this side ever asked again.

    Asking unconditionally costs nothing on the ordinary Back. `getDiscover` short-circuits
    on its own cache and resolves with the SAME array it handed out before, and React bails
    out of a re-render when state is set to the value it already holds. What it buys is the
    one case the early return swallowed: a page marked paint-only by `postRequest` is drawn
    instantly from cache AND refetched.
  */
  useEffect(() => {
    getDiscover()
      .then((d) => setShelves(d.shelves))
      // `[]` is "the server says there are no shelves", so it may only be reached from
      // having nothing. A refetch that fails behind a page already on screen must leave
      // that page alone rather than replace it with the empty state.
      .catch(() => setShelves((held) => held ?? []));
  }, []);

  const activeFilters = useMemo(
    () => Object.entries(filters).filter(([, v]) => v !== undefined && v !== ""),
    [filters],
  );

  const searching = searchQuery.trim().length > 0;
  const phase = searchPhase(deferredQuery, answered?.key ?? null, seedKey);
  const working = isSearching(phase);

  /**
   * Tell the server which result was opened, and where it was.
   *
   * The query and tier come from the ANSWER on screen, never from the box: a reader
   * clicking a card during a refine is opening a result of the older query, and reporting
   * it against the newer one would put the ranking failure on the wrong search.
   */
  const reportClick = useCallback(
    (title: { tconst: string }, rank: number) => {
      if (!answered || !result) return;
      reportSearchClick(answered.query, title.tconst, rank, result.tier);
    },
    [answered, result],
  );

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
      {/*
        The one moving thing on screen while a query is in flight.

        It replaces the stats line rather than sitting beside it, because those numbers
        describe the PREVIOUS query and a count that disagrees with the grid is worse than
        no count. `aria-live="polite"` so a screen reader is told the search is running
        without interrupting whatever it is currently reading.
      */}
      {working && (
        <div aria-live="polite" className="mb-2 flex items-center gap-2 text-xs text-muted">
          <span className="size-2 animate-pulse rounded-full bg-accent motion-reduce:animate-none" />
          Searching…
        </div>
      )}

      {result && !working && (
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

      {/* "Nothing for X" must never be shown ABOUT A QUERY STILL RUNNING -- with the
          debounce there is now a real window where the old empty result is on screen while
          the new one is in flight, and claiming no match during it is simply false.

          It counts PEOPLE too. A search that found the director and no films of theirs we
          index has found something, and printing "Nothing for Chris Nolan" above a row
          holding Christopher Nolan is the page arguing with itself. */}
      {searching && !working && result && result.hits.length === 0 && !result.people?.length && (
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
        /*
          `first` has nothing to keep, so it reserves the grid's space rather than showing a
          blank screen. Every later query HAS something to keep, which is what `StaleResults`
          is -- and its doc comment is where the case for keeping it lives.
        */
        phase === "first" ? (
          <GridSkeleton />
        ) : (
          /*
            The people row is INSIDE `StaleResults` with the grid, because it is half of the
            same answer: fading one and leaving the other bright would say the two came from
            different queries. It has no skeleton of its own for the same reason the shelves
            do not get one here -- `phase === "first"` already reserves the screen.
          */
          <StaleResults stale={phase === "refining"}>
            <PeopleRow people={result?.people ?? []} />
            <TitleGrid titles={result?.hits ?? []} onOpen={reportClick} />
          </StaleResults>
        )
      ) : /*
          Every shelf is a local index query costing zero external calls. The server
          decides which shelves exist and in what order; this just renders them, so a
          new shelf never needs a change here.

          > [!IMPORTANT] `null` and `[]` mean different things and get different screens
          > `null` is "we have not asked yet, or the answer has not landed" -- a first
          > visit with a cold client cache -- and it draws the skeleton. `[]` is the
          > server ANSWERING that it has no shelves, which is a real state on an index
          > that has just been built, and it must stay blank: a placeholder that never
          > resolves is worse than an empty page, because it promises something is coming.
          >
          > `shelves?.map()` alone drew nothing for both, which is what made a cold first
          > load a header and a screenful of dark.
        */
      shelves === null ? (
        <ShelfSkeleton />
      ) : (
        shelves.map((s) => (
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
