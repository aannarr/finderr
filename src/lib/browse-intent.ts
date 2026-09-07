/**
 * Does a query DESCRIBE a shelf rather than NAME a title?
 *
 * "swedish crime drama", "new korean thrillers", "best 1980s horror films" are all questions
 * the title index cannot answer and `/browse` can: each names a language, a genre, a kind and
 * a period, and no title at all. Readers ask them in the search box anyway. The first real
 * search log (91 queries, reported 2026-09-08) has one reader asking for Swedish crime drama
 * twice -- once in Swedish, once in English, six clicks between them -- and settling for a
 * biopic about a long-distance swimmer, while the facet chips that answer exactly that
 * question went unclicked by all thirteen users in the log.
 *
 * So this reads a query for the vocabulary `/browse` already speaks and hands back the
 * filters, for the search page to OFFER as a link beside the results. It never changes what
 * search returns and never removes a word from what search matches on: the ranked hits are
 * untouched, and a reader who typed a title still gets their title.
 *
 * ## The rule that keeps it quiet: every word must be accounted for
 *
 * "True Romance" names the Romance genre and "Action Jackson" names Action, but both leave a
 * word over, so neither gets a suggestion -- and somebody typing a title is never told to go
 * and browse instead. It is the mirror of the year rule in `parseQuery`: a signal only counts
 * when what remains still makes sense.
 *
 * ## A word we cannot HONOUR blocks it as hard as a word we cannot read
 *
 * "old swedish crime" names a period `/browse` has no filter for, so it gets nothing, rather
 * than a list of Swedish crime from every decade with "old" quietly dropped. Handing a reader
 * the nearest plausible thing is the failure this whole card is about.
 */

import { LIST_GENRES, LIST_LANGUAGES } from "./lists";
import { normalize } from "./normalize";
import { parseQuery } from "./query-parser";
import { STOPWORDS } from "./search-stopwords";

/** The filters a described shelf turns into -- the `/browse` params, and nothing else. */
export interface BrowseIntent {
  /** A `LIST_GENRES` value, spelled as `title_genre` stores it. */
  genre?: string;
  /** ISO 639-1, as `title_lang` stores it. */
  lang?: string;
  kind?: string;
  decade?: number;
  year?: number;
}

/**
 * `"comedy"` -> `"comedies"`, `"drama"` -> `"dramas"`.
 *
 * The `y` -> `ies` branch is not decoration: it covers every irregular plural in
 * `LIST_GENRES` at once -- comedies, documentaries, mysteries, fantasies -- which is why no
 * alias table has to name them. Forms nobody types ("crimes", "sci fis") are generated too
 * and cost nothing: an unused key in a lookup map is not a wrong answer.
 */
function pluralOf(word: string): string {
  return word.endsWith("y") ? `${word.slice(0, -1)}ies` : `${word}s`;
}

/**
 * Spellings of a genre that are not its name and not a plural of its name.
 *
 * Only `Sci-Fi` needs one, and only for the two forms `normalize` cannot reach: it folds
 * `Sci-Fi` to `sci fi`, so the hyphen is already handled and the run-together and
 * written-out spellings are what is left.
 */
const GENRE_ALIASES: Readonly<Record<string, string>> = {
  scifi: "Sci-Fi",
  "science fiction": "Sci-Fi",
};

/** Every word that names a genre -> the `LIST_GENRES` value it names. */
const GENRE_BY_WORD: ReadonlyMap<string, string> = (() => {
  const out = new Map<string, string>();
  for (const genre of LIST_GENRES) {
    const word = normalize(genre);
    out.set(word, genre);
    out.set(pluralOf(word), genre);
  }
  for (const [alias, genre] of Object.entries(GENRE_ALIASES)) out.set(alias, genre);
  return out;
})();

/** Every word that names a language -> its ISO 639-1 code. */
const LANG_BY_WORD: ReadonlyMap<string, string> = new Map(
  LIST_LANGUAGES.map((l) => [normalize(l.name), l.code]),
);

/**
 * Words asking for something recent.
 *
 * `/browse` filters by period and orders by rank; it has no "newest first". So the honest
 * reading of "new" is the decade we are in -- coarse, but it is the closest thing the browse
 * vocabulary has, and the reader SEES it: the suggestion says "from the 2020s" and the
 * heading it lands on says it again, so a reader who meant something narrower can drop the
 * chip. Silently ignoring the word is the option this rejects.
 */
const RECENCY_WORDS = new Set(["new", "newest", "latest", "recent", "current"]);

/**
 * Words asking for the best of something, which is the list we are already offering.
 *
 * The suggestion always links to the RANKED browse, so these constrain nothing and may be
 * skipped. They are listed rather than ignored-by-default because the whole point of the
 * accounting rule above is that an unlisted word stops the suggestion.
 */
const RANKING_WORDS = new Set(["best", "top", "greatest", "finest", "good", "great"]);

type WordKind = "genre" | "language" | "recency" | "ignorable";

function classify(word: string): WordKind | null {
  if (GENRE_BY_WORD.has(word)) return "genre";
  if (LANG_BY_WORD.has(word)) return "language";
  if (RECENCY_WORDS.has(word)) return "recency";
  // `STOPWORDS` rather than a second list of articles: "the best of swedish crime" is the
  // same sentence as "swedish crime" to a search that already drops those words.
  if (RANKING_WORDS.has(word) || STOPWORDS.has(word)) return "ignorable";
  return null;
}

/**
 * The decade a year falls in.
 *
 * A fourth spelling of one line, for the reason `web/src/lib/search-params.ts` gives beside
 * its own copy: the owner is in `search.ts`, and this module is bundled into the browser, so
 * importing it would drag `bun:sqlite` in with it.
 */
function decadeOf(year: number): number {
  return Math.floor(year / 10) * 10;
}

/**
 * The shelf this query describes, or `null` if it does not describe one.
 *
 * `now` is injected so the recency words resolve against a clock the caller owns rather than
 * against whatever day the test happens to run on.
 */
export function browseIntentOf(raw: string, now: Date = new Date()): BrowseIntent | null {
  // `parseQuery` already owns the year, the decade, the kind and the release junk. Reading
  // what it left means this module holds ONLY the two vocabularies that one does not have.
  const parsed = parseQuery(raw);
  const intent: BrowseIntent = {};
  if (parsed.kind) intent.kind = parsed.kind;
  if (parsed.year !== undefined) intent.year = parsed.year;
  else if (parsed.decade !== undefined) intent.decade = parsed.decade;

  /** A genre or a language: without one of the two, nothing here is a shelf question. */
  let describesAShelf = false;

  const tokens = normalize(parsed.text).split(" ").filter(Boolean);
  for (let i = 0; i < tokens.length; ) {
    // Two-word names first. "science fiction" and "serbo croatian" are one word to a reader,
    // and taking "fiction" alone would leave "science" unaccounted for and kill the whole
    // suggestion.
    const pair = i + 1 < tokens.length ? `${tokens[i]} ${tokens[i + 1]}` : null;
    const width = pair !== null && classify(pair) !== null ? 2 : 1;
    const word = width === 2 ? (pair as string) : tokens[i];

    switch (classify(word)) {
      case "genre":
        // The FIRST genre wins. English puts the qualifier first -- "crime drama", "action
        // comedy", "horror comedy" -- and the qualifier is the half that discriminates;
        // browsing the head noun would land on Drama, which is a third of the corpus.
        if (intent.genre === undefined) intent.genre = GENRE_BY_WORD.get(word);
        describesAShelf = true;
        break;
      case "language":
        if (intent.lang === undefined) intent.lang = LANG_BY_WORD.get(word);
        describesAShelf = true;
        break;
      case "recency":
        // An explicit year or decade in the query is more specific than "new", so it wins.
        if (intent.year === undefined && intent.decade === undefined) {
          intent.decade = decadeOf(now.getUTCFullYear());
        }
        break;
      case "ignorable":
        break;
      default:
        return null;
    }
    i += width;
  }

  return describesAShelf ? intent : null;
}
