/**
 * Browse the index by filter, at a real URL.
 *
 * `/api/browse` has existed since v0, fully paginated, and no UI ever called it. This
 * is the first consumer, and deliberately the same shape every later discovery view
 * needs: a header describing the filter, the shared grid, and a way to page.
 *
 * `/browse?genre=Horror&decade=1980` is the whole feature -- shareable, refreshable,
 * and back-navigable because the filter is in the URL rather than in state.
 *
 * The one thing deliberately NOT in the URL is the vote floor. `/api/browse` curates
 * broad grids with a minimum vote count, and when that floor is what emptied the page
 * the response says so; the empty state then offers to lift it for this filter. That
 * keeps the threshold an internal ranking knob instead of a shareable URL contract
 * somebody has to keep meaningful across index rebuilds.
 */

import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { completionNoun, kindNoun, listForFilters, RANK_EXPLAINER } from "../../../src/lib/lists";
import { ClearChip } from "../components/Chip";
import { Completion } from "../components/Completion";
import { useKeyAction } from "../components/Kbd";
import { TitleGrid } from "../components/TitleGrid";
import {
  type BrowseSort,
  browse,
  cachedBrowseRun,
  type HiddenByFloor,
  subscribeTitleState,
  type Title,
  titleStateVersion,
} from "../lib/api";
import { filtersOf, type SearchParams } from "../lib/search-params";
import { useListCompletions } from "../lib/use-list-completions";

const PAGE = 60;

/**
 * "Horror films from the 1980s" -- a sentence, not a list of key=value pairs.
 *
 * A ranked browse says "Best" rather than naming the ordering, because that IS the name of
 * the list: nobody calls it "horror films sorted by weighted rating". The ordering still
 * has to be stated somewhere, and `RANK_EXPLAINER` under the heading is where -- a page
 * that says "Best" without saying whose measure it is, is the one thing the card that
 * built this forbade.
 */
function describe(f: SearchParams): string {
  const parts = [f.sort === "rank" ? "best" : undefined, f.genre, kindNoun(f.kind)];
  if (f.year) parts.push(`from ${f.year}`);
  else if (f.decade) parts.push(`from the ${f.decade}s`);
  return parts.filter(Boolean).join(" ");
}

export function BrowseRoute() {
  const params = useSearch({ strict: false }) as SearchParams;
  const navigate = useNavigate();

  const [rows, setRows] = useState<Title[]>([]);
  const [total, setTotal] = useState(0);
  const [hiddenByFloor, setHiddenByFloor] = useState<HiddenByFloor | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useSyncExternalStore(subscribeTitleState, titleStateVersion);

  // The filter identity is the URL, so a key built from it is stable and cheap.
  const filterKey = JSON.stringify(filtersOf(params));
  /*
    The sort rides beside the filters rather than inside them, and `filtersOf` is why.

    That function PICKS known filter keys precisely so a non-filter param cannot ride into
    `/api/browse` and into the cache key -- the lesson `role` bought. `sort` is not a filter:
    it selects no rows, it orders them. So it travels as a fetch option, like `minVotes`,
    and every request identity below has to name it explicitly. Leaving it out of the key
    would serve a ranked list the votes-ordered page it had already cached.

    NARROWED TO THIS ROUTE'S OWN VOCABULARY. `sort` is one URL key shared with the person
    page, which spells its non-default `year`; browse only knows `rank`. Anything else is
    this route's default rather than an ordering it cannot produce, which is the same rule
    the person page applies to `rank`.
  */
  const sort: BrowseSort | undefined = params.sort === "rank" ? "rank" : undefined;

  /**
   * Which filter the user asked to see past the vote floor for.
   *
   * Stored as the filter it belongs to rather than as a bare boolean, so moving to a
   * different filter drops the escape hatch instead of silently carrying it over --
   * and it does so in the same render, with no flash of a floored empty state.
   */
  const [unflooredFilter, setUnflooredFilter] = useState<string | null>(null);
  const minVotes = unflooredFilter === filterKey ? 0 : undefined;

  /**
   * Seed from cache DURING RENDER, so Back never paints an empty grid.
   *
   * Adjusting state while rendering is React's documented way to react to a changed
   * input, and it is the only one that avoids a frame: an effect would paint the stale
   * or empty rows first, which is precisely the flash this is here to remove. It is
   * keyed on the request identity rather than on mount, because the filter can change
   * without the route remounting -- a genre chip clicked from inside /browse keeps this
   * component alive, so a lazy `useState` initializer would only ever seed the first one.
   */
  const requestKey = `${filterKey}|${minVotes ?? ""}|${sort ?? ""}`;
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (seededFor !== requestKey) {
    const run = cachedBrowseRun(JSON.parse(filterKey), { limit: PAGE, minVotes, sort });
    setSeededFor(requestKey);
    setRows(run?.rows ?? []);
    setTotal(run?.total ?? 0);
    setHiddenByFloor(run?.hiddenByFloor);
    setError(null);
  }

  useEffect(() => {
    // Already served from cache -- no request, no spinner, nothing to wait for.
    if (cachedBrowseRun(JSON.parse(filterKey), { limit: PAGE, minVotes, sort })) return;

    let stale = false;
    setLoading(true);
    setError(null);
    browse(JSON.parse(filterKey), { limit: PAGE, offset: 0, minVotes, sort })
      .then((r) => {
        if (stale) return;
        setRows(r.rows);
        setTotal(r.total);
        setHiddenByFloor(r.hiddenByFloor);
      })
      .catch((e: Error) => {
        if (!stale) setError(e.message);
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [filterKey, minVotes, sort]);

  const loadMore = async () => {
    setLoading(true);
    try {
      const r = await browse(JSON.parse(filterKey), { limit: PAGE, offset: rows.length, minVotes, sort });
      setRows((prev) => [...prev, ...r.rows]);
      setTotal(r.total);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const activeFilters = Object.keys(filtersOf(params)).length;
  const canLoadMore = rows.length < total && !loading;

  /*
    Which NAMED list this page is, if it is one at all.

    `/browse?genre=Horror&kind=movie&sort=rank` is not merely a filtered grid -- it is the
    page "Best Horror" on `/lists` links to, so it is that list and can say what you own of
    it. A votes-ordered grid is not a list and gets nothing: "you own 178 of 250 films" only
    means something when the 250 are a defined head, and `sort=rank` is what defines it.

    The completion is fetched for the WHOLE catalogue and one entry is read, which is the
    same request `/lists` already made -- so arriving here from there costs nothing.
  */
  const completions = useListCompletions();
  const list = sort === "rank" ? listForFilters(new Date().getFullYear(), filtersOf(params)) : undefined;
  const completion = list ? completions[list.id] : undefined;

  /** One owner for "drop every filter", shared by the chip, the empty state and `esc`. */
  const clearFilters = useCallback(() => navigate({ to: "/browse", search: {} }), [navigate]);

  /*
    A browse page has exactly one page-level action -- show the next 60 -- so it gets the
    plain `⏎`, gated on there being more to show. The title page's `⌘⏎` is modified
    instead, because that one spends bandwidth and disk.
  */
  const loadMoreKey = useKeyAction("loadMore", () => void loadMore(), canLoadMore);
  const clearKey = useKeyAction("clearFilters", clearFilters, activeFilters > 0);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold tracking-tight first-letter:uppercase">{describe(params)}</h2>
        {total > 0 && (
          <span className="text-xs text-muted tabular-nums">
            {rows.length} of {total.toLocaleString()}
          </span>
        )}
      </div>

      {/*
        A ranked page says whose measure it is, right under the word "Best".

        Not decoration and not a tooltip: this order reproduces IMDb's Top 250 head almost
        exactly and will never match it, so a page claiming "best" without naming the
        measure is claiming somebody else's authority. One sentence, one owner
        (`RANK_EXPLAINER`), shown here and on `/lists`.
      */}
      {params.sort === "rank" && (
        <p className="-mt-2 mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <span className="max-w-2xl">{RANK_EXPLAINER}</span>
          {completion && (
            <Completion owned={completion.owned} total={completion.size} noun={completionNoun(params.kind)} />
          )}
        </p>
      )}

      {activeFilters > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-1.5 text-xs">
          {/*
            The row could only ever remove filters one at a time, so `esc` had nowhere to
            live and neither did "start over" -- the way out existed only in the empty
            state, which you never reach unless the filters found nothing.
          */}
          <ClearChip count={activeFilters} onClick={clearFilters} shortcut={clearKey} />
          {(["genre", "kind", "decade", "year"] as const).map((k) => {
            const v = params[k];
            if (v === undefined || v === "") return null;
            const next = { ...params };
            delete next[k];
            return (
              <Link
                key={k}
                to="/browse"
                search={next}
                className="rounded-full bg-surface-2 px-2 py-0.5 text-muted hover:text-ink"
                // The chip removes its own filter -- the same toggle behaviour the
                // facet bar has, so the two surfaces do not disagree.
                title={`Remove ${k} filter`}
              >
                {k === "decade" ? `${v}s` : v} ✕
              </Link>
            );
          })}
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-sm">{error}</div>
      )}

      {!loading && rows.length === 0 && !error && (
        <p className="py-16 text-center text-muted">
          {hiddenByFloor ? (
            <>
              Nothing with {hiddenByFloor.minVotes.toLocaleString()} votes or more matches.{" "}
              <button
                type="button"
                onClick={() => setUnflooredFilter(filterKey)}
                className="underline hover:text-ink"
              >
                Show all {hiddenByFloor.titles.toLocaleString()}
              </button>
            </>
          ) : (
            <>
              Nothing matches that.{" "}
              <button type="button" onClick={clearFilters} className="underline">
                Clear the filters
              </button>
            </>
          )}
        </p>
      )}

      <TitleGrid titles={rows} />

      {rows.length < total && (
        <div className="mt-6 flex justify-center">
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loading}
            {...loadMoreKey.props}
            className="rounded-lg border border-line px-4 py-2 text-sm text-muted
                       hover:text-ink disabled:opacity-50"
          >
            {loading ? "Loading…" : `Show ${Math.min(PAGE, total - rows.length)} more`}
            {loadMoreKey.hint}
          </button>
        </div>
      )}
    </>
  );
}
