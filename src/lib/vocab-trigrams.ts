/**
 * The trigram shortlist that runs BESIDE spellfix1's phonetic one.
 *
 * ## The bug this exists to end
 *
 * spellfix1 shortlists candidates by scanning every vocabulary word whose phonetic hash
 * shares the query's first `scope` hash characters -- three by default in the vendored
 * source (`x.iScope = 3` in `spellfix1FilterForMatch`), whatever the docs say. A typo that
 * perturbs one of those three characters moves the word into a different bucket, and no
 * amount of `top` reaches it: `andrenochrome` hashes to `AMDRMACRMA` against
 * `adrenochrome`'s `ADRMACRMA`, one edit apart and absent from every candidate.
 *
 * The shipped answer to that (`b104030`) was to retry at `scope = 1` when the first pass
 * found nothing within the distance floor. Measured on 2026-09-06 against the real
 * 257,764-word vocabulary with 2,000 generated single- and double-typo queries
 * (`.claude/docs/2026-09-06-fuzzy-shortlist-strategies.md` has every number), that shape
 * has two defects that compound:
 *
 * - **`scope = 1` is not accurate either.** It finds 71.0% of front-of-word single typos,
 *   because a typo in the FIRST letter changes the first hash character too, and then the
 *   whole scan is in the wrong bucket. It costs 99-119 ms on an M1 Max for that.
 * - **The retry rarely fires.** It runs only when the first pass returns NOTHING within the
 *   floor, and in 99 of 400 front-typo cases the first pass returns some other word within
 *   the floor -- a neighbour in the right bucket that is not the title the reader meant.
 *   The chain stops there. End to end, the shipped shape finds **74.2%** of the generated
 *   typos the floor would allow; a union of the same two passes would find 84.5%.
 *
 * ## What this is
 *
 * An FTS5 table over the SAME vocabulary words with the built-in `trigram` tokenizer, and a
 * tiny table of document frequencies beside it. A query is split into trigrams, the
 * **eight rarest** (by document frequency) are OR-ed together, FTS5's own `bm25` ranks the
 * matching words, and the top 300 are handed to `spellfix1_editdist` -- the identical
 * distance the phonetic pass reports, so the 300 floor means the same thing on both paths.
 *
 * Rarest-eight is the whole of the cost control, and it is measured: all trigrams cost
 * 22-33 ms because `the`, ` th`, `ing` each have 13,000-26,000 postings to merge and score;
 * the eight rarest cost **7 ms** and lose 0.0-1.5 points of recall (99.8 / 98.8 / 100 /
 * 87.6 / 93.2 across the five typo classes against 99.8 / 98.8 / 100 / 89.1 / 94.0 for all
 * of them). A trigram no vocabulary word contains has a frequency of zero, matches nothing,
 * and is dropped before the eight are chosen rather than wasting a slot.
 *
 * The two shortlists are UNIONED, always -- never chained. That is the finding above: the
 * trigram pass alone beats `scope = 3` on every class, and the union is what turns 74.2%
 * into the high nineties. It costs the trigram lookup on every fuzzy query, roughly 7 ms
 * here and ~25 ms on the deployment's Celeron, in exchange for never running the 100 ms+
 * wide scan at all.
 *
 * ## What it costs in the file
 *
 * Contentless (`content=''`): the words already live in the spellfix1 table and are joined
 * back by rowid, so storing them twice bought nothing. About 17 MB on the real vocabulary,
 * against 22 MB for the spellfix1 tables it sits beside. Built in under two seconds.
 *
 * Additive and optional, like every other stage: `SearchEngine.hasTrigrams` probes for the
 * tables at construction and an index built before them keeps the shipped two-pass shape.
 * `INDEX_STAGES.vocab` orders the rebuild at the next boot.
 */

import type { Database } from "bun:sqlite";
import { SPELLFIX_TABLE } from "./spellfix";

/** The FTS5 trigram table over the vocabulary. Rowids are the spellfix1 vocabulary rowids. */
export const TRIGRAM_TABLE = "vocab_tri";

/** `tri -> how many vocabulary words contain it`, read once per query trigram. */
export const TRIGRAM_DF_TABLE = "vocab_tri_df";

/**
 * How many of the query's trigrams, rarest first, are OR-ed into the FTS5 match.
 *
 * Eight is measured, not chosen -- see the module doc. Six lost 12 points on double typos;
 * all of them cost 3-5x for at most 1.5 points.
 */
export const TRIGRAM_KEEP = 8;

/** Distinct trigrams of `text`, in order of first appearance. */
export function trigramsOf(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i + 3 <= text.length; i++) {
    const g = text.slice(i, i + 3);
    if (seen.has(g)) continue;
    seen.add(g);
    out.push(g);
  }
  return out;
}

/**
 * The `keep` rarest of `grams` under `dfOf`, dropping any the vocabulary never contains.
 *
 * Stable on ties (first appearance wins), so two runs over one query choose the same set
 * and the canary cannot flap on a sort order.
 */
export function rarestTrigrams(
  grams: readonly string[],
  dfOf: (g: string) => number,
  keep = TRIGRAM_KEEP,
): string[] {
  return grams
    .map((g, i) => ({ g, n: dfOf(g), i }))
    .filter((x) => x.n > 0)
    .sort((a, b) => a.n - b.n || a.i - b.i)
    .slice(0, keep)
    .map((x) => x.g);
}

/**
 * An FTS5 MATCH expression OR-ing the given trigrams.
 *
 * Each is a double-quoted string so a space or a digit inside it is part of the token
 * rather than syntax -- `"he "` is one trigram to the tokenizer. A double quote cannot
 * occur (the vocabulary is `[a-z0-9 ]`) but is escaped anyway, because a query string is
 * the one place this repo has been bitten by "cannot occur".
 */
export function trigramMatchExpr(grams: readonly string[]): string {
  return grams.map((g) => `"${g.replace(/"/g, '""')}"`).join(" OR ");
}

/**
 * The shortlist query: vocabulary rowids ranked by bm25 over the chosen trigrams.
 *
 * Exported as SQL text rather than run here so the engine can embed it as a subquery and
 * compute the distance in the same statement, while a test can run it alone against an
 * FTS5 fixture with no extension loaded.
 */
export function trigramShortlistSql(): string {
  return `select rowid as id from ${TRIGRAM_TABLE} where ${TRIGRAM_TABLE} match ?1 order by rank limit ?2`;
}

/**
 * Build both tables from whatever `SPELLFIX_TABLE` currently holds.
 *
 * Reads through the vocabulary's own `rowid, word` so the rowids line up with `vocab_map`
 * by construction. Contentless: the words are never read back from here. The `optimize`
 * merges the segments a bulk insert leaves behind into one, which is what makes the
 * posting-list merges at query time cheap.
 */
export function buildVocabTrigrams(db: Database, log: (m: string) => void): { words: number; grams: number } {
  const t0 = Date.now();
  db.run(`drop table if exists ${TRIGRAM_TABLE}`);
  db.run(`drop table if exists ${TRIGRAM_DF_TABLE}`);
  db.run(`create virtual table ${TRIGRAM_TABLE} using fts5(word, tokenize='trigram', content='')`);
  db.run(`insert into ${TRIGRAM_TABLE}(rowid, word) select rowid, word from ${SPELLFIX_TABLE}`);
  db.run(`insert into ${TRIGRAM_TABLE}(${TRIGRAM_TABLE}) values ('optimize')`);

  // Document frequencies, read out of FTS5's own vocabulary view and materialised: the
  // engine asks for ~11 of them per query and a plain `without rowid` seek is the cheapest
  // form of that question.
  db.run(`create virtual table temp.vocab_tri_v using fts5vocab(main, '${TRIGRAM_TABLE}', 'row')`);
  db.run(`create table ${TRIGRAM_DF_TABLE} (tri text primary key, n integer not null) without rowid`);
  db.run(`insert into ${TRIGRAM_DF_TABLE} (tri, n) select term, doc from temp.vocab_tri_v`);
  db.run("drop table temp.vocab_tri_v");

  const words = (db.query(`select count(*) c from ${SPELLFIX_TABLE}`).get() as { c: number }).c;
  const grams = (db.query(`select count(*) c from ${TRIGRAM_DF_TABLE}`).get() as { c: number }).c;
  log(
    `vocabulary trigrams: ${words.toLocaleString()} words, ${grams.toLocaleString()} distinct trigrams ` +
      `in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
  return { words, grams };
}
