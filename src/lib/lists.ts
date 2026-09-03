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
 *   own route with its own screens.
 *
 * Pure data and pure functions, deliberately -- no React, no fetch, no SQLite. The whole
 * catalogue is derivable, so a test can assert every list resolves to a real filter without
 * rendering anything.
 *
 * > [!IMPORTANT] It lives in `src/lib` and not in `web/src/lib`, and the completion count is
 * > why. "You own 178 of 250" needs the list's FILTERS on the server -- that is where the
 * > index and the library mirror both are -- and the browser needs the same filters to draw
 * > the link. Two copies of the catalogue would drift on the first list anybody adds, so
 * > there is one, here, and `web` imports it exactly as it already imports `VERDICT_COPY`.
 */

import type { BrowseFilters } from "./search";

/**
 * The slice of the index a computed list ranks.
 *
 * `BrowseFilters` with `kind` promoted to REQUIRED, which is the one rule this shape adds
 * over a generic browse: films and series are rated by different crowds at different
 * volumes, so a mixed list has no honest title -- the series take the head and "the best
 * films of the 2010s" quietly stops being about films. The type says so, so a new list
 * cannot forget.
 */
export interface ListFilters extends BrowseFilters {
  kind: string;
}

/** A row on `/lists`: what to call it, and the slice of the index it ranks. */
export interface ComputedList {
  id: string;
  title: string;
  subtitle?: string;
  filters: ListFilters;
}

/**
 * Where a curated list lives -- a CLOSED union of paths this app actually serves.
 *
 * A literal type rather than `string`, because "navigable does not outrank honest" is the
 * rule this row exists under and a type can enforce it where a test could only notice. It
 * also lets `/lists` hand the value straight to a typed `<Link>`: a bare `string` would need
 * a cast, which is the same wrong answer with the compiler talked out of mentioning it.
 *
 * Adding a curated list means adding its route AND its path here, in that order.
 */
export type CuratedPath = "/awards/oscars";

/** A list with its own route rather than a browse behind it. */
export interface CuratedList {
  id: string;
  title: string;
  subtitle?: string;
  to: CuratedPath;
}

/**
 * How many titles of a computed list are its LIST, as opposed to the tail behind it.
 *
 * A ranked browse pages on forever -- "best horror" has tens of thousands of members -- so
 * completion needs a denominator that means something, and "you own 178 of 43,912" means
 * nothing at all. 250 because that is the number already in the name of the headline list
 * and the length everybody reading a top list expects.
 *
 * It is the denominator AND the size of the membership query, in one constant, so the
 * sentence on screen and the set it counts can never name different numbers.
 */
export const LIST_SIZE = 250;

/**
 * Lists with an explicit membership and their own screens.
 *
 * `/lists` renders this array under its own heading and skips the heading entirely when it
 * is empty, so a curated list appears the moment its route is real -- and not one commit
 * before. A row pointing at a route that does not resolve yet is precisely the dead end
 * this product refuses to draw: navigable does not outrank honest, and `CuratedPath` is
 * that rule made unwriteable rather than merely tested.
 */
export const CURATED: CuratedList[] = [
  {
    id: "oscars",
    title: "The Academy Awards",
    subtitle: "98 ceremonies, every nomination since 1929",
    to: "/awards/oscars",
  },
];

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
 * `kind` is pinned on every one of them -- see `ListFilters` for why that is a type rule
 * rather than a habit. Series get their own list rather than being blended into everyone
 * else's.
 */
export function computedLists(year: number): ComputedList[] {
  return [
    {
      id: "top-250",
      title: "finderr Top 250",
      subtitle: "the highest weighted rating in the index",
      filters: { kind: "movie" },
    },
    {
      id: "top-250-series",
      title: "finderr Top 250: Series",
      subtitle: "ranked separately, because they are rated separately",
      filters: { kind: "tvSeries" },
    },
    ...LIST_GENRES.map((genre) => ({
      id: `genre-${genre.toLowerCase()}`,
      title: `Best ${genre}`,
      filters: { kind: "movie", genre },
    })),
    ...listDecades(year).map((decade) => ({
      id: `decade-${decade}`,
      title: `Best of the ${decade}s`,
      filters: { kind: "movie", decade },
    })),
  ];
}

/**
 * The computed list a set of browse filters IS, or undefined for an ordinary grid.
 *
 * `/browse?genre=Horror&kind=movie&sort=rank` is not merely a filtered grid -- it is the
 * page "Best Horror" links to, so it is that list and should say what you own of it. This
 * is the reverse of `computedLists`, and it lives beside it for that reason: one file knows
 * what a list's filters are, in both directions.
 *
 * Compared on the FOUR filter keys rather than by deep equality, so a URL carrying an extra
 * param still resolves to its list, and a URL missing one does not.
 */
export function listForFilters(year: number, filters: BrowseFilters): ComputedList | undefined {
  return computedLists(year).find(
    (l) =>
      l.filters.kind === filters.kind &&
      l.filters.genre === filters.genre &&
      l.filters.decade === filters.decade &&
      l.filters.year === filters.year,
  );
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
 * What to call the things in a list -- "films", "series".
 *
 * One owner, because two surfaces spell it: the browse heading ("best horror films from
 * the 1980s") and the completion sentence ("you own 178 of 250 films"). An unknown kind
 * prints itself rather than being mapped to a wrong noun, and no kind at all is "titles",
 * which is the only word true of a mixed set.
 */
const KIND_NOUN: Record<string, string> = {
  movie: "films",
  tvSeries: "series",
  tvMiniSeries: "mini-series",
  tvMovie: "TV films",
};

export function kindNoun(kind: string | undefined): string {
  if (!kind) return "titles";
  return KIND_NOUN[kind] ?? kind;
}

/**
 * What a completion count is counting -- "top-ranked films".
 *
 * The qualifier is not decoration. A ranked `/browse` pages far past `LIST_SIZE` and prints
 * its own "60 of 43,912" beside this sentence, so "you own 178 of 250 films" on the same
 * screen invites the reader to wonder which 250. "Of 250 top-ranked films" says it: the
 * denominator is the head of the list, not the slice behind it.
 *
 * One owner, because `/lists` and `/browse` both print it and a page that phrased it its own
 * way would be a second claim about what was counted.
 */
export function completionNoun(kind: string | undefined): string {
  return `top-ranked ${kindNoun(kind)}`;
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
