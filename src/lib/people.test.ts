/**
 * Person lookups, asserted as POLICY against a fixture rather than against the real index.
 *
 * Same reasoning as `browse.test.ts`: a test pinned to `data/titles.db` would be measuring
 * the IMDb dump and would go red the next time it is rebuilt. The schema comes from
 * `index-builder` so the fixture is shaped like the real index rather than like somebody's
 * memory of it.
 */

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config";
import { loadPersonCrosswalk } from "./crosswalk";
import type { PersonCredit } from "./facets";
import { SCHEMA } from "./index-builder";
import {
  frequentCollaborators,
  nconstsByNameForTitle,
  nconstsForCredits,
  personByNconst,
  personNameKey,
  personPage,
} from "./people";
import { SearchEngine } from "./search";

const dir = mkdtempSync(join(tmpdir(), "finderr-people-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface TitleFix {
  tconst: string;
  title: string;
  year: number;
  votes: number;
}
interface CreditFix {
  tconst: string;
  nconst: string;
  category: string;
  ordering?: number;
  characters?: string | null;
}

function indexOf(
  titles: TitleFix[],
  people: { nconst: string; name: string; birth?: number }[],
  credits: CreditFix[],
): Database {
  const db = new Database(join(dir, `${crypto.randomUUID()}.db`), { create: true });
  db.run(SCHEMA);

  const titleRowid = new Map<string, number>();
  const insertTitle = db.query(
    "insert into title (tconst, kind, title, year, votes, rating, genres) values (?, 'movie', ?, ?, ?, 7, 'Drama')",
  );
  titles.forEach((t, i) => {
    insertTitle.run(t.tconst, t.title, t.year, t.votes);
    titleRowid.set(t.tconst, i + 1);
  });

  const personRowid = new Map<string, number>();
  const insertPerson = db.query(
    "insert into person (rowid_, nconst, name, birth_year, death_year) values (?, ?, ?, ?, null)",
  );
  people.forEach((p, i) => {
    insertPerson.run(i + 1, p.nconst, p.name, p.birth ?? null);
    personRowid.set(p.nconst, i + 1);
  });

  const insertCredit = db.query(
    "insert into title_principal (title_rowid, person_rowid, category, ordering, characters) values (?,?,?,?,?)",
  );
  for (const c of credits) {
    insertCredit.run(
      titleRowid.get(c.tconst)!,
      personRowid.get(c.nconst)!,
      c.category,
      c.ordering ?? 1,
      c.characters ?? null,
    );
  }
  return db;
}

const TITLES: TitleFix[] = [
  { tconst: "tt-incep", title: "Inception", year: 2010, votes: 2_500_000 },
  { tconst: "tt-dark", title: "The Dark Knight", year: 2008, votes: 2_900_000 },
  { tconst: "tt-obscure", title: "Early Short", year: 1998, votes: 900 },
];

const PEOPLE = [
  { nconst: "nm-leo", name: "Leonardo DiCaprio", birth: 1974 },
  { nconst: "nm-nolan", name: "Christopher Nolan" },
];

const CREDITS: CreditFix[] = [
  { tconst: "tt-incep", nconst: "nm-leo", category: "actor", ordering: 1, characters: "Dom Cobb" },
  { tconst: "tt-incep", nconst: "nm-nolan", category: "director" },
  { tconst: "tt-incep", nconst: "nm-nolan", category: "writer" },
  { tconst: "tt-dark", nconst: "nm-nolan", category: "director" },
  { tconst: "tt-obscure", nconst: "nm-leo", category: "actor" },
];

describe("personByNconst", () => {
  test("returns the person we hold", () => {
    const db = indexOf(TITLES, PEOPLE, CREDITS);
    expect(personByNconst(db, "nm-leo")).toEqual({
      nconst: "nm-leo",
      name: "Leonardo DiCaprio",
      birthYear: 1974,
      deathYear: null,
    });
  });

  test("an unknown id is null, which the route renders as a 404", () => {
    expect(personByNconst(indexOf(TITLES, PEOPLE, CREDITS), "nm-nobody")).toBeNull();
  });
});

describe("personPage", () => {
  test("orders the filmography by votes -- what you know them from, not when", () => {
    const db = indexOf(TITLES, PEOPLE, CREDITS);
    const page = personPage(db, "nm-nolan");
    // The Dark Knight outranks Inception on votes despite being older.
    expect(page?.credits.map((c) => c.tconst)).toEqual(["tt-dark", "tt-incep"]);
  });

  /**
   * The live bug this pins: /person/nm2024927 rendered "Titans" twice and
   * "Dark Web: Cicada 3301" three times. A filmography is a grid of TITLES, and a
   * person credited on one title several ways is still one card. Two causes, both real:
   * several roles on one title (actor + writer + director), and one role recorded under
   * two character names (Titans lists both "Hank Hall" and "Hawk").
   */
  test("ONE card per title, however many ways they are credited on it", () => {
    const db = indexOf(TITLES, PEOPLE, CREDITS);
    const page = personPage(db, "nm-nolan");
    const seen = page?.credits.map((c) => c.tconst) ?? [];
    expect(new Set(seen).size).toBe(seen.length);
    // Nolan wrote AND directed Inception: one card, both roles on it.
    const incep = page?.credits.find((c) => c.tconst === "tt-incep");
    expect(incep?.categories.sort()).toEqual(["director", "writer"]);
  });

  test("total counts TITLES, not credit rows", () => {
    // Otherwise "37 credits" over 34 cards reads as a missing-rows bug.
    const page = personPage(indexOf(TITLES, PEOPLE, CREDITS), "nm-nolan");
    expect(page?.total).toBe(2);
  });

  test("two character names on one title collapse into one card", () => {
    const db = indexOf(
      TITLES,
      [{ nconst: "nm-hawk", name: "Alan Ritchson" }],
      [
        { tconst: "tt-incep", nconst: "nm-hawk", category: "actor", ordering: 1, characters: "Hank Hall" },
        { tconst: "tt-incep", nconst: "nm-hawk", category: "actor", ordering: 2, characters: "Hawk" },
      ],
    );
    const page = personPage(db, "nm-hawk");
    expect(page?.credits).toHaveLength(1);
    expect(page?.credits[0].characters).toBe("Hank Hall, Hawk");
    // Billing order is the BEST of the rows -- being second-billed under one alias does
    // not make them a lesser credit on the title.
    expect(page?.credits[0].ordering).toBe(1);
  });

  test("carries the roles, so a filmography reads as one", () => {
    const page = personPage(indexOf(TITLES, PEOPLE, CREDITS), "nm-leo");
    const incep = page?.credits.find((c) => c.tconst === "tt-incep");
    expect(incep?.characters).toBe("Dom Cobb");
    expect(incep?.categories).toEqual(["actor"]);
  });

  test("counts every category over ALL credits, not over the page", () => {
    // A page of 60 says nothing about the other 200; counting the page would print a
    // number that shrinks as you scroll.
    const page = personPage(indexOf(TITLES, PEOPLE, CREDITS), "nm-nolan", { limit: 1 });
    expect(page?.credits).toHaveLength(1);
    // Two TITLES, though three credit rows -- he wrote and directed one of them.
    expect(page?.total).toBe(2);
    expect(page?.categories).toEqual([
      { category: "director", count: 2 },
      { category: "writer", count: 1 },
    ]);
  });

  test("filters to one category without disturbing the counts", () => {
    const page = personPage(indexOf(TITLES, PEOPLE, CREDITS), "nm-nolan", { categories: ["writer"] });
    expect(page?.credits.map((c) => c.tconst)).toEqual(["tt-incep"]);
    expect(page?.total).toBe(1);
    // The category breakdown still describes the whole person.
    expect(page?.categories).toHaveLength(2);
  });

  test("several categories filter as one -- actor and actress are one job", () => {
    // The defect this guards: filtering "Acting" on a single category drops every
    // actress credit, and the page still fills with plausible rows so it looks right.
    const db = indexOf(
      TITLES,
      [{ nconst: "nm-a", name: "A" }],
      [
        { tconst: "tt-incep", nconst: "nm-a", category: "actor" },
        { tconst: "tt-dark", nconst: "nm-a", category: "actress" },
        { tconst: "tt-obscure", nconst: "nm-a", category: "director" },
      ],
    );
    const acting = personPage(db, "nm-a", { categories: ["actor", "actress"] });
    expect(acting?.total).toBe(2);
    expect(acting?.credits.map((c) => c.tconst).sort()).toEqual(["tt-dark", "tt-incep"]);
  });

  test("an empty category list means no filter, not 'match nothing'", () => {
    // It can only arrive from a caller that meant to pass none, and an empty page would
    // read as a bug rather than as an answer.
    const page = personPage(indexOf(TITLES, PEOPLE, CREDITS), "nm-nolan", { categories: [] });
    expect(page?.total).toBe(2);
  });

  test("paging is stable -- the order is total, so nothing repeats across pages", () => {
    const db = indexOf(TITLES, PEOPLE, CREDITS);
    const first = personPage(db, "nm-nolan", { limit: 2, offset: 0 })?.credits ?? [];
    const second = personPage(db, "nm-nolan", { limit: 2, offset: 2 })?.credits ?? [];
    // The tconst alone is the identity now: one card per title means a title appearing
    // on two pages is a paging bug, not a second role.
    const all = [...first, ...second].map((c) => c.tconst);
    expect(new Set(all).size).toBe(all.length);
  });

  test("someone we hold no credits for is a page, not a null", () => {
    // Different from an unknown id: we know who they are, they just have nothing above
    // the floor. That renders as an empty filmography, not a broken link.
    const db = indexOf(TITLES, [...PEOPLE, { nconst: "nm-ghost", name: "Ghost" }], CREDITS);
    const page = personPage(db, "nm-ghost");
    expect(page?.person.name).toBe("Ghost");
    expect(page?.credits).toEqual([]);
    expect(page?.total).toBe(0);
  });

  test("an unknown id is null", () => {
    expect(personPage(indexOf(TITLES, PEOPLE, CREDITS), "nm-nobody")).toBeNull();
  });
});

describe("personPage sort", () => {
  /**
   * The fixture is chosen so the two orderings DISAGREE: The Dark Knight is older and has
   * more votes than Inception, so a test whose data happened to agree on both keys would
   * pass against a `sort` parameter that was silently ignored.
   */
  const creditsOf = (sort?: "votes" | "year") =>
    personPage(indexOf(TITLES, PEOPLE, CREDITS), "nm-nolan", { sort })?.credits.map((c) => c.tconst);

  test("defaults to votes, so every existing caller means what it meant", () => {
    expect(creditsOf()).toEqual(["tt-dark", "tt-incep"]);
    expect(creditsOf("votes")).toEqual(["tt-dark", "tt-incep"]);
  });

  test("'year' reads the filmography newest-first instead", () => {
    expect(creditsOf("year")).toEqual(["tt-incep", "tt-dark"]);
  });

  /**
   * Both orderings end in `t.tconst`, which is what makes them TOTAL. Without it two
   * titles tying on both columns could swap between pages, and the reader would see one
   * of them twice and the other never.
   */
  test("paging stays stable under either ordering", () => {
    const db = indexOf(TITLES, PEOPLE, CREDITS);
    for (const sort of ["votes", "year"] as const) {
      const first = personPage(db, "nm-nolan", { sort, limit: 1, offset: 0 })?.credits ?? [];
      const second = personPage(db, "nm-nolan", { sort, limit: 1, offset: 1 })?.credits ?? [];
      const all = [...first, ...second].map((c) => c.tconst);
      expect(new Set(all).size).toBe(all.length);
    }
  });

  /** The counts describe ALL their credits, so reordering a page cannot move them. */
  test("the category counts and the total do not move with the ordering", () => {
    const db = indexOf(TITLES, PEOPLE, CREDITS);
    const byVotes = personPage(db, "nm-nolan", { sort: "votes" });
    const byYear = personPage(db, "nm-nolan", { sort: "year" });
    expect(byYear?.total).toBe(byVotes?.total ?? -1);
    expect(byYear?.categories).toEqual(byVotes?.categories ?? []);
  });

  /** The two chips compose with the role chips above them rather than replacing them. */
  test("sorting composes with a category filter", () => {
    const db = indexOf(TITLES, PEOPLE, CREDITS);
    const page = personPage(db, "nm-nolan", { sort: "year", categories: ["director"] });
    expect(page?.credits.map((c) => c.tconst)).toEqual(["tt-incep", "tt-dark"]);
  });
});

/**
 * Who a person keeps working with -- the cheapest edge on the discovery graph, and the one
 * with the most ways to lie. The fixture is built so every rank key is exercised by a pair
 * that DISAGREES on it: `nm-crew` outranks everyone on shared titles, `nm-caine` and
 * `nm-pfister` tie on both numbers and can only be separated by name, and `nm-early` ties
 * the two of them on shared titles while losing on how watched that shared work is.
 */
describe("frequentCollaborators", () => {
  const CAST = [
    { nconst: "nm-nolan", name: "Christopher Nolan" },
    { nconst: "nm-crew", name: "Lee Smith" },
    { nconst: "nm-caine", name: "Michael Caine" },
    { nconst: "nm-pfister", name: "Wally Pfister" },
    { nconst: "nm-early", name: "Ana Early" },
    { nconst: "nm-leo", name: "Leonardo DiCaprio" },
  ];

  const WORK: CreditFix[] = [
    // Nolan holds TWO credits on Inception, so any count that measured credit rows rather
    // than titles would inflate every collaborator he has on it.
    { tconst: "tt-incep", nconst: "nm-nolan", category: "director" },
    { tconst: "tt-incep", nconst: "nm-nolan", category: "writer" },
    { tconst: "tt-dark", nconst: "nm-nolan", category: "director" },
    { tconst: "tt-obscure", nconst: "nm-nolan", category: "director" },
    { tconst: "tt-incep", nconst: "nm-crew", category: "editor" },
    { tconst: "tt-dark", nconst: "nm-crew", category: "editor" },
    { tconst: "tt-obscure", nconst: "nm-crew", category: "editor" },
    { tconst: "tt-incep", nconst: "nm-caine", category: "actor" },
    { tconst: "tt-dark", nconst: "nm-caine", category: "actor" },
    { tconst: "tt-incep", nconst: "nm-pfister", category: "cinematographer" },
    { tconst: "tt-dark", nconst: "nm-pfister", category: "cinematographer" },
    // The same two shared titles as Caine on paper, but one of them is Early Short.
    { tconst: "tt-incep", nconst: "nm-early", category: "actress" },
    { tconst: "tt-obscure", nconst: "nm-early", category: "actor" },
    { tconst: "tt-incep", nconst: "nm-leo", category: "actor" },
  ];

  const db = () => indexOf(TITLES, CAST, WORK);
  const names = (c: { name: string }[]) => c.map((x) => x.name);

  test("ranks on shared titles first -- who they keep coming back to", () => {
    const collaborators = frequentCollaborators(db(), "nm-nolan");
    expect(collaborators[0]).toMatchObject({ nconst: "nm-crew", shared: 3 });
  });

  test("ties on shared titles break on how watched the shared work is", () => {
    // Caine and Early both share two titles with Nolan; Caine's second is The Dark Knight
    // and Early's is a 900-vote short. Same number, very different answer to "who do I
    // know them from together".
    const collaborators = frequentCollaborators(db(), "nm-nolan");
    expect(names(collaborators)).toEqual(["Lee Smith", "Michael Caine", "Wally Pfister", "Ana Early"]);
  });

  test("the order is TOTAL, so the pane does not reshuffle between visits", () => {
    // Caine and Pfister tie on shared titles AND on votes -- only the name and the id
    // separate them, and a list that reordered on every visit would be worse than one
    // that is merely imperfect.
    const fixture = db();
    expect(names(frequentCollaborators(fixture, "nm-nolan"))).toEqual(
      names(frequentCollaborators(fixture, "nm-nolan")),
    );
  });

  test("one shared title is a coincidence, not an edge", () => {
    // DiCaprio stood in exactly one Nolan film. Listing him would make "frequently works
    // with" mean "was once in a room with".
    expect(names(frequentCollaborators(db(), "nm-nolan"))).not.toContain("Leonardo DiCaprio");
  });

  test("counts TITLES, not credit rows", () => {
    // Nolan wrote AND directed Inception. Caine shares two FILMS with him, and "3 titles"
    // over two posters is the same lie a filmography total tells when it counts rows.
    const caine = frequentCollaborators(db(), "nm-caine");
    expect(caine.find((c) => c.nconst === "nm-nolan")?.shared).toBe(2);
  });

  test("never lists the person themself", () => {
    expect(frequentCollaborators(db(), "nm-nolan").map((c) => c.nconst)).not.toContain("nm-nolan");
  });

  test("carries the collaborator's OWN job on the shared work", () => {
    // What tells a reader whether this is a co-star or the director who keeps casting
    // them. Distinct and merged, because the aggregate is one of aggregates: `actor` and
    // `actress` arrive as two rows and are one person's one job.
    const early = frequentCollaborators(db(), "nm-nolan").find((c) => c.nconst === "nm-early");
    expect(early?.categories).toEqual(["actor", "actress"]);
    const crew = frequentCollaborators(db(), "nm-nolan").find((c) => c.nconst === "nm-crew");
    expect(crew?.categories).toEqual(["editor"]);
  });

  test("the floor is a parameter, so a caller can ask the looser question", () => {
    const everyone = frequentCollaborators(db(), "nm-nolan", { minShared: 1 });
    expect(names(everyone)).toContain("Leonardo DiCaprio");
  });

  test("limit caps the pane without changing the ranking", () => {
    expect(names(frequentCollaborators(db(), "nm-nolan", { limit: 2 }))).toEqual([
      "Lee Smith",
      "Michael Caine",
    ]);
  });

  test("nobody worth naming is an EMPTY list, which the pane draws as nothing", () => {
    // The failure this guards is a heading over an empty row -- the same one a collection
    // pane was filed for. A person with no repeat collaborator gets no pane at all.
    expect(frequentCollaborators(db(), "nm-leo")).toEqual([]);
  });

  test("an unknown id is an empty list rather than an error", () => {
    expect(frequentCollaborators(db(), "nm-nobody")).toEqual([]);
  });
});

describe("nconstsByNameForTitle", () => {
  test("maps the names on a title to our own ids", () => {
    const map = nconstsByNameForTitle(indexOf(TITLES, PEOPLE, CREDITS), "tt-incep");
    expect(map.get(personNameKey("Leonardo DiCaprio"))).toBe("nm-leo");
    expect(map.get(personNameKey("Christopher Nolan"))).toBe("nm-nolan");
  });

  test("one person holding several credits on a title is not ambiguity", () => {
    // Nolan wrote AND directed Inception -- two rows, one person. Poisoning that entry
    // would unlink the most confidently-known name on the page.
    const map = nconstsByNameForTitle(indexOf(TITLES, PEOPLE, CREDITS), "tt-incep");
    expect(map.get(personNameKey("Christopher Nolan"))).toBe("nm-nolan");
  });

  test("two DIFFERENT people sharing a name on one title resolve to nothing", () => {
    // Sending a reader to the wrong filmography is worse than leaving plain text.
    const db = indexOf(
      TITLES,
      [
        { nconst: "nm-jw1", name: "John Williams" },
        { nconst: "nm-jw2", name: "John Williams" },
      ],
      [
        { tconst: "tt-incep", nconst: "nm-jw1", category: "actor" },
        { tconst: "tt-incep", nconst: "nm-jw2", category: "writer" },
      ],
    );
    expect(nconstsByNameForTitle(db, "tt-incep").has(personNameKey("John Williams"))).toBe(false);
  });

  test("the same name on a DIFFERENT title is not a conflict", () => {
    // Scoping to the title is what makes matching on a name safe at all.
    const db = indexOf(
      TITLES,
      [
        { nconst: "nm-jw1", name: "John Williams" },
        { nconst: "nm-jw2", name: "John Williams" },
      ],
      [
        { tconst: "tt-incep", nconst: "nm-jw1", category: "actor" },
        { tconst: "tt-dark", nconst: "nm-jw2", category: "actor" },
      ],
    );
    expect(nconstsByNameForTitle(db, "tt-incep").get(personNameKey("John Williams"))).toBe("nm-jw1");
    expect(nconstsByNameForTitle(db, "tt-dark").get(personNameKey("John Williams"))).toBe("nm-jw2");
  });

  test("a title we hold no credits for is an empty map, not an error", () => {
    expect(nconstsByNameForTitle(indexOf(TITLES, PEOPLE, CREDITS), "tt-nothing").size).toBe(0);
  });
});

describe("nconstsForCredits", () => {
  /** The fixture index plus a crosswalk, which is how a real index carries both. */
  function indexWithCrosswalk(pairs: { nconst: string; tmdb: number }[]): Database {
    const db = indexOf(TITLES, PEOPLE, CREDITS);
    loadPersonCrosswalk(db, pairs);
    return db;
  }

  const credit = (name: string, personId: string | null): PersonCredit => ({
    name,
    personId,
    image: null,
  });

  test("keys the answer by the credit's own personId string", () => {
    const db = indexWithCrosswalk([{ nconst: "nm-leo", tmdb: 6193 }]);
    expect(nconstsForCredits(db, [credit("Leonardo DiCaprio", "tmdb:6193")])).toEqual(
      new Map([["tmdb:6193", "nm-leo"]]),
    );
  });

  /**
   * The reason this card exists. Both Peter Mileses are real IMDb people and the NAME join
   * cannot tell them apart -- an id can, and does, without ever looking at the string. The
   * name here is deliberately the wrong person's.
   */
  test("the id decides, not the name", () => {
    const db = indexWithCrosswalk([{ nconst: "nm-nolan", tmdb: 525 }]);
    expect(nconstsForCredits(db, [credit("Leonardo DiCaprio", "tmdb:525")])).toEqual(
      new Map([["tmdb:525", "nm-nolan"]]),
    );
  });

  test("a credit with no id, or an id we do not hold, yields no entry", () => {
    const db = indexWithCrosswalk([{ nconst: "nm-leo", tmdb: 6193 }]);
    expect(nconstsForCredits(db, [credit("Somebody", null), credit("Stranger", "tmdb:99")]).size).toBe(0);
  });

  /**
   * A provider we hold no crosswalk for is not an error and not a guess: `tvdb:12` is a real
   * id in an id space we cannot cross, so the credit falls through to the name half.
   */
  test("an id in a namespace we cannot cross yields no entry", () => {
    const db = indexWithCrosswalk([{ nconst: "nm-leo", tmdb: 6193 }]);
    expect(nconstsForCredits(db, [credit("Leonardo DiCaprio", "tvdb:6193")]).size).toBe(0);
  });

  test("no credits is an empty map and no query", () => {
    expect(nconstsForCredits(indexWithCrosswalk([]), []).size).toBe(0);
  });
});

describe("SearchEngine against an index without cast tables", () => {
  /** The pre-cast schema: everything `SCHEMA` had before `person`/`title_principal`. */
  const OLD_SCHEMA = SCHEMA.slice(0, SCHEMA.indexOf("-- People,"));

  function oldIndex(): string {
    const path = join(dir, `${crypto.randomUUID()}.db`);
    const db = new Database(path, { create: true });
    db.run(OLD_SCHEMA);
    db.query(
      "insert into title (tconst, kind, title, year, votes, rating, genres) values ('tt-x', 'movie', 'X', 2000, 5000, 7, 'Drama')",
    ).run();
    db.close();
    return path;
  }

  const cfg = { index: { fuzzyMinVotes: 100 } } as unknown as Config;

  /**
   * The regression this exists for: `hasPeople` was a FIELD INITIALIZER, and those run
   * before the constructor body. It called `this.tableExists()` while `this.db` was still
   * undefined, so merely CONSTRUCTING a SearchEngine threw -- which took out the canary
   * gate and would have taken out the server on boot. Caught by a real build, not by the
   * suite, which is why it is pinned here.
   */
  test("constructing against an old index does not throw", () => {
    expect(() => new SearchEngine(oldIndex(), cfg)).not.toThrow();
  });

  test("hasPeople is false, and person queries degrade instead of erroring", () => {
    const engine = new SearchEngine(oldIndex(), cfg);
    expect(engine.hasPeople).toBe(false);
    // `no such table: person` against exactly the index most likely to be live during a
    // rollout would be the worst possible time for it.
    expect(engine.personPage("nm-leo")).toBeNull();
    expect(engine.personLinks("tt-x", [])).toEqual({ byId: {}, byName: {} });
    // Empty rather than null: the person page draws no collaborator pane, exactly as it
    // does for somebody who simply has no repeat collaborator.
    expect(engine.frequentCollaborators("nm-leo")).toEqual([]);
  });

  test("hasPeople is true once the tables are there", () => {
    const path = join(dir, `${crypto.randomUUID()}.db`);
    const db = new Database(path, { create: true });
    db.run(SCHEMA);
    db.close();
    expect(new SearchEngine(path, cfg).hasPeople).toBe(true);
  });

  /**
   * The two halves are two STAGES, and the window between them is real: an index built
   * before the person crosswalk shipped has cast tables and no `person_external`. Asking it
   * for the id half must return nothing rather than `no such table`.
   */
  test("an index with people but no person crosswalk still answers the name half", () => {
    const path = join(dir, `${crypto.randomUUID()}.db`);
    const db = new Database(path, { create: true });
    db.run(SCHEMA);
    db.run("drop table person_external");
    db.run("insert into title (tconst, kind, title) values ('tt-x', 'movie', 'X')");
    db.run("insert into person (rowid_, nconst, name) values (1, 'nm-leo', 'Leonardo DiCaprio')");
    db.run(
      "insert into title_principal (title_rowid, person_rowid, category, ordering) values (1,1,'actor',0)",
    );
    db.close();

    const engine = new SearchEngine(path, cfg);
    expect(engine.hasPersonIds).toBe(false);
    expect(
      engine.personLinks("tt-x", [{ name: "Leonardo DiCaprio", personId: "tmdb:6193", image: null }]),
    ).toEqual({ byId: {}, byName: { "leonardo dicaprio": "nm-leo" } });
  });
});

describe("personNameKey", () => {
  test("folds case and surrounding space, and nothing else", () => {
    expect(personNameKey("  Leonardo DiCaprio ")).toBe(personNameKey("leonardo dicaprio"));
    // Punctuation is DELIBERATELY kept: a conservative fold that misses a match costs one
    // unlinked name, an eager one sends a reader to the wrong person.
    expect(personNameKey("Louis C.K.")).not.toBe(personNameKey("Louis CK"));
  });
});
