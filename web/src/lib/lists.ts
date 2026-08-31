/**
 * The catalogue of lists finderr can show, and nothing about how they are drawn.
 *
 * A LIST is a named ordering with somewhere to go. There are two kinds and the difference
 * is where the membership comes from, which is why they are two arrays rather than one
 * with a `kind` field to switch on:
 *
 * - **COMPUTED** -- a query over the index, ordered by the weighted `rank` column the
 *   build wrote. It has no stored membership at all: "finderr Top 250" is a filter and a
 *   sort, so it costs nothing to add one and it cannot go stale.
 * - **CURATED** -- an explicit membership somebody or something maintains, living at its
 *   own route with its own screens. Empty here on purpose; see below.
 *
 * Pure data and pure functions, deliberately -- no React, no fetch. The whole catalogue is
 * derivable, so a test can assert every list resolves to a real filter without rendering
 * anything.
 */

/** A row on `/lists`: what to call it, and the browse it resolves to. */
export interface ComputedList {
  id: string;
  title: string;
  subtitle?: string;
  /** Search params for `/browse`. Always carries `sort: "rank"` -- that is what makes it a list. */
  search: Record<string, string>;
}

/** A list with its own route rather than a browse behind it. */
export interface CuratedList {
  id: string;
  title: string;
  subtitle?: string;
  /** Its own path. Same-origin and absolute, e.g. `/awards/oscars`. */
  to: string;
}

/**
 * Lists with an explicit membership and their own screens.
 *
 * **EMPTY, AND ADDING ONE IS ONE OBJECT HERE AND NO OTHER EDIT.** `/lists` renders this
 * array under its own heading and skips the heading entirely when it is empty, so a
 * curated list appears the moment its route is real -- and not one commit before. A row
 * pointing at a route that does not resolve yet is precisely the dead end this product
 * refuses to draw: navigable does not outrank honest.
 */
export const CURATED: CuratedList[] = [];

/**
 * The genres worth a list of their own.
 *
 * A CLOSED list rather than every genre in `title_genre`, and that is an editorial call:
 * IMDb's vocabulary includes `Short`, `News`, `Talk-Show` and `Adult`, and "the best
 * talk-shows of all time" is a list nobody is looking for. These twelve are the ones with
 * both enough titles to rank and a reader who wants the ranking.
 *
 * It is not derived from the index on purpose -- deriving it would put a genre on the page
 * the first time the corpus drifted, with no chance to look at it first.
 */
export const LIST_GENRES = [
  "Action",
  "Adventure",
  "Animation",
  "Comedy",
  "Crime",
  "Documentary",
  "Drama",
  "Fantasy",
  "Horror",
  "Mystery",
  "Sci-Fi",
  "Thriller",
] as const;

/** How many decades back to offer, from the current one. */
const DECADES_BACK = 7;

/**
 * The decade each list covers, newest first.
 *
 * Takes the year rather than reading the clock, so a test pins it instead of going red in
 * January. Same rule `discoveryShelves` follows with its injected `now`.
 */
export function listDecades(year: number, back = DECADES_BACK): number[] {
  const current = Math.floor(year / 10) * 10;
  return Array.from({ length: back }, (_, i) => current - i * 10);
}

/**
 * Every computed list, in the order `/lists` renders them.
 *
 * **`kind: "movie"` is pinned on every one of them and that is not laziness.** Films and
 * series are rated by different crowds at different volumes, so a mixed list has no honest
 * title -- the series take the head and "the best films of the 2010s" quietly stops being
 * about films. Series get their own list rather than being blended into everyone else's.
 */
export function computedLists(year: number): ComputedList[] {
  return [
    {
      id: "top-250",
      title: "finderr Top 250",
      subtitle: "the highest weighted rating in the index",
      search: { sort: "rank", kind: "movie" },
    },
    {
      id: "top-250-series",
      title: "finderr Top 250: Series",
      subtitle: "ranked separately, because they are rated separately",
      search: { sort: "rank", kind: "tvSeries" },
    },
    ...LIST_GENRES.map((genre) => ({
      id: `genre-${genre.toLowerCase()}`,
      title: `Best ${genre}`,
      search: { sort: "rank", kind: "movie", genre },
    })),
    ...listDecades(year).map((decade) => ({
      id: `decade-${decade}`,
      title: `Best of the ${decade}s`,
      search: { sort: "rank", kind: "movie", decade: String(decade) },
    })),
  ];
}

/** The three groups `/lists` draws, so the route holds no membership rules of its own. */
export interface ListGroup {
  heading: string;
  blurb?: string;
  lists: ComputedList[];
}

export function listGroups(year: number): ListGroup[] {
  const all = computedLists(year);
  const of = (prefix: string) => all.filter((l) => l.id.startsWith(prefix));
  return [
    {
      heading: "All time",
      blurb: "Every title in the index, weighted by its rating and how many people voted.",
      lists: all.filter((l) => l.id.startsWith("top-250")),
    },
    { heading: "By genre", lists: of("genre-") },
    { heading: "By decade", lists: of("decade-") },
  ].filter((g) => g.lists.length > 0);
}

/**
 * How a computed list is ranked, said in one sentence the page can print.
 *
 * **The disclaimer is not decoration.** The rank reproduces IMDb's Top 250 head almost
 * exactly and will never match it, because IMDb's vote filtering is unpublished -- so
 * every surface that shows one of these has to say whose list it is. It is written once,
 * here, rather than retyped per list.
 */
export const RANK_EXPLAINER =
  "Ranked by rating weighted against vote count, so a 9.5 from twelve people does not " +
  "outrank a 9.0 from three million. finderr's own list -- not IMDb's.";
