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
import { nconstsByTmdbPersonId } from "./crosswalk";
import { type PersonCredit, tmdbPersonIdOf } from "./facets";
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
 */
export function personNameKey(name: string): string {
  return name.trim().toLowerCase();
}
