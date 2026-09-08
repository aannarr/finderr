/**
 * What an index FILE can actually do, asked of the file rather than of its stamp.
 *
 * ## Three questions, and this file owns the third
 *
 * `./index-stages.ts` asks **"is this index current for the configuration in front of me?"**
 * and answers it from a stamp the build wrote. `SearchEngine` asks **"can I read this?"** and
 * answers it from the schema, so an older file keeps serving instead of throwing `no such
 * table`. Neither of them can answer the third question, which is **"is the file about to
 * replace the live one as capable as the one it replaces?"**
 *
 * ## The bug this exists to end
 *
 * On 2026-09-07 a Mac build promoted an index with NO spellfix vocabulary over one that had
 * it, and nothing anywhere noticed. Three mechanisms had to agree for that to be silent, and
 * all three were behaving as designed:
 *
 * 1. `buildVocabulary` SKIPS rather than fails when spellfix1 will not load, because a build
 *    box without the extension must still be able to produce a valid index.
 * 2. `stampStages` stamps every stage recipe at the end of the build whether or not the stage
 *    produced anything -- so the file claimed `vocab` it did not have, `staleStagesOf` saw
 *    nothing stale, and no later build was ever ordered for it.
 * 3. `runCanaryOn` EXCLUDES the five fuzzy-only cases from the score when the tier is absent,
 *    so the promote canary read 41/41 rather than failing.
 *
 * Each is correct on its own terms and none of them is the defect. The defect is that the
 * candidate was never compared with the file it displaced: `gateVolume` counted rows and
 * nothing counted CAPABILITIES. The live Mac index served for a day with the whole fuzzy tier
 * off, correct on every query it could still answer, and no error was raised anywhere.
 *
 * The cause on that box is worth knowing before writing another `${process.cwd()}` path:
 * `extensionCandidates()` in `./spellfix.ts` looks for the compiled extension relative to the
 * WORKING DIRECTORY, and the compiled artefact is gitignored -- so a build run from a git
 * worktree finds no extension no matter how many times the main checkout has built one.
 *
 * ## Why a capability and not "every object the old file had"
 *
 * The blunt version of this gate -- diff `sqlite_master` and refuse any name that vanished --
 * is wrong, and `INDEX_STAGES.episodes` says why in its own words: `v: 2` deliberately DROPPED
 * `ix_ep_rating` to reclaim 445 MB. A build is allowed to drop an object; it is not allowed to
 * drop something a reader can tell the difference between.
 *
 * So a capability here is defined by exactly one rule, and the rule is what keeps the list
 * from becoming an opinion: **it is a question the running server already asks.** Every entry
 * below backs a `has*` field on `SearchEngine` or a branch of `prepareFuzzy`, and those fields
 * read their answers from THIS table rather than probing the schema a second time -- so a
 * stage added with a probe is a stage this gate learns about in the same edit, and the two can
 * never drift into disagreeing about what an index carries.
 */

import { Database } from "bun:sqlite";
import { PERSON_FTS_TABLE } from "./people";
import { SPELLFIX_MAP_TABLE, SPELLFIX_TABLE } from "./spellfix";
import { TRIGRAM_DF_TABLE, TRIGRAM_TABLE } from "./vocab-trigrams";

// ---------------------------------------------------------------------------
// Schema probes
// ---------------------------------------------------------------------------

/** Is `name` a table in this file? Virtual tables included -- SQLite records them as tables. */
export function tableExists(db: Database, name: string): boolean {
  return db.query("select 1 from sqlite_master where type = 'table' and name = ?").get(name) !== null;
}

/**
 * Is this index in the file? Asked before any `INDEXED BY` names one.
 *
 * A missing index is a PREPARE error rather than a slow plan, so this is the difference
 * between an older file serving slowly and an older file throwing on every browse.
 */
export function indexExists(db: Database, name: string): boolean {
  return db.query("select 1 from sqlite_master where type = 'index' and name = ?").get(name) !== null;
}

/**
 * Does `index` carry `column` -- as a key column or as a covered trailing one?
 *
 * `indexExists` above answers "is it there", which is enough when a widening only reordered
 * the columns an index already had. It is NOT enough when the widening ADDS one: the index
 * name does not change, so a file built before it looks complete and the query that assumed
 * the extra column falls out of the index onto a table lookup per candidate row.
 *
 * `index_xinfo` rather than `index_info` because it lists the trailing columns too, and the
 * columns this asks about are exactly the trailing ones. Answers false for an index that is
 * not in the file, so a caller can ask this alone.
 */
export function indexCovers(db: Database, index: string, column: string): boolean {
  return (db.query(`pragma index_xinfo(${index})`).all() as { name: string | null }[]).some(
    (c) => c.name === column,
  );
}

/** Does `table` have `column`? Answers false for a table that does not exist at all. */
export function columnExists(db: Database, table: string, column: string): boolean {
  if (!tableExists(db, table)) return false;
  return (db.query(`pragma table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
}

// ---------------------------------------------------------------------------
// The capabilities themselves
// ---------------------------------------------------------------------------

/**
 * The cast tables, named once because `peopleSearch` builds on them.
 *
 * A standalone function rather than a self-reference inside the table below: an entry reading
 * `INDEX_CAPABILITIES.people(db)` makes the object's own type depend on itself, which costs
 * the literal keys `satisfies` is here to preserve.
 */
const hasCastTables = (db: Database): boolean =>
  tableExists(db, "title_principal") && tableExists(db, "person");

/**
 * Every question the server asks of an index file, keyed by the name this gate reports.
 *
 * A probe takes an open connection and nothing else. In particular NO extension has to be
 * loaded to run one, and that is the property the whole gate rests on: the box that loses the
 * vocabulary is by definition the box that cannot load spellfix1, so a probe that asked the
 * spellfix module whether the tier worked would answer "off" for the live index too and the
 * regression would sail straight through. `sqlite_master` can be read without the module that
 * owns the table.
 *
 * Keys are the names a human reads in an abort message, so they are the product's words
 * (`fuzzy`, `people`) rather than the schema's.
 */
export const INDEX_CAPABILITIES = {
  /** The spellfix1 vocabulary that serves the fuzzy tier -- the table and its title map. */
  fuzzy: (db) => tableExists(db, SPELLFIX_TABLE) && tableExists(db, SPELLFIX_MAP_TABLE),
  /**
   * The trigram shortlist beside the vocabulary.
   *
   * Both tables or neither: they are one stage's output, and a shortlist ranked against a
   * frequency table that is not there would choose its trigrams blind.
   */
  trigrams: (db) => tableExists(db, TRIGRAM_TABLE) && tableExists(db, TRIGRAM_DF_TABLE),
  people: hasCastTables,
  peopleSearch: (db) =>
    hasCastTables(db) && tableExists(db, PERSON_FTS_TABLE) && columnExists(db, "person", "top_votes"),
  rank: (db) => columnExists(db, "title", "rank") && columnExists(db, "title_genre", "rank"),
  rankIndexes: (db) => indexExists(db, "ix_rank") && indexExists(db, "ix_rank_all"),
  ids: (db) => tableExists(db, "title_ids"),
  personIds: (db) => tableExists(db, "person_external"),
  origin: (db) => tableExists(db, "title_lang"),
  breakout: (db) => tableExists(db, "title_breakout"),
  langRank: (db) =>
    columnExists(db, "title_lang", "kind") &&
    columnExists(db, "title_lang", "rank") &&
    columnExists(db, "title_lang", "non_english") &&
    indexExists(db, "ix_lang_rank"),
  langYear: (db) => columnExists(db, "title_lang", "year") && indexCovers(db, "ix_lang_rank", "year"),
  langVotes: (db) => columnExists(db, "title_lang", "votes") && indexExists(db, "ix_lang_votes"),
  titleLang: (db) => columnExists(db, "title", "lang"),
  genreVotes: (db) => columnExists(db, "title_genre", "votes"),
  genreYear: (db) => columnExists(db, "title_genre", "year"),
  browseCounts: (db) => tableExists(db, "browse_count"),
  episodes: (db) => tableExists(db, "episode"),
  // `satisfies` rather than an annotation, the shape `INDEX_STAGES` uses: the keys stay
  // literal, so `INDEX_CAPABILITIES.people` is a function rather than a possibly-undefined
  // index read and a typo in a caller is a compile error.
} satisfies Record<string, (db: Database) => boolean>;

/** The name of one capability, as `INDEX_CAPABILITIES` spells it. */
export type IndexCapability = keyof typeof INDEX_CAPABILITIES;

/** Everything the open file can do. */
export function capabilitiesOf(db: Database): Set<IndexCapability> {
  const out = new Set<IndexCapability>();
  for (const [name, probe] of Object.entries(INDEX_CAPABILITIES)) {
    if (probe(db)) out.add(name as IndexCapability);
  }
  return out;
}

/**
 * The same question of a file this function opens and closes itself.
 *
 * `null` rather than a throw for a file that cannot be opened or read, because both callers
 * are handed a path that may be missing, mid-promote or corrupt -- and the promote gate in
 * particular must not refuse a good candidate because the file it would REPLACE is broken.
 * `null` means "cannot say", which is a different answer from an empty set.
 */
export function capabilitiesOfFile(path: string): Set<IndexCapability> | null {
  try {
    const db = new Database(path, { readonly: true, create: false });
    try {
      return capabilitiesOf(db);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}
