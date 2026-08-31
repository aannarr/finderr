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
 * finderr can offer shelves Seerr structurally cannot, like "hidden gems".
 */

import { decadeOf, type SearchEngine, type TitleRow } from "../lib/search";
import type { Store } from "../lib/store";

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
    "topRated" | "hiddenGems" | "anticipated" | "newThisDecade" | "topGenres" | "topRatedInGenre" | "byTconst"
  >;
  store: Pick<Store, "libraryMap" | "recentlyAddedIds">;
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
    {
      id: "top-movies",
      title: "Highly rated, not in your library",
      browse: { kind: "movie" },
      rows: engine.topRated({ kind: "movie", limit: 30, excludeTconsts: owned }),
    },
    {
      id: "hidden-gems",
      title: "Hidden gems",
      subtitle: "loved by the few who found them",
      rows: engine.hiddenGems({ limit: 30 }).filter((t) => !owned.has(t.tconst)),
    },
    {
      id: "top-series",
      title: "Series worth starting",
      browse: { kind: "tvSeries" },
      rows: engine.topRated({ kind: "tvSeries", minVotes: 20_000, limit: 30, excludeTconsts: owned }),
    },
    {
      id: "coming-soon",
      title: "Coming soon",
      subtitle: "this year and later, soonest first",
      rows: engine.anticipated(30),
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
