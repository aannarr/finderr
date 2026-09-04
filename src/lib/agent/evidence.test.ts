/**
 * What counts as a tool having RETURNED a connection, and what does not.
 *
 * The distinction under test is one shape apart and it is the entire file: one `list_cast`
 * over two titles establishes what they share, two `list_cast` calls over one title each
 * establish nothing between them. Everything below is a variation on that.
 *
 * No database and no fixture index -- `evidenceFrom` reads a tool's return VALUE, so the
 * payloads are written out literally here. That is deliberate: a test that built them by
 * running the tools would be measuring the tools, and this file is about what a reader of
 * their output is entitled to conclude.
 */

import { describe, expect, test } from "bun:test";
import { evidenceFrom, hasJoin, joinKey } from "./evidence";

const FURIOUS = "tt36303968";
const BEAR = "tt14452776";
const SHAMELESS = "tt1586680";
const ROSSUM = "nm0002536";
const WHITE = "nm2087739";

/** The union of everything a whole run established, as the grader assembles it. */
function joinsOf(...calls: [string, unknown][]): Set<string> {
  const out = new Set<string>();
  for (const [tool, payload] of calls) for (const j of evidenceFrom(tool, payload).joins) out.add(j);
  return out;
}

describe("joinKey", () => {
  test("is direction-free, so one relation is one key", () => {
    expect(joinKey(FURIOUS, BEAR)).toBe(joinKey(BEAR, FURIOUS));
  });
});

describe("the measured failure: two cast lists compared by eye", () => {
  /*
    This is the 2026-09-04 haiku run, reduced to its two payloads. Both titles resolved,
    both cast lists returned, and the model then said actors from The Bear appear in
    Furious. Nothing here says that, and the point of the assertion is that nothing here
    COULD -- each row's seen_in names exactly the one title its call asked about.
  */
  const furiousCast: [string, unknown] = [
    "list_cast",
    [{ nconst: ROSSUM, name: "Emmy Rossum", role: "actress", billing: 1, seen_in: [FURIOUS] }],
  ];
  const bearCast: [string, unknown] = [
    "list_cast",
    [{ nconst: WHITE, name: "Jeremy Allen White", role: "actor", billing: 1, seen_in: [BEAR] }],
  ];

  test("establishes each person in their own title", () => {
    const joins = joinsOf(furiousCast, bearCast);
    expect(hasJoin(joins, ROSSUM, FURIOUS)).toBe(true);
    expect(hasJoin(joins, WHITE, BEAR)).toBe(true);
  });

  test("establishes NOTHING between the two titles -- the join was inferred", () => {
    expect(hasJoin(joinsOf(furiousCast, bearCast), FURIOUS, BEAR)).toBe(false);
  });

  test("and nothing between the two people either", () => {
    expect(hasJoin(joinsOf(furiousCast, bearCast), ROSSUM, WHITE)).toBe(false);
  });
});

describe("one call over both titles is the database's own answer", () => {
  test("a row whose seen_in carries both ids joins the titles", () => {
    const joins = joinsOf([
      "list_cast",
      [{ nconst: ROSSUM, name: "Emmy Rossum", role: "actress", billing: 1, seen_in: [FURIOUS, SHAMELESS] }],
    ]);
    expect(hasJoin(joins, FURIOUS, SHAMELESS)).toBe(true);
  });

  test("an intersection that returned nobody establishes nothing", () => {
    // The honest empty: asked what two titles share, told nothing. That is a real answer
    // about the world and it is still not a connection.
    expect(hasJoin(joinsOf(["list_cast", []]), FURIOUS, BEAR)).toBe(false);
  });

  test("list_credits joins people through seen_with, the mirror shape", () => {
    const joins = joinsOf([
      "list_credits",
      [
        {
          tconst: SHAMELESS,
          title: "Shameless",
          year: 2011,
          kind: "tvSeries",
          votes: 338017,
          role: "actor",
          seen_with: [ROSSUM, WHITE],
        },
      ],
    ]);
    expect(hasJoin(joins, ROSSUM, WHITE)).toBe(true);
    expect(hasJoin(joins, ROSSUM, SHAMELESS)).toBe(true);
  });
});

describe("find_connections", () => {
  const path = {
    paths: [
      {
        path: [
          { id: FURIOUS, name: "Furious", kind: "title" },
          { id: ROSSUM, name: "Emmy Rossum", kind: "person" },
          { id: SHAMELESS, name: "Shameless", kind: "title" },
          { id: WHITE, name: "Jeremy Allen White", kind: "person" },
          { id: BEAR, name: "The Bear", kind: "title" },
        ],
        strength: 338017,
      },
    ],
    spent: 12,
    status: "complete",
  };

  test("a returned path joins its ENDPOINTS, which is the claim that was asked about", () => {
    expect(hasJoin(joinsOf(["find_connections", path]), FURIOUS, BEAR)).toBe(true);
  });

  test("budget_exhausted with no path establishes nothing -- we stopped looking", () => {
    const joins = joinsOf([
      "find_connections",
      { paths: [], spent: 100, status: "budget_exhausted", resume: "abc" },
    ]);
    expect(hasJoin(joins, FURIOUS, BEAR)).toBe(false);
  });
});

describe("results that carry no relation at all", () => {
  test("find_title returns ids and no joins, however many it found", () => {
    const e = evidenceFrom("find_title", {
      searched: "Furious",
      found: [
        { tconst: FURIOUS, title: "Furious", year: 2026, kind: "tvSeries", votes: 14556 },
        { tconst: "tt6054874", title: "Furious", year: 2017, kind: "movie", votes: 4258 },
      ],
    });
    expect(e.ids).toEqual([FURIOUS, "tt6054874"]);
    // Two candidates for one name are not related to each other. They are two answers.
    expect(e.joins).toEqual([]);
  });

  test("an error establishes nothing, however instructive its message", () => {
    const e = evidenceFrom("list_cast", { error: "Expected tt… ids, call find_title first." });
    expect(e).toEqual({ ids: [], joins: [] });
  });

  test("an unknown tool is not guessed at", () => {
    expect(evidenceFrom("show_title", { tconst: FURIOUS })).toEqual({ ids: [], joins: [] });
  });
});

describe("get_person", () => {
  test("collaborators are a person-to-person relation the index computed", () => {
    const joins = joinsOf([
      "get_person",
      {
        nconst: ROSSUM,
        name: "Emmy Rossum",
        credit_count: 40,
        top_credits: [{ tconst: SHAMELESS, title: "Shameless", year: 2011, kind: "tvSeries", votes: 1 }],
        collaborators: [{ nconst: WHITE, name: "Jeremy Allen White", shared: 1 }],
      },
    ]);
    expect(hasJoin(joins, ROSSUM, WHITE)).toBe(true);
    expect(hasJoin(joins, ROSSUM, SHAMELESS)).toBe(true);
    // Two people who both worked with Emmy Rossum have not thereby worked with each other.
    expect(hasJoin(joins, WHITE, SHAMELESS)).toBe(false);
  });
});
