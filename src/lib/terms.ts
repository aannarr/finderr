/**
 * A TERM: something a title is tagged with that the title INDEX does not hold.
 *
 * A keyword, a streaming service, a studio or network. Three different upstream facts with
 * one shape in common -- each is a name attached to a title, and each lives in the app
 * database (`finderr.db`) rather than in `titles.db`. That is why they are one concept and
 * one module: browsing by any of them is the same question asked of the same file.
 *
 * ## Why this is not a `/browse` filter
 *
 * `browseIndex` narrows the title index in SQL, and the term data is in a DIFFERENT SQLITE
 * FILE -- so `?keyword=heist` could not become a WHERE clause even if `filtersOf` passed it
 * through. This is exactly the split `collectionTokenOf` already states for collections, and
 * the answer is the same one: a term is a NODE with a page, not a filter on the grid. The
 * card that ordered this work assumed a filter key; the two databases are why it is a route
 * instead, and `/collection/:id` is the shape it copies.
 *
 * ## Why there is no reverse-index TABLE
 *
 * There is nothing to write into one. `facet_contribution` already holds every keyword and
 * every streaming offer, indexed by `ix_facet_facet`, and `artwork.studio` already holds
 * every studio -- SQLite's own `json_each` reads them from the term end at no storage cost.
 * A second table would be a copy of knowledge whose only writer is the facet resolver, and
 * filling it for titles nobody has viewed would mean sweeping the index against the
 * providers, which is the one thing this codebase forbids outright.
 *
 * So COVERAGE is whatever the paced pre-warm and ordinary views have already cached, and it
 * grows on its own. A term with nowhere to go is drawn as plain text (`isTermLinkable`),
 * which is the dead-end rule doing its job rather than a shortfall to apologise for.
 *
 * ## No vote floor, on purpose
 *
 * `browseVoteFloor` curates the BROAD grid -- "every movie by votes" opening on titles
 * nobody has heard of. A term page is an explicit membership list assembled from what we
 * have actually cached, exactly like `/api/collection/:id`, so there is nothing to curate
 * and nothing to hide. The same answer for all three dimensions, which is what the card
 * asked for: one rule, not one per chip.
 *
 * NOTHING HERE TOUCHES THE NETWORK. Pure functions over rows a reader has already paid for.
 */

import { serviceKey } from "./watch-services";

/**
 * The dimensions a term can be in.
 *
 * A closed union rather than a free string: the value reaches a route parameter, and a
 * fourth dimension should be a deliberate edit here plus one reader, not whatever somebody
 * typed into a URL.
 */
export const TERM_DIMENSIONS = ["keyword", "service", "studio"] as const;

export type TermDimension = (typeof TERM_DIMENSIONS)[number];

export function isTermDimension(value: unknown): value is TermDimension {
  return typeof value === "string" && (TERM_DIMENSIONS as readonly string[]).includes(value);
}

/** One (title, raw term) pair, exactly as a reverse read hands it back. */
export interface TermPair {
  tconst: string;
  /** The upstream spelling, unfolded -- `Netflix Standard with Ads`, `Sci-Fi & Fantasy`. */
  term: string;
}

/**
 * A term, and everything a chip needs to decide whether it goes anywhere.
 *
 * `titles` is how many titles we could actually put in a grid, which is the ONLY input to
 * the dead-end rule -- so the decision is made from a number the server measured rather
 * than from a guess the browser makes about coverage.
 */
export interface Term {
  dimension: TermDimension;
  /** The URL segment. Folded, so every spelling of one term reaches one page. */
  key: string;
  /** What a reader sees. The most common spelling we hold. */
  label: string;
  titles: number;
}

/**
 * How many titles a term needs before it becomes a link.
 *
 * TWO, and the second one is the whole point. A keyword resolved for exactly one title is a
 * page containing the title you are already looking at -- navigable, honest, and completely
 * useless, which is the "dead-end link is worse than plain text" rule arriving one step
 * later than expected. One is the count a term has the instant it is first cached, so this
 * is also what stops every chip on a freshly-viewed film pretending to lead somewhere.
 */
export const MIN_TERM_TITLES = 2;

export function isTermLinkable(term: Term): boolean {
  return term.titles >= MIN_TERM_TITLES;
}

/**
 * The URL identity of one raw term.
 *
 * FOLDED, because two providers spell one thing two ways and a reader asking for "heist"
 * means the same page as one asking for "Heist". Each dimension folds by its own rule and
 * that is not an inconsistency: a streaming service has a 42-spelling mark table behind it
 * (`serviceKey`), while a keyword has nothing but its own text.
 *
 * The keyword and studio fold is deliberately SHALLOW -- case and whitespace only. Slugging
 * further (`&` to `-and-`, punctuation dropped) would merge terms that are genuinely
 * different, and the URL layer already knows how to escape a space; `/collection/:id`
 * carries a raw provider id through `encodeURIComponent` for the same reason.
 */
export function termKey(dimension: TermDimension, raw: string): string {
  if (dimension === "service") return serviceKey(raw);
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Every term these pairs describe, most-populated first.
 *
 * The LABEL is the most common spelling, ties broken alphabetically -- deterministic, and
 * it picks whichever spelling the corpus actually agrees on rather than whichever row
 * SQLite happened to return first. Same problem `namedBy` solves for a collection, with
 * frequency standing in for recency because a term has no resolution date of its own.
 */
export function termsOf(dimension: TermDimension, pairs: readonly TermPair[]): Term[] {
  return [...groupPairs(dimension, pairs).entries()]
    .map(([key, group]) => ({
      dimension,
      key,
      label: commonestSpelling(group.spellings),
      titles: group.tconsts.size,
    }))
    .sort((a, b) => b.titles - a.titles || a.label.localeCompare(b.label));
}

/**
 * One term and the titles we hold for it, or `null` for a key nothing names.
 *
 * `null` rather than an empty term, and the two are genuinely different answers: a term
 * nobody has cached has no page at all (a 404, like an unviewed collection), while a term
 * with members we cannot render is a page that says so.
 */
export function termPage(
  dimension: TermDimension,
  key: string,
  pairs: readonly TermPair[],
): { term: Term; tconsts: string[] } | null {
  const group = groupPairs(dimension, pairs).get(termKey(dimension, key));
  if (!group) return null;
  return {
    term: {
      dimension,
      key: termKey(dimension, key),
      label: commonestSpelling(group.spellings),
      titles: group.tconsts.size,
    },
    tconsts: [...group.tconsts],
  };
}

// --- internals -------------------------------------------------------------

/** What one folded key gathers: who has it, and every way it has been spelt. */
interface TermGroup {
  tconsts: Set<string>;
  /** Spelling -> how many pairs used it. Decides the label. */
  spellings: Map<string, number>;
}

/**
 * Fold the pairs onto their keys.
 *
 * A title is counted ONCE per term however many rows named it: two plugins can both
 * contribute `keywords` for one title (`servarr-metadata` for a film, `tmdb` for a series)
 * and `keywords` merges as a list with nothing deduplicating it, so counting rows rather
 * than titles would inflate exactly the number the dead-end rule is read off.
 */
function groupPairs(dimension: TermDimension, pairs: readonly TermPair[]): Map<string, TermGroup> {
  const byKey = new Map<string, TermGroup>();
  for (const pair of pairs) {
    const raw = pair.term.trim();
    if (raw === "") continue;
    const key = termKey(dimension, raw);
    if (key === "") continue;
    let group = byKey.get(key);
    if (!group) {
      group = { tconsts: new Set(), spellings: new Map() };
      byKey.set(key, group);
    }
    group.tconsts.add(pair.tconst);
    group.spellings.set(raw, (group.spellings.get(raw) ?? 0) + 1);
  }
  return byKey;
}

function commonestSpelling(spellings: ReadonlyMap<string, number>): string {
  let best = "";
  let bestCount = -1;
  for (const [spelling, count] of spellings) {
    if (count > bestCount || (count === bestCount && spelling.localeCompare(best) < 0)) {
      best = spelling;
      bestCount = count;
    }
  }
  return best;
}
