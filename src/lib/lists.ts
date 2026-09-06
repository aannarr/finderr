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

import { AWARDS } from "./award-registry";
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
 * A list with its own route rather than a browse behind it.
 *
 * `award` is the route parameter `/awards/$award` takes, and it is the only destination a
 * curated list has today. It used to be a closed union of literal PATHS, which enforced
 * "navigable does not outrank honest" -- a row could not point at a route nobody served.
 * Deriving the rows from `AWARDS` enforces the same rule harder: there is no path to get
 * wrong, because the id that names the row is the id the route resolves.
 *
 * If a curated list ever exists that is NOT an award, this goes back to a discriminated
 * union with the destination on it. Inventing that union now would be one for a case that
 * does not exist.
 */
export interface CuratedList {
  id: string;
  title: string;
  subtitle?: string;
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
 * DERIVED from the award registry rather than typed out beside it, because the name and the
 * one-line description of an award are facts about the award and having them in two places
 * is how the second one goes stale. `/awards/$award` serves every id in it by construction,
 * so a row here cannot point at a route that does not resolve -- which is the dead end this
 * product refuses to draw, enforced by where the data comes from rather than by a test.
 *
 * `/lists` renders this array under its own heading and skips the heading entirely when it
 * is empty.
 */
export const CURATED: CuratedList[] = AWARDS.map((award) => ({
  id: award.id,
  title: award.title,
  subtitle: award.subtitle,
}));

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

/**
 * A language worth a list of its own: the code we filter on, and what to call it.
 *
 * The NAME is stored rather than derived from `Intl.DisplayNames`, and that is the same
 * editorial call `LIST_GENRES` makes. A list title is a title -- it is pinned by a test, it
 * must read the same on a server and in a browser, and `DisplayNames` answers from whatever
 * CLDR table the runtime happens to ship. Deriving it would put the name of a row on this
 * page at the mercy of an ICU upgrade.
 */
export interface ListLanguage {
  /** ISO 639-1, as `title_lang` stores it. */
  code: string;
  /** English name, for the row and the browse heading. */
  name: string;
}

/**
 * The languages worth a list, and what each one costs to draw.
 *
 * CLOSED and editorial, exactly like `LIST_GENRES` -- but unlike genres there is a second,
 * measured constraint, because every list here is one more ranked query inside the single
 * `/api/lists/completion` request. Measured 2026-09-06 through `SearchEngine.rankedMembers`
 * against a copy of the real 1,288,159-row index, milliseconds to resolve a full 250-title
 * membership: Hindi 2.9, Japanese 3.5, Tamil 4.4, French 4.5, Malayalam 5.9, Spanish 6.2,
 * Italian 6.3, Russian 6.5, German 6.9, Bengali 8.5, Korean 10.6, Portuguese 11.2.
 * **Twelve of them, totalling 77.4 ms** against 11.4 ms for the other twenty-one lists put
 * together in the same run -- see `completionPayload`, which owns that budget.
 *
 * The cost is set by how deep into the rank order a language's 250th film sits, so a language
 * with a THIN catalogue is the expensive one: measured on the same copy, Swedish is 45.5 ms
 * on its own, Chinese 62.9, Danish 70.1, Finnish 72.4. Those are the languages this list
 * leaves out -- not because nobody wants them, but because one of them costs as much as six
 * of these. Fixing that properly means denormalising `rank` into `title_lang` the way
 * `title_genre` already carries `votes` and `year`, which is its own card
 * (`language-lists-the-thin-tail-costs-more-than-the-dense-head-`) and not this one.
 *
 * **Chinese is the omission worth explaining, because its number is misleading.** `zh` reaches
 * only 298 ranked non-English films, not because the corpus lacks Chinese cinema but because
 * P364 records most of it under codes with no two-letter ISO 639-1 form, and `parseOriginCsv`
 * keeps only two-letter codes. Drawing a "Best films in Chinese" from a set we know is
 * undercounted by an order of magnitude would be a list that quietly misrepresents itself.
 */
export const LIST_LANGUAGES: readonly ListLanguage[] = [
  { code: "bn", name: "Bengali" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "hi", name: "Hindi" },
  { code: "it", name: "Italian" },
  { code: "ja", name: "Japanese" },
  { code: "ko", name: "Korean" },
  { code: "ml", name: "Malayalam" },
  { code: "pt", name: "Portuguese" },
  { code: "ru", name: "Russian" },
  { code: "es", name: "Spanish" },
  { code: "ta", name: "Tamil" },
];

/**
 * What a language list is called, for a code that has one.
 *
 * `undefined` for anything else, and the caller prints the raw code -- a browse can be
 * bookmarked with any two letters, and inventing a name for a language we do not offer a
 * list of would claim more than we know. ONE owner, so the row on `/lists` and the heading
 * on `/browse` cannot spell the same list two ways.
 */
export function listLanguageName(code: string | undefined): string | undefined {
  return LIST_LANGUAGES.find((l) => l.code === code)?.name;
}

/**
 * The id prefix each generated family of lists carries, spelled ONCE.
 *
 * `computedLists` builds the ids and `listGroups` matches them, so the two were already two
 * copies of `"genre-"` and `"decade-"`. A third family made that a pattern rather than a
 * coincidence, and a family whose prefix does not match its group renders NOWHERE while
 * still costing its query -- silently, because `listGroups` drops an empty group.
 *
 * > [!CAUTION] No prefix here may start with `top-250`
 * > `isAllTimeList` is a `startsWith` test with two readers, and the second one decides what
 * > the people boards on `/lists` rank over. An id that trips it would quietly change what
 * > "most-credited director" means.
 */
const LIST_PREFIX = {
  genre: "genre-",
  decade: "decade-",
  language: "lang-",
} as const;

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
      id: `${LIST_PREFIX.genre}${genre.toLowerCase()}`,
      title: `Best ${genre}`,
      filters: { kind: "movie", genre },
    })),
    ...listDecades(year).map((decade) => ({
      id: `${LIST_PREFIX.decade}${decade}`,
      title: `Best of the ${decade}s`,
      filters: { kind: "movie", decade },
    })),
    /*
      "Best films IN Korean" rather than "Best Korean films", and the preposition is the
      honest half of the sentence.

      What we hold is the film's original LANGUAGE, from Wikidata's P364. We do not hold
      where it was made, who paid for it, or whether it ever played in a cinema -- so a row
      claiming national cinema would be claiming a fact this index does not carry. Naming the
      language names exactly what the filter did.

      The English exclusion that makes these lists mean something is stated once, on the
      group, rather than thirteen times in thirteen subtitles -- see `listGroups`.
    */
    ...LIST_LANGUAGES.map((language) => ({
      id: `${LIST_PREFIX.language}${language.code}`,
      title: `Best films in ${language.name}`,
      filters: { kind: "movie", lang: language.code },
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
 * Compared on the FIVE filter keys rather than by deep equality, so a URL carrying an extra
 * param still resolves to its list, and a URL missing one does not. Every key a list can
 * carry has to be here: one left out would make `/browse?lang=ko&kind=movie&sort=rank`
 * resolve to `finderr Top 250` and print that list's completion under a language heading.
 */
export function listForFilters(year: number, filters: BrowseFilters): ComputedList | undefined {
  return computedLists(year).find(
    (l) =>
      l.filters.kind === filters.kind &&
      l.filters.genre === filters.genre &&
      l.filters.decade === filters.decade &&
      l.filters.year === filters.year &&
      l.filters.lang === filters.lang,
  );
}

/**
 * Is this the ranked head of the whole index, rather than a slice of it?
 *
 * The `All time` group, in one predicate, because a third reader appeared: the people boards
 * on `/lists` rank who turns up most across exactly these lists, and the completion payload
 * already resolves their membership on the way past. Two places spelling `startsWith("top-250")`
 * would drift the day a third all-time list is added.
 */
export function isAllTimeList(list: ComputedList): boolean {
  return list.id.startsWith("top-250");
}

/** The four groups `/lists` draws, so the route holds no membership rules of its own. */
export interface ListGroup {
  heading: string;
  blurb?: string;
  lists: ComputedList[];
  /**
   * Draw a row only once the server has confirmed the list has members.
   *
   * OFF for genre and decade, and that asymmetry is deliberate rather than an oversight.
   * Genre and decade are properties every index this product has ever built carries, so
   * those rows are always substantiable and drawing them before the completion payload lands
   * is what keeps `/lists` complete on first paint. LANGUAGE arrived in a build stage that
   * indexes in the field predate: on one of those `title_lang` does not exist, the membership
   * query returns nothing, and a row drawn anyway would be a link to a page reading "Nothing
   * matches that" under the heading "Best films in Korean".
   *
   * The signal is the completion the page already fetches -- a list with no members is
   * omitted from it (see `completionPayload`) -- so this costs no extra request and no
   * capability flag. Degrading to NOTHING rather than to an empty product is the rule the
   * card that built these lists set, and this is where it is enforced.
   */
  requiresMembers?: boolean;
}

export function listGroups(year: number): ListGroup[] {
  const all = computedLists(year);
  const of = (prefix: string) => all.filter((l) => l.id.startsWith(prefix));
  return [
    {
      heading: "All time",
      blurb: "Every title in the index, weighted by its rating and how many people voted.",
      lists: all.filter(isAllTimeList),
    },
    { heading: "By genre", lists: of(LIST_PREFIX.genre) },
    { heading: "By decade", lists: of(LIST_PREFIX.decade) },
    {
      heading: "By language",
      // The English exclusion, stated ONCE for the whole group. It is the rule that makes
      // every row here mean what its name says, and a reader who does not know it would
      // reasonably wonder why a film they think of as Japanese is missing.
      blurb:
        "Films in one language and not also in English, so a mostly-English film with a few " +
        "subtitled scenes is not in them. Original language as Wikidata records it -- where a " +
        "film was made is a different question, and not one this index can answer.",
      lists: of(LIST_PREFIX.language),
      requiresMembers: true,
    },
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
