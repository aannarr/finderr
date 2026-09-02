/**
 * The stopword vocabulary, and the cheap answer for a query made of nothing else.
 *
 * ## Why this is its own module
 *
 * The stopword set had one owner (`search.ts`) and the query path was the only thing that
 * cared. It now has a SECOND consumer that must agree with it exactly -- the index builder,
 * which creates the partial index this query seeks. `index-builder.ts` importing `search.ts`
 * would pull `SearchEngine` and spellfix into the build job for one `Set` and one string, so
 * the shared vocabulary moved down here instead and both sides import it.
 *
 * ## The bug this is the fix for, measured 2026-09-02 on the live deployment
 *
 * `matchExpr` dropped stopwords whenever a meaningful token survived beside them -- but a
 * query that was NOTHING BUT stopwords fell into an escape hatch that put them back, WITH
 * the FTS prefix star. `?q=the` therefore ran `"the"*`, which matches **234,192 of the
 * 1,275,906 indexed titles**, joined every one of them to `title` and sorted the lot:
 *
 *   - 1033ms server-side on the NAS, 598ms on a Mac SSD
 *   - and `bun:sqlite` is SYNCHRONOUS, so that second was a second in which the whole
 *     process served nobody. `/api/health` measured 90ms -> 981ms alongside one such query.
 *
 * The comment above the old set already said `"the"*` "cost 1138ms". It was right, and the
 * escape hatch underneath it re-introduced exactly that cost for the one query shape where
 * nothing else could pay it back.
 *
 * ## Why the answer is a prefix match on the popular slice
 *
 * A stopword-only query carries almost no information, so there is no clever ranking to do
 * -- the honest answer to "the" is the most popular titles CALLED "The ...". That is also
 * what a reader means: nobody typing `the` wants a bm25 ranking of the quarter of the corpus
 * containing the word somewhere.
 *
 * Note that the FTS path could not have produced this answer anyway. `ntitle` has leading
 * articles STRIPPED at build time -- "The Matrix" is stored as `matrix` -- so the normalised
 * columns carry no signal for a leading article at all.
 *
 * ## The vote floor is what makes it bounded, and the index is what makes it fast
 *
 * Ordering by votes and taking the first 400 matches is NOT uniformly cheap: `the` is dense
 * among popular titles and costs 1.3ms, but `of`, `is` and `and` are sparse, so SQLite walks
 * far down `ix_votes` before collecting 400 and they cost ~1s -- no better than the bug.
 * Measured, after the obvious fix looked like it worked on the one word it was tried on.
 *
 * Flooring the scan is what removes the tail: it bounds the work to the popular slice
 * regardless of how rare the prefix is. Measured across the whole stopword set:
 *
 *   | strategy                          | median  | worst   |
 *   |-----------------------------------|---------|---------|
 *   | `"the"*` FTS (the bug)            |   n/a   | 1033ms  |
 *   | prefix seek, no floor             |   468ms | 1461ms  |
 *   | prefix seek + floor               |  51.8ms | 1461ms  |
 *   | + partial covering index          |   2.0ms |   2.4ms |
 *
 * The last row is `ix_pop_title` below and it is worth understanding, because the two words
 * are doing different jobs. **Covering**: `title` is a column OF the index, so the `like`
 * test is answered from the index pages and never fetches the row -- that fetch was almost
 * all of the 51.8ms. **Partial**: the `where` clause keeps only the ~24k rows above the
 * floor out of 1.27M, so the whole thing is 672 KB against a 551 MB index file and builds in
 * 2.1s. A full covering index on `(votes desc, title)` would serve the same query and cost
 * megabytes to store the 1.25M rows no stopword query will ever reach.
 */

/**
 * Words that carry no signal in a title search.
 *
 * English, German, French, Spanish, Swedish and Italian articles and prepositions -- the
 * languages the corpus actually contains in bulk. It is deliberately NOT generated from
 * term frequency: a data-driven list would sweep in words like "man" and "love" that are
 * common AND meaningful, and dropping those changes answers rather than only latency.
 */
export const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "and",
  "in",
  "on",
  "to",
  "is",
  "it",
  "for",
  "at",
  "by",
  "der",
  "die",
  "das",
  "den",
  "dem",
  "ein",
  "eine",
  "le",
  "la",
  "les",
  "un",
  "une",
  "des",
  "du",
  "el",
  "los",
  "las",
  "una",
  "och",
  "en",
  "ett",
  "som",
  "pa",
  "av",
  "det",
  "il",
  "lo",
  "gli",
  "di",
  "da",
  "che",
]);

/**
 * The popularity floor a stopword-only query is answered from.
 *
 * 5,000 votes is ~24k titles of the 1.27M indexed. Chosen as the point where the worst
 * stopword still returns something worth showing (`it` -> 20 rows, `a` -> 381) while the
 * scan stays bounded; 10,000 was measured too and halves the cost for a noticeably thinner
 * answer (`it` -> 10 rows, `of` -> 2).
 *
 * > [!IMPORTANT] Changing this REQUIRES an index rebuild, and nothing will fail if you forget
 * > It is compiled into `ix_pop_title`'s `where` clause. Raise it and the index no longer
 * > covers the range the query asks for; SQLite then quietly falls back to scanning
 * > `ix_votes`, which is correct and twenty times slower. That is why it is part of the
 * > `popularTitles` recipe in `index-stages.ts` -- so a boot notices instead of a human.
 */
export const STOPWORD_VOTE_FLOOR = 5000;

/**
 * The partial covering index, as ONE string both the builder and this module's reasoning
 * share -- so the floor in the DDL cannot drift from the floor in the query.
 */
export const POPULAR_TITLE_INDEX = `create index ix_pop_title on title(votes desc, title) where votes >= ${STOPWORD_VOTE_FLOOR}`;

/**
 * The tokens of a query that is nothing BUT stopwords, or `null` for every other query.
 *
 * `null` rather than an empty array so the caller branches on presence and cannot
 * accidentally treat "no stopwords here" as "an empty stopword query".
 *
 * The caller passes text that has already been through `normalize`, which is what makes the
 * result safe to interpolate into a `like` pattern downstream: every returned token is a
 * member of the closed set above, so no `%` or `_` can reach the pattern no matter what the
 * user typed.
 */
export function stopwordTokens(normalized: string): string[] | null {
  const tokens = normalized.split(" ").filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens.every((t) => STOPWORDS.has(t)) ? tokens : null;
}
