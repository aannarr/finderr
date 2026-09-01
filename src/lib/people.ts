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
    // SQLite's group_concat has no separator argument in its DISTINCT form, so it is
    // always a bare comma. Split on exactly that rather than on a guessed pattern.
    categories: r.categories.split(",").filter(Boolean).sort(),
    characters: normalizeCharacters(r.characters),
  }));

  return { person, credits, total, categories };
}

/**
 * Tidy the joined character list.
 *
 * `group_concat(distinct ...)` skips nulls entirely, so a person who is credited as both
 * an actor and a director on one title yields just the acting character -- which is the
 * wanted result. An all-null group yields SQL NULL, which stays null here rather than
 * becoming an empty string a pane would then render as a blank line.
 */
function normalizeCharacters(raw: string | null): string | null {
  if (!raw) return null;
  const parts = [
    ...new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * Map the names a metadata provider gave us for one title onto our own person ids.
 *
 * Needed because the `cast` facet identifies people by TMDB id (`tmdb:6193`) while the
 * index speaks IMDb nconsts, so a cast list arrives with no id we can link. Rather than
 * crosswalk two id spaces, this joins on the one thing both sides agree on -- the name,
 * within a title whose credits we already hold.
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
