/**
 * Person lookups over the local index.
 *
 * The reverse edge -- person to filmography -- is what `title_principal` exists for, and
 * every query here is a local SQLite read. That is not a performance note, it is the
 * governing rule: a person page renders on the same terms as search, so nothing in this
 * file may reach the network or wait on a plugin.
 *
 * Module-level functions taking a `Database`, deliberately mirroring `browseIndex` rather
 * than hanging off `SearchEngine`. It means the policy is testable against a handful of
 * rows in a temp file instead of against the 1.27M-row index, and a test that has to
 * build the real index is a test nobody runs.
 */

import type { Database } from "bun:sqlite";
import { creditLabel } from "./credits";
import { nconstsByTmdbPersonId } from "./crosswalk";
import { type PersonCredit, tmdbPersonIdOf } from "./facets";
import { type PersonLeaderboard, rankPeople } from "./people-leaderboard";
import type { TitleRow } from "./search";

export interface Person {
  nconst: string;
  name: string;
  birthYear: number | null;
  deathYear: number | null;
}

/**
 * One TITLE in a person's filmography, and every way they are credited on it.
 *
 * `categories` is a list, not a value, because the underlying table has one row per
 * credit and a person is often several things on one film -- Nolan wrote and directed
 * Inception. Collapsing that here rather than in the client is what makes a filmography
 * a grid of titles instead of a grid of credit rows: the live bug this shape fixes
 * rendered "Titans" twice and "Dark Web: Cicada 3301" three times.
 */
export interface Credit extends TitleRow {
  categories: string[];
  /** Every character name they are billed under, joined. `null` for non-acting credits. */
  characters: string | null;
  /** Their BEST billing position on this title, across however many rows it took. */
  ordering: number;
}

export interface PersonPage {
  person: Person;
  credits: Credit[];
  /** Total credits for this person, which `credits` may be a page of. */
  total: number;
  /**
   * Credit counts per category, over ALL their credits rather than this page.
   *
   * Computed here rather than derived from `credits` in the client: a page of 60 says
   * nothing about the other 200, so counting the page would print a number that shrinks
   * as you scroll.
   */
  categories: { category: string; count: number }[];
}

const SELECT_PERSON = "select nconst, name, birth_year, death_year from person where nconst = ?";

interface PersonDbRow {
  nconst: string;
  name: string;
  birth_year: number | null;
  death_year: number | null;
}

function toPerson(r: PersonDbRow): Person {
  return { nconst: r.nconst, name: r.name, birthYear: r.birth_year, deathYear: r.death_year };
}

/** The person, or `null` when we hold no such nconst. */
export function personByNconst(db: Database, nconst: string): Person | null {
  const row = db.query(SELECT_PERSON).get(nconst) as PersonDbRow | undefined;
  return row ? toPerson(row) : null;
}

export interface PersonCreditsOptions {
  /**
   * Restrict to these IMDb categories, e.g. `["director"]` for only what they directed.
   *
   * A LIST rather than one value, because IMDb's vocabulary does not match the one a
   * reader uses: `actor` and `actress` are one job called "Acting". Filtering on a single
   * category would quietly drop every actress credit from an Acting filter -- a wrong
   * answer that looks like a right one, since the page still fills with plausible rows.
   */
  categories?: string[];
  limit?: number;
  offset?: number;
  /**
   * Which question the filmography is answering. Defaults to `votes`.
   *
   * `votes` is "what do I know them from"; `year` is "what have they been doing lately".
   * Both are real questions and neither subsumes the other, which is why this is a choice
   * rather than a better default -- see `CREDIT_ORDER`.
   */
  sort?: PersonCreditSort;
}

/** The orderings a filmography can be read in. A closed union, so a bad param cannot reach SQL. */
export type PersonCreditSort = "votes" | "year";

/**
 * The two orderings, each TOTAL and each ending in `tconst`.
 *
 * The final `t.tconst` is what makes paging stable and it is not decoration: without a
 * unique last key, two titles that tie on both columns may swap between page 1 and page 2
 * and the reader sees one of them twice and the other never. `votes` and `year` are simply
 * each other's tiebreak, so a title buried by one ordering is surfaced by the other.
 *
 * Written out as whole clauses rather than assembled from parts, so the strings that reach
 * SQLite are literals in this file. `sort` arrives from a query parameter, and a lookup
 * that can only return one of these two is the guard.
 */
const CREDIT_ORDER: Record<PersonCreditSort, string> = {
  votes: "t.votes desc, t.year desc, t.tconst",
  year: "t.year desc, t.votes desc, t.tconst",
};

/**
 * A person and their filmography, votes-first by default.
 *
 * Ordered by votes rather than by year because the question a filmography answers is
 * "what do I know them from", and a chronological list buries the answer in the middle.
 * Year is the tiebreak so the order is total and paging is stable -- two titles with
 * identical vote counts must not swap places between page 1 and page 2. `sort: "year"`
 * swaps the two keys for a reader asking the other question; nothing else changes, and in
 * particular the CATEGORY COUNTS do not, because they are over all credits either way.
 *
 * `null` when the person is unknown, which the caller renders as a 404 rather than as an
 * empty filmography: "we have never heard of this id" and "this person has no credits"
 * are different answers and only one of them is a broken link.
 */
export function personPage(db: Database, nconst: string, opts: PersonCreditsOptions = {}): PersonPage | null {
  const found = db.query(SELECT_PERSON).get(nconst) as PersonDbRow | undefined;
  if (!found) return null;
  const person = toPerson(found);

  // Every count and page below is scoped to this person's rowid, resolved once. Joining
  // through `person` on each query would repeat a lookup we have already paid for.
  const rowid = (db.query("select rowid_ from person where nconst = ?").get(nconst) as { rowid_: number })
    .rowid_;

  // count(DISTINCT title_rowid), matching how `total` and the grid count: these numbers
  // sit on chips beside a grid of titles, so counting credit rows would print a chip
  // whose number is larger than the grid it filters to.
  const categories = db
    .query(
      "select category, count(distinct title_rowid) as count from title_principal where person_rowid = ? " +
        "group by category order by count desc, category",
    )
    .all(rowid) as { category: string; count: number }[];

  // An empty list is treated as no filter, not as "match nothing": it can only arrive
  // from a caller that meant to pass none, and an empty page would look like a bug.
  const wanted = opts.categories?.filter(Boolean) ?? [];
  const where = wanted.length
    ? `tp.person_rowid = ? and tp.category in (${wanted.map(() => "?").join(",")})`
    : "tp.person_rowid = ?";
  const args: (string | number)[] = wanted.length ? [rowid, ...wanted] : [rowid];

  // DISTINCT titles, not credit rows. A person credited three ways on one film is one
  // entry in a filmography, and a total that counted rows would print "24" over 21 cards.
  const total = (
    db
      .query(`select count(distinct tp.title_rowid) as c from title_principal tp where ${where}`)
      .get(...(args as never[])) as { c: number }
  ).c;

  // Grouped by title for the same reason. `min(ordering)` because being second-billed
  // under one of two aliases does not make it a lesser credit; `group_concat(distinct)`
  // for the roles and the character names, both of which a single title can carry
  // several of.
  const rows = db
    .query(
      `select t.tconst, t.title, t.orig, t.year, t.kind, t.votes, t.rating, t.genres, t.runtime,
              group_concat(distinct tp.category) as categories,
              group_concat(distinct tp.characters) as characters,
              min(tp.ordering) as ordering
       from title_principal tp join title t on t.rowid_ = tp.title_rowid
       where ${where}
       group by t.rowid_
       order by ${CREDIT_ORDER[opts.sort ?? "votes"] ?? CREDIT_ORDER.votes} limit ? offset ?`,
    )
    .all(...([...args, opts.limit ?? 60, opts.offset ?? 0] as never[])) as (Omit<Credit, "categories"> & {
    categories: string;
  })[];

  const credits: Credit[] = rows.map((r) => ({
    ...r,
    categories: splitConcat(r.categories).sort(),
    characters: normalizeCharacters(r.characters),
  }));

  return { person, credits, total, categories };
}

/**
 * Split a `group_concat` column into its distinct, trimmed values, source order kept.
 *
 * SQLite's `group_concat` has no separator argument in its DISTINCT form, so the separator
 * is always a bare comma -- split on exactly that rather than on a guessed pattern. The
 * de-duplication is here rather than left to `distinct` in SQL because an aggregate OF an
 * aggregate (collaborator roles, below) can repeat a value that each inner group held only
 * once, and callers should not have to know which of the two shapes they were handed.
 */
function splitConcat(raw: string | null): string[] {
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * Tidy the joined character list.
 *
 * `group_concat(distinct ...)` skips nulls entirely, so a person who is credited as both
 * an actor and a director on one title yields just the acting character -- which is the
 * wanted result. An all-null group yields SQL NULL, which stays null here rather than
 * becoming an empty string a pane would then render as a blank line.
 *
 * Source order rather than sorted: "Hank Hall, Hawk" is how the title bills them.
 */
function normalizeCharacters(raw: string | null): string | null {
  const parts = splitConcat(raw);
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * Somebody this person keeps turning up beside, and how often.
 *
 * `shared` counts TITLES, never credit rows: Nolan directing and writing one film with
 * DiCaprio in it is one shared title, and a count of rows would print "2 titles together"
 * over a single poster's worth of shared work.
 */
export interface Collaborator {
  nconst: string;
  name: string;
  /** Titles both are credited on. The rank key, and the number the pane prints. */
  shared: number;
  /** IMDb categories THEY held on the shared titles -- their job, not this person's. */
  categories: string[];
}

export interface CollaboratorOptions {
  /**
   * How many shared titles it takes to be a collaborator at all. Defaults to 2.
   *
   * One shared credit is a coincidence rather than an edge -- everybody who ever stood in
   * one film with a star would qualify -- and a page of coincidences is the dishonest half
   * of "everything is clickable". Two is the smallest number that means "again".
   */
  minShared?: number;
  limit?: number;
}

const DEFAULT_MIN_SHARED = 2;
const DEFAULT_COLLABORATOR_LIMIT = 12;

/**
 * The people this person works with most, most-shared first.
 *
 * Local SQLite over the credits tables and nothing else, so a person page can carry this
 * without leaving the render-path rule the rest of this file lives under. Measured against
 * the real 1.27M-credit index: ~1ms for a lean filmography and ~4ms warm for one the size
 * of Tom Hanks's, beside ~1ms for the filmography query itself. Same order of magnitude,
 * which is what the rule asks -- traversing the graph stays as fast as searching it.
 *
 * **Every row is a live destination by construction.** A collaborator is only here because
 * they hold credits in OUR tables, so their person page renders the same way this one
 * does -- there is no "is it in the index" guess to get wrong, which is the trap the
 * dead-end rule warns about for edges pointed at a filtered set.
 *
 * The inner query collapses each (collaborator, title) pair to one row, which is what
 * makes both the count and the vote sum count titles: either person may hold several
 * credits on one film, and a plain join would multiply the two.
 *
 * Ranked on shared titles, then on how much those titles are watched, then on name and id.
 * The tail keys are what make the order TOTAL: two collaborators tied on both numbers must
 * not swap between visits, and a list that reshuffles is worse than one that is merely
 * imperfect.
 */
export function frequentCollaborators(
  db: Database,
  nconst: string,
  opts: CollaboratorOptions = {},
): Collaborator[] {
  const rows = db
    .query(
      `select p.nconst, p.name, count(*) as shared, sum(s.votes) as votes,
              group_concat(s.categories) as categories
       from (
         select mine.title_rowid as title_rowid, theirs.person_rowid as person_rowid,
                coalesce(t.votes, 0) as votes,
                group_concat(distinct theirs.category) as categories
         from person me
         join title_principal mine on mine.person_rowid = me.rowid_
         join title_principal theirs
           on theirs.title_rowid = mine.title_rowid and theirs.person_rowid <> me.rowid_
         join title t on t.rowid_ = mine.title_rowid
         where me.nconst = ?
         group by mine.title_rowid, theirs.person_rowid
       ) s
       join person p on p.rowid_ = s.person_rowid
       group by s.person_rowid
       having shared >= ?
       order by shared desc, votes desc, p.name, p.nconst
       limit ?`,
    )
    .all(nconst, opts.minShared ?? DEFAULT_MIN_SHARED, opts.limit ?? DEFAULT_COLLABORATOR_LIMIT) as {
    nconst: string;
    name: string;
    shared: number;
    categories: string | null;
  }[];

  return rows.map((r) => ({
    nconst: r.nconst,
    name: r.name,
    shared: r.shared,
    categories: splitConcat(r.categories).sort(),
  }));
}

/**
 * Our own person ids for the credits on one title, under both keys a credit can carry.
 *
 * TWO MAPS RATHER THAN ONE, because they are answers of different quality and the reader
 * has to be able to prefer the better one. `byId` resolves identity from an ID and is
 * authoritative; `byName` resolves it from a STRING and is the fallback for a credit that
 * arrived with no id at all, which is what a series cast list is.
 *
 * Not merged into one map keyed by "whichever the credit has": two key spaces in one
 * object is a collision waiting for somebody named `tmdb:1295`, and it would also mean the
 * reader could no longer tell an authoritative answer from a fallback one.
 *
 * THE ID HALF IS THE ANSWER AND THE NAME HALF IS THE LEFTOVER. Matching a cast name against
 * the whole index is wrong 1.7% of the time and cannot be made right -- IMDb holds two
 * Peter Mileses (`nm0587213`, `nm0587215`) and no string can separate them. So the name
 * join stays TITLE-SCOPED, which is what makes it safe, and the crosswalk is what reaches
 * the people the scoped join cannot see: `title.principals` is IMDb's curated top-ten per
 * title, so anybody billed below about tenth has no row to join against however famous they
 * are. Measured 2026-09-03 over 212 warmed titles and 5,157 cast entries: 33.8% linked by
 * name alone, 56.9% with the crosswalk beside it.
 *
 * Either half is empty on an index built before the stage that fills it, which renders as
 * plain text -- the dead-end rule's answer for a name with nowhere to go.
 */
export interface PersonLinks {
  /** Keyed by the credit's own `personId` string, e.g. `tmdb:1295`. Authoritative. */
  byId: Record<string, string>;
  /** Keyed by `personNameKey(name)`, scoped to this title. The fallback. */
  byName: Record<string, string>;
}

/**
 * Our nconsts for a batch of credits, keyed by the credit's own `personId` string.
 *
 * Keyed by the STRING the credit carries rather than by the decoded number, so the caller
 * that reads this map -- ultimately a browser -- never has to know how a `personId` is
 * spelled. Decoding lives in `tmdbPersonIdOf` and nowhere else.
 *
 * A credit with no id, an id in a namespace we hold no crosswalk for, and an id nobody in
 * our index answers to all yield the same thing: no entry. That is deliberate -- an nconst
 * we cannot render a filmography for is a dead end wearing a link.
 */
export function nconstsForCredits(db: Database, credits: readonly PersonCredit[]): Map<string, string> {
  const wanted = new Map<number, string>();
  for (const c of credits) {
    if (!c.personId) continue;
    const id = tmdbPersonIdOf(c.personId);
    if (id !== null) wanted.set(id, c.personId);
  }

  const resolved = nconstsByTmdbPersonId(db, [...wanted.keys()]);
  const out = new Map<string, string>();
  for (const [id, key] of wanted) {
    const nconst = resolved.get(id);
    if (nconst) out.set(key, nconst);
  }
  return out;
}

/**
 * Map the names a metadata provider gave us for one title onto our own person ids.
 *
 * The FALLBACK half of `personLinks`, and the only one available for a credit that carries
 * no person id in any space -- skyhook's series cast is exactly that. Rather than crosswalk
 * two id spaces, this joins on the one thing both sides agree on: the name, within a title
 * whose credits we already hold.
 *
 * Scoping to the title is what makes a name safe to match on. "John Williams" is several
 * people across the corpus and one person on any given film.
 *
 * **An ambiguous name resolves to nothing, never to a guess.** Two same-named people on
 * one title is rare and real; sending a reader to the wrong filmography is worse than
 * leaving the name as plain text, and plain text is what the dead-end rule asks for
 * anyway when there is nowhere certain to go.
 */
export function nconstsByNameForTitle(db: Database, tconst: string): Map<string, string> {
  const rows = db
    .query(
      "select p.nconst, p.name from title_principal tp " +
        "join person p on p.rowid_ = tp.person_rowid " +
        "join title t on t.rowid_ = tp.title_rowid where t.tconst = ?",
    )
    .all(tconst) as { nconst: string; name: string }[];

  const byName = new Map<string, string | null>();
  for (const r of rows) {
    const key = personNameKey(r.name);
    const seen = byName.get(key);
    // Already mapped to a DIFFERENT person -> poison the entry rather than overwrite it.
    // Re-seeing the same nconst is ordinary: one person can hold several credits on one
    // title (wrote it and directed it), and that is not ambiguity.
    if (seen === undefined) byName.set(key, r.nconst);
    else if (seen !== r.nconst) byName.set(key, null);
  }

  const resolved = new Map<string, string>();
  for (const [key, nconst] of byName) if (nconst) resolved.set(key, nconst);
  return resolved;
}

/**
 * How a person's name is compared across sources.
 *
 * Case and surrounding space only. Deliberately NOT the aggressive title fold in
 * `normalize.ts`: that strips punctuation, which would merge "Louis C.K." into "Louis
 * CK" -- fine -- but also collapses distinctions in names it was never designed for.
 * A conservative fold missing a match costs one unlinked name; an eager one sends a
 * reader to the wrong person.
 *
 * **This is the IDENTITY fold and it is not the search fold.** It decides whether two
 * sources are describing the same human, where a wrong answer is a link to the wrong
 * filmography -- so it is deliberately timid. `searchPeople` below folds through the FTS
 * tokenizer instead, which is the same fold `tfts` applies to titles: a reader typing
 * "almodovar" means Pedro Almodóvar, and a search that missed him would be the wrong kind
 * of careful. Two questions, two folds, on purpose.
 */
export function personNameKey(name: string): string {
  return name.trim().toLowerCase();
}

// --- search ----------------------------------------------------------------

/**
 * The FTS5 index over `person.name`, and the rank columns a hit is ordered by.
 *
 * The DDL lives HERE, beside the query that depends on it, for the reason
 * `search-stopwords.ts` owns `POPULAR_TITLE_INDEX`: a builder that shaped the index
 * differently from what the query asks for produces no error at all, just a slow or empty
 * answer nobody can trace back. One module owns both halves or they drift.
 *
 * ## Why an FTS index rather than `ix_person_name`
 *
 * That index is on the RAW name under BINARY collation, so it answers "names starting with
 * `Christopher`" and nothing a reader would actually type. Measured against the real
 * 353,117-person index: a `like` scan is 14ms for the covering form and 29ms for the full
 * row, against a 7.8ms mean for the entire title search it would ride beside -- and
 * `bun:sqlite` is synchronous, so those milliseconds are the whole server's. It also cannot
 * match a token in the MIDDLE of a name, which is most of what a person search is: nobody
 * types "christopher" to find Nolan.
 *
 * External-content FTS5, exactly like `tfts` over `title`: the names are not duplicated,
 * FTS just indexes what `person` already holds. 0.57s to build and 1,127 pages.
 */
export const PERSON_FTS_TABLE = "pfts";

/**
 * One person in a search answer.
 *
 * `credits` rather than the vote signal it is ranked by: how many titles we hold for
 * somebody is a fact a reader can use, and `top_votes` is an internal ordering key that
 * would only invite a client to re-sort on it.
 */
export interface PersonHit extends Person {
  /** Titles we hold credits for. The rank tiebreak, and what a tile prints under the name. */
  credits: number;
}

export interface PersonSearchOptions {
  limit?: number;
}

/**
 * A row of people beside a grid of titles, so eight is the shape rather than a page size.
 */
const DEFAULT_PERSON_HIT_LIMIT = 8;

/**
 * How many letters a token needs before it is worth searching on.
 *
 * A FLOOR ON COST, and the number is measured on the real 353,117-person index. A prefix
 * term costs roughly what its doclist is long, and an AND of two broad terms costs about
 * their SUM rather than their intersection -- FTS5 has to read both. So `a` alone is 23ms,
 * `s` is 30ms, `"ma"* AND "ma"*` is 18ms, while every token at three letters or more comes
 * in at 6.3ms worst (`mar`), 1-3ms typically and under 0.1ms for a real name.
 *
 * PER TOKEN, and a short token is DROPPED rather than refusing the whole query. That is
 * what keeps the row from flickering: somebody typing "tom hanks" passes through "tom h",
 * and a rule that refused it would take the Toms off the screen for two keystrokes and then
 * put them back. Dropping the stub instead leaves the previous, still-true answer up and
 * narrows it as soon as the second name is specific enough to be cheap.
 */
const PERSON_SEARCH_MIN_TOKEN_CHARS = 3;

/**
 * Build the people-search layer over whatever `person` and `title_principal` hold.
 *
 * Runs on EVERY build rather than being carried forward with the cast tables, because half
 * of what it computes is about titles: `top_votes` reads `title.votes`, which moves nightly
 * even on a night when no credit changed. Carrying it would freeze a person's popularity at
 * whatever it was the last time the dumps were scanned, which is up to `castRefreshDays`
 * ago. Measured on a copy of the live 353,117-person index: 7.2s in total, 4.4s of it the
 * popularity pass and 2.0s the FTS insert, against a nightly build that already runs for
 * minutes (`BUILD COST` in `./index-builder.ts`).
 *
 * Creates the table even when there is nobody in it, so `hasPeopleSearch` answers the same
 * question `hasPeople` does -- "was this index built by a version that knows about people
 * search" -- rather than doubling as a row count.
 */
export function buildPersonSearchIndex(db: Database, log: (msg: string) => void = () => {}): void {
  /*
    ONE GROUPED SCAN joined onto the update, not a correlated subquery per person.

    The correlated form reads the same and measured 40.6s on a copy of the live index
    against 4.4s for this -- SQLite runs it once per row, so a third of a million index
    seeks pay for a scan that answers every person at once.

    A person with no surviving credit is left at the column default, which is 0 and is the
    right answer: they are as unknown as the index can say. `update ... from` simply does
    not match them, so no `coalesce` is needed and none is written.
  */
  db.run(
    `update person set top_votes = g.v, credits = g.c
     from (select tp.person_rowid as pid, max(t.votes) as v, count(distinct tp.title_rowid) as c
           from title_principal tp join title t on t.rowid_ = tp.title_rowid
           group by tp.person_rowid) g
     where g.pid = person.rowid_`,
  );
  db.run(
    `create virtual table ${PERSON_FTS_TABLE} using fts5(name, content='person', content_rowid='rowid_', ` +
      "tokenize='unicode61 remove_diacritics 2')",
  );
  db.run(`insert into ${PERSON_FTS_TABLE}(rowid, name) select rowid_, name from person`);

  const people = (db.query("select count(*) c from person").get() as { c: number }).c;
  log(`  ${people.toLocaleString()} people searchable`);
}

/**
 * The FTS5 MATCH expression for a typed query, or `null` when nothing in it is searchable.
 *
 * EVERY token is a PREFIX, not just the last one. A reader typing "chris nol" means
 * Christopher Nolan, and matching all but the final token as whole words would find only
 * the handful of people actually christened Chris.
 *
 * Tokens are split on everything that is not a letter or a digit, which is what `unicode61`
 * does on the other side -- so "o'brien" asks for `"o"* AND "brien"*`, the index answers,
 * and a token can never contain the quote that would break the expression.
 */
function personMatchExpression(query: string): string | null {
  const tokens = query.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= PERSON_SEARCH_MIN_TOKEN_CHARS);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"*`).join(" AND ");
}

/**
 * People whose name matches the query, best known first.
 *
 * **Ranked by the votes on their best-known title, tie-broken by how many titles we hold.**
 * A person row carries no audience signal of its own, so the rank borrows the one the whole
 * index is already built on: the top hit for "nolan" is the Nolan a reader means. Both
 * numbers are precomputed by `buildPersonSearchIndex` -- deriving them per query means
 * joining every match through `title_principal`, which took "tom" from 1.5ms to 29ms.
 *
 * The tail keys make the order TOTAL. Two people tied on both numbers must not swap between
 * one keystroke and the next, and an order that reshuffles is worse than one that is merely
 * imperfect.
 *
 * An empty result and a query with no searchable token are the same answer here -- no
 * people to draw. "This index cannot search people at all" is a different fact and it is
 * `SearchEngine.hasPeopleSearch`'s to report, not this function's.
 */
export function searchPeople(db: Database, query: string, opts: PersonSearchOptions = {}): PersonHit[] {
  const match = personMatchExpression(query);
  if (match === null) return [];

  const rows = db
    .query(
      // The FTS table is named rather than aliased: `<alias> match ?` is `no such column`,
      // because MATCH resolves against the table name and not against whatever it is
      // called in this query.
      `select p.nconst, p.name, p.birth_year, p.death_year, p.credits
       from ${PERSON_FTS_TABLE} join person p on p.rowid_ = ${PERSON_FTS_TABLE}.rowid
       where ${PERSON_FTS_TABLE} match ?
       order by p.top_votes desc, p.credits desc, p.name, p.nconst
       limit ?`,
    )
    .all(match, opts.limit ?? DEFAULT_PERSON_HIT_LIMIT) as (PersonDbRow & { credits: number })[];

  return rows.map((r) => ({ ...toPerson(r), credits: r.credits }));
}

// --- who turns up most across a set of titles -------------------------------
//
// The credit half of the people boards: one grouped read here, and the ranking rules pure
// over its rows, the same split `awardPeopleBoards` takes over an award tally. It means the
// board policy is tested against four hand-written people rather than against 1.4M credits.

/** How many titles of a given set one person holds one kind of credit on. */
export interface CreditTally {
  nconst: string;
  name: string;
  /** IMDb's own category, verbatim. `creditLabel` is what turns it into a board. */
  category: string;
  /** DISTINCT titles, never credit rows -- a person billed twice on one film is one title. */
  titles: number;
}

/**
 * Who is credited on a set of titles, rolled up per person per category.
 *
 * ONE grouped query for every board rather than one per role, exactly as `awardPeopleBoards`
 * takes one tally and asks it three questions: they are three orderings of the same rows,
 * and asking SQLite each of them would be the same scan run three times.
 *
 * **17ms warm** for the 500 ids of the two `finderr Top 250` lists, measured 2026-09-06
 * against the real 1,380,192-credit index (267ms cold, which is the OS reading pages of
 * `title_principal` it has never touched). It is bounded by the SET rather than by the
 * table: SQLite seeks `ix_tp_title` once per title, so the cost is the ids handed in and not
 * the 1.4M rows behind them.
 *
 * **The obvious alternative was measured and is worse.** A whole-index rollup filtered by a
 * vote floor -- `where tp.category = ? and t.votes >= 1000` -- came in at 331ms warm on the
 * same database, because there is no index on `title_principal.category` and there should
 * not be: the awards timeline added one on `award_nominee(award, nconst)`, benchmarked it,
 * and took it out again for trading a covering scan for a random probe per row. Taking a
 * LIST rather than a threshold is what makes this a seek instead of a scan, and it is also
 * the more honest ranking -- "who turns up most in the Top 250" is a claim about a set a
 * reader can see, where a vote floor is a number nobody chose.
 *
 * No ids is no query. `in ()` is a syntax error rather than an empty answer, and "this index
 * has nothing ranked" is an ordinary state -- see `SearchEngine.hasRank`.
 *
 * The caller's ids go in as bound parameters, so the set has to stay well under SQLite's
 * 32,766-parameter statement cap. The two `LIST_SIZE` lists that feed it come to 500.
 */
export function creditTally(db: Database, tconsts: readonly string[]): CreditTally[] {
  if (tconsts.length === 0) return [];
  return db
    .query(
      `select p.nconst as nconst, p.name as name, tp.category as category,
              count(distinct tp.title_rowid) as titles
       from title t
       join title_principal tp on tp.title_rowid = t.rowid_
       join person p on p.rowid_ = tp.person_rowid
       where t.tconst in (${tconsts.map(() => "?").join(",")})
       group by tp.category, tp.person_rowid`,
    )
    .all(...tconsts) as CreditTally[];
}

/**
 * The boards `/lists` draws, and the credit label each one ranks.
 *
 * THREE of the ten labels rather than all of them, and that is the same editorial call
 * `LIST_GENRES` makes about genres: a board per IMDb category would put "Casting" and
 * "Production Design" on an index page, and nobody arrives at `/lists` wondering who the
 * most-seen casting director is. These three are the credits a reader already thinks of a
 * film by.
 *
 * The label is the JOIN KEY, not a heading -- `creditLabel` maps `actor` and `actress` onto
 * one "Acting", which is the whole reason that mapping had to become shared rather than
 * stay in the browser. `title` is what the board is called on screen, which is a different
 * question: "Acting" labels a chip on a filmography, "Performers" heads a leaderboard.
 */
const CREDIT_BOARDS = [
  { id: "directors", label: "Directing", title: "Directors" },
  { id: "performers", label: "Acting", title: "Performers" },
  { id: "writers", label: "Writing", title: "Writers" },
] as const;

/**
 * How many names a board on `/lists` carries.
 *
 * Smaller than `DEFAULT_BOARD_SIZE`, because this is an INDEX page with three boards on it
 * and twenty-five names each would be seventy-five rows under a page of links. An award's
 * own people page is the place to read the full twenty-five.
 */
export const CREDIT_BOARD_SIZE = 10;

/**
 * Who turns up most across a set of titles, as one ranked board per credit label.
 *
 * PURE over the tally, so the ranking rules are exercised against a handful of hand-written
 * people rather than against a database -- the same split `awardPeopleBoards` takes, and the
 * ordering rule itself is `rankPeople`, so the tie-break has one owner.
 *
 * A person's rows are SUMMED within a label, which matters for exactly one pair: somebody
 * billed `actor` on one film and `actress` on another is one performer with two titles. No
 * other two categories share a label, and the two of them cannot co-occur on one title, so
 * the sum can never double-count a film.
 *
 * A board with nobody on it is dropped rather than drawn empty, on the same terms as an
 * award's: an index built without the cast tables has no writers to rank, and a heading over
 * a blank list claims we looked and found nobody.
 *
 * **Every row is a live destination by construction** -- a name is here because it holds
 * credits in `person`, which is the table `/person/:nconst` renders from. That is this
 * source's answer to the studio problem the award boards have: `award_nominee` mixes `co`
 * company ids in with people and has to filter them out, while a `person` row is a person or
 * it would not be in `person`.
 */
export function creditBoards(
  tallies: readonly CreditTally[],
  limit = CREDIT_BOARD_SIZE,
): PersonLeaderboard[] {
  const byLabel = new Map<string, Map<string, { nconst: string; name: string; titles: number }>>();
  for (const t of tallies) {
    const label = creditLabel(t.category);
    const people = byLabel.get(label) ?? new Map();
    const entry = people.get(t.nconst) ?? { nconst: t.nconst, name: t.name, titles: 0 };
    entry.titles += t.titles;
    people.set(t.nconst, entry);
    byLabel.set(label, people);
  }

  return CREDIT_BOARDS.map((board) => ({
    id: board.id,
    title: board.title,
    // No blurb: all three boards count the same thing over the same set, and the page that
    // draws them says so once above the row. Three copies of one sentence is not a caveat.
    blurb: null,
    unit: { one: "title", many: "titles" },
    entries: rankPeople([...(byLabel.get(board.label)?.values() ?? [])], {
      value: (p) => p.titles,
      limit,
    }),
  })).filter((board) => board.entries.length > 0);
}
