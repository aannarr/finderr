/**
 * What the front page is made of.
 *
 * ONE definition, three consumers: `/api/discover` renders these shelves, the warm loop
 * warms every title on them, and `/api/health` reports coverage against them. That is
 * what makes "nothing on screen was ever fetched while you waited" a property of this
 * file rather than an agreement between three copies of the membership rules that would
 * drift apart on the first shelf somebody adds.
 *
 * It lives here rather than in the server entry so it can be exercised without booting a
 * server: the entry is boot, timers and routes, and shelf membership is none of those.
 *
 * Every row is a query over the local index and costs ZERO external calls, which is why
 * finderr can offer shelves Seerr structurally cannot -- "hidden gems" is the example, and
 * `SearchEngine.hiddenGems` is still there, but aannarr took it off the front page on
 * 2026-08-31. Putting it back is one entry in the list below.
 */

import { decadeOf, type SearchEngine, type TitleRow } from "../lib/search";
import type { Store, UpcomingSource } from "../lib/store";

/** A row of the front page: what to call it, where its "see all" points, and its titles. */
export interface DiscoveryShelf {
  id: string;
  title: string;
  subtitle?: string;
  browse?: Record<string, string>;
  rows: TitleRow[];
}

/**
 * The slices of the engine and the store a shelf needs, and nothing else.
 *
 * Narrow and injected rather than reached for: a test hands over a handful of rows, and
 * the shelf rules are checked without an index, a database or a network.
 */
export interface ShelfDeps {
  engine: Pick<
    SearchEngine,
    "topRated" | "newThisDecade" | "topGenres" | "topRatedInGenre" | "byTconst" | "browse" | "hasRank"
  >;
  store: Pick<Store, "libraryMap" | "recentlyAddedIds" | "upcomingBySource">;
  /** Injected so which decade counts as "this" one is pinnable rather than ambient. */
  now?: () => number;
}

/**
 * The newest titles in the library, as index rows.
 *
 * The mirror stores ids and the arr's `added` date; the index has everything a card
 * needs. Order is preserved from the mirror because the index lookup does not carry one
 * -- losing it would make the shelf "some things you own" rather than "new".
 */
function recentlyAdded(deps: ShelfDeps, limit: number): TitleRow[] {
  const out: TitleRow[] = [];
  for (const id of deps.store.recentlyAddedIds(limit)) {
    const row = deps.engine.byTconst(id);
    if (row) out.push(row);
  }
  return out;
}

/**
 * One shelf out of the `upcoming` mirror, as index rows.
 *
 * The mirror holds a tconst and a date; the index holds everything a card draws. The
 * table is already ordered soonest-first and the sync already dropped anything the index
 * cannot draw, so this is a lookup and not a second filter -- but `byTconst` is still
 * allowed to answer null, because the mirror and the index are refreshed on different
 * timers and an index swap can retire a row between them.
 */
function fromUpcoming(deps: ShelfDeps, source: UpcomingSource, limit: number): UpcomingTitleRow[] {
  const out: UpcomingTitleRow[] = [];
  for (const row of deps.store.upcomingBySource(source, limit)) {
    const title = deps.engine.byTconst(row.tconst);
    if (!title) continue;
    /*
      The mirror's facts ride ON the row rather than in a parallel map.

      `decorate()` in the server entry spreads each row, so anything attached here reaches
      the browser with no change to the discover payload's shape and no second lookup
      keyed on tconst that could fall out of step with the rows beside it. A card that has
      no `upcoming` key simply draws as it always did.
    */
    out.push({
      ...title,
      upcoming: {
        date: row.date,
        dateKind: row.date_kind,
        detail: row.detail,
        episodeTitle: row.episode_title,
        hasFile: row.has_file === null ? null : row.has_file === 1,
      },
    });
  }
  return out;
}

/** An index row plus what the upcoming mirror knows about it. */
export interface UpcomingTitleRow extends TitleRow {
  upcoming: {
    date: string;
    dateKind: string;
    detail: string | null;
    episodeTitle: string | null;
    hasFile: boolean | null;
  };
}

/**
 * The shelves, in the order they are rendered.
 *
 * ORDERED rather than keyed: the client renders whatever the server sends, in the
 * server's order, so adding a shelf never needs a matching client change. A shelf that
 * came back empty is dropped rather than rendered as a blank row.
 */
export function discoveryShelves(deps: ShelfDeps): DiscoveryShelf[] {
  const { engine } = deps;
  const owned = new Set(deps.store.libraryMap().keys());
  const year = new Date(deps.now?.() ?? Date.now()).getFullYear();

  const shelves: DiscoveryShelf[] = [
    {
      id: "recently-added",
      title: "Recently added to your library",
      subtitle: "newest in Radarr and Sonarr",
      rows: recentlyAdded(deps, 24),
    },
    /*
      THE ONE SHELF THAT IS A LIST RATHER THAN A SELECTION, AND IT KEEPS WHAT YOU OWN.

      Every other row here excludes the library, because "here is something you do not
      have" is the point of a recommendation. A canonical list is the opposite: a Top 250
      with the good ones quietly removed is not the Top 250, it is a list with holes and no
      way to tell that from the numbering. The grid already marks an owned title, so
      nothing is lost by leaving them in.

      It is `browse` with `sort: "rank"` and no second ranking expression anywhere -- the
      weighted rank lives in the index column, so this shelf and the full list behind its
      "see all" link cannot disagree about the order. `movie` is pinned because a mixed
      film-and-series list has no honest title: the two are rated by different crowds at
      different volumes, and the series would take the head.

      NEVER call this IMDb's Top 250. It reproduces IMDb's head almost exactly and will
      not match it, because IMDb's vote filtering is unpublished.

      > [!IMPORTANT] `hasRank` is what keeps the NAME honest across a deploy
      > A redeploy keeps its data directory, so for up to a day after this ships the live
      > index has no rank column. `engine.browse` would quietly downgrade to a votes sort
      > and this shelf would render the most POPULAR films under the heading "finderr Top
      > 250" -- a wrong list wearing a right one's label, and nothing on screen to say so.
      > An empty `rows` array drops the shelf entirely (see the filter below), which is the
      > honest version of the same state: the list is not available yet, so it is not shown.
    */
    {
      id: "top-250",
      title: "finderr Top 250",
      subtitle: "weighted by rating and how many people voted",
      browse: { sort: "rank", kind: "movie" },
      rows: engine.hasRank ? engine.browse({ sort: "rank", kind: "movie", limit: 30 }).rows : [],
    },
    {
      id: "top-movies",
      title: "Highly rated, not in your library",
      browse: { kind: "movie" },
      rows: engine.topRated({ kind: "movie", limit: 30, excludeTconsts: owned }),
    },
    {
      id: "top-series",
      title: "Series worth starting",
      browse: { kind: "tvSeries" },
      rows: engine.topRated({ kind: "tvSeries", minVotes: 20_000, limit: 30, excludeTconsts: owned }),
    },
    /*
      THE FOUR UPCOMING SHELVES SPLIT TWICE, AND BOTH SPLITS CARRY MEANING.

      Across: the first two are what this library ALREADY follows, from the arrs' own
      calendars. The last two are discovery, from TMDB, with owned titles excluded. Merging
      them would produce one row where "you asked for this" and "you have never heard of
      this" sit side by side wearing the same chrome.

      Down: movies and series are separate rows because they arrive from different
      endpoints on different windows and read differently -- an episode airs this week, a
      film is dated months out. One mixed row sorted by date would interleave them.

      All four are ordered soonest-first by the store. There is deliberately no popularity
      ordering here: for the TMDB rows popularity already chose WHICH titles were fetched,
      and re-using it as the display order would bury next week's release under a blockbuster
      dated next year.
    */
    {
      id: "airing-soon-series",
      title: "Airing soon",
      subtitle: "next episodes of series you follow",
      rows: fromUpcoming(deps, "sonarr", 30),
    },
    {
      id: "airing-soon-movies",
      title: "Releasing soon",
      subtitle: "films in your library with a date",
      rows: fromUpcoming(deps, "radarr", 30),
    },
    {
      id: "coming-soon-movies",
      title: "Coming soon: Movies",
      rows: fromUpcoming(deps, "tmdb-movie", 30).filter((t) => !owned.has(t.tconst)),
    },
    {
      id: "coming-soon-series",
      title: "Coming soon: Series",
      rows: fromUpcoming(deps, "tmdb-series", 30).filter((t) => !owned.has(t.tconst)),
    },
    {
      id: "new-decade",
      title: "New this decade",
      browse: { decade: String(decadeOf(year)) },
      rows: engine.newThisDecade({ limit: 30, excludeTconsts: owned }),
    },
    // One row per genre that actually has enough good titles to fill a shelf.
    ...engine.topGenres(5).map((genre) => ({
      id: `genre-${genre.toLowerCase()}`,
      title: `Best in ${genre}`,
      browse: { genre },
      rows: engine.topRatedInGenre(genre, { limit: 30, excludeTconsts: owned }),
    })),
  ];
  return shelves.filter((shelf) => shelf.rows.length > 0);
}

/**
 * Every title on the front page, once.
 *
 * Shelves overlap heavily -- a well-reviewed horror film is on "top movies" and on "best
 * in Horror" -- and warming it twice would pay for the same upstream document twice while
 * telling the pacer to wait in between.
 */
export function frontPageTitles(shelves: DiscoveryShelf[]): TitleRow[] {
  return [...new Map(shelves.flatMap((s) => s.rows).map((row) => [row.tconst, row])).values()];
}

export interface ShelfCoverage {
  shelf: string;
  titles: number;
  warm: number;
}

/**
 * How much of each shelf is already warm -- "is it warm" measured rather than assumed.
 *
 * Takes the predicate rather than the resolver so it stays a counting function: what
 * "warm" means belongs to whoever owns the cache, not to the front page.
 */
export function facetCoverage(
  shelves: DiscoveryShelf[],
  isWarm: (row: TitleRow) => boolean,
): ShelfCoverage[] {
  return shelves.map((shelf) => ({
    shelf: shelf.id,
    titles: shelf.rows.length,
    warm: shelf.rows.filter(isWarm).length,
  }));
}
