/**
 * The row every list in this product returns, and the ONE place its columns are named.
 *
 * > [!IMPORTANT] This module exists to hold two things that must agree and were eleven
 * > files apart
 * > `TitleRow` says what a row IS and `titleCols` says how to select one. They were an
 * > interface in `search.ts` and eleven hand-written copies of the same nine columns
 * > spread across `search.ts` and `people.ts` -- six bare and five `t.`-prefixed. Adding a
 * > column to that arrangement does not fail loudly: a site you miss returns a row whose
 * > new field is `undefined`, and that ONE surface silently draws nothing while every
 * > other one works. Keeping the shape beside the SELECT is what makes the next column
 * > arrive everywhere by construction.
 *
 * It is a module of its own rather than living in `search.ts` for a mechanical reason:
 * `search.ts` imports `personPage` from `people.ts` as a VALUE, so `people.ts` importing
 * `titleCols` back would close a runtime cycle where there is currently only a type edge.
 * Nothing here imports anything, so both can read it and neither waits on the other.
 * `search.ts` re-exports `TitleRow`, so the many `import type { TitleRow } from "./search"`
 * around the tree stay correct.
 */

export interface TitleRow {
  tconst: string;
  title: string;
  orig: string | null;
  year: number | null;
  kind: string;
  votes: number;
  rating: number;
  genres: string;
  runtime: number | null;
  /**
   * Comma-joined ISO 639-1 codes, sorted, or `null` when nothing knows.
   *
   * DISPLAY ONLY. Nothing filters on this -- the language FILTER is a semi-join against
   * the exploded `title_lang`, which is the shape a set-membership test wants, and this
   * is the shape a card wants. The asymmetry is deliberate and is argued at length in
   * `ORIGIN_SCHEMA`; do not collapse the two.
   *
   * **The NAME is made in the BROWSER, never stored** (`languageNames`,
   * `web/src/lib/facet-panes.ts`), so a Swedish reader sees "spanska" off the same `es`
   * an English reader sees "Spanish" for. Storing a name would pick one reader's language
   * at build time and be wrong for every other reader forever.
   *
   * **`null`, and never `UNKNOWN_LANG`.** The empty string is a storage device that makes
   * "unknown" a member of the filter's `in (...)` list; it is not a fact about the title,
   * and a card spelling out "unknown" is worse than one that says nothing. `loadOrigin`
   * writes this column only where it has a real code.
   *
   * It is also `null` for a second reason, and the two are indistinguishable on purpose:
   * an index built before this column existed reports `null` for every row, because
   * `titleCols` selects a literal. Both mean "draw no language here".
   */
  lang: string | null;
}

/**
 * The nine columns plus `lang`, prefixed for a join or bare for a plain `from title`.
 *
 * `hasLang` is `SearchEngine.hasTitleLang`, and the `null as lang` branch is the whole
 * reason this is a function rather than a constant. **The index a deploy MEETS is the one
 * the last refresh built**, so for up to a day after this ships the file on disk has no
 * such column -- and naming a column SQLite does not have is not slow, it is `no such
 * column` on every shelf, search, browse and filmography at once. The literal keeps that
 * file serving exactly as it always did, drawing no language until the rebuild lands.
 *
 * The alias is spelt out (`null as lang`) rather than left to SQLite to name, because an
 * unaliased literal comes back under the key `"null"` and every row would carry
 * `lang: undefined` -- the silent failure this module exists to prevent, reintroduced one
 * layer down.
 */
export function titleCols(hasLang: boolean, prefix = ""): string {
  const p = prefix;
  const lang = hasLang ? `${p}lang` : "null as lang";
  return `${p}tconst, ${p}title, ${p}orig, ${p}year, ${p}kind, ${p}votes, ${p}rating, ${p}genres, ${p}runtime, ${lang}`;
}
