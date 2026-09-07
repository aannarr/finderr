import { describe, expect, test } from "bun:test";
import type { ClickRow, SearchRow } from "./search-log";
import { buildSearchReport, formatSearchReport } from "./search-report";

const search = (query: string, at: number, results = 5): SearchRow => ({ query, at, results });
const click = (query: string, rank: number, at = 1_000, tconst = "tt1"): ClickRow => ({
  query,
  tconst,
  rank,
  tier: "fts",
  at,
});

const MINUTE = 60_000;

describe("buildSearchReport", () => {
  test("counts the years people actually typed", () => {
    // Q1 on the card: is the year-parsing branch dead code, or does anybody use it?
    const r = buildSearchReport(
      [search("dune 1984", 1), search("dune", 2), search("the matrix 1999", 3)],
      [],
    );

    expect(r.withYear).toBe(2);
    expect(r.searches).toBe(3);
  });

  test("names the queries that found nothing, worst first", () => {
    const r = buildSearchReport(
      [search("nonesuch", 1, 0), search("nonesuch", 2, 0), search("dune", 3, 25), search("ghost", 4, 0)],
      [],
    );

    expect(r.zeroResult).toEqual([
      { query: "nonesuch", n: 2 },
      { query: "ghost", n: 1 },
    ]);
  });

  test("finds the non-ASCII queries -- the whole case for the akas dump", () => {
    // Q5. If this is always empty, `finderr-localized-release-titles-via-title-akas` is a
    // 512 MB download bought on a guess.
    const r = buildSearchReport([search("Jägarna", 1), search("hunters", 2)], []);

    expect(r.nonAscii).toEqual([{ query: "Jägarna", n: 1 }]);
  });

  test("a pure-ASCII query in another language is invisible here, and that is the limit", () => {
    // The counter-example off the live NAS log, 2026-09-07: `Svenska kriminaldrama nya` was
    // the worst ranking failure in the whole log (rank 20, 3 clicks) and Q5 reported 0. It is
    // Swedish with no å, ä or ö in it, so the ASCII test cannot see it. Pinned so nobody reads
    // a zero from this field as "nobody searches in another language" -- see the field comment.
    const r = buildSearchReport([search("Svenska kriminaldrama nya", 1), search("Swedish criminal", 2)], []);

    expect(r.nonAscii).toEqual([]);
  });

  test("a refinement typed minutes later is a retype, one typed mid-word is not", () => {
    const r = buildSearchReport(
      [search("dune", 0), search("dune 1984", 5 * MINUTE), search("dune 1984 x", 5 * MINUTE + 200)],
      [],
    );

    // "dune" -> "dune 1984" is somebody narrowing a search by hand. The 200ms extension
    // after it is still typing, and counting it would inflate the number that decides
    // whether the chips are working.
    expect(r.retypedRefinements).toBe(1);
  });

  test("running the same query again narrows nothing, however long the gap", () => {
    // REGRESSION: the prefix test alone counted this, because a string starts with itself.
    // It matters because a chip click re-runs the identical text, so the retype half of Q4
    // was counting the chip's own gesture as evidence that nobody uses the chips.
    const r = buildSearchReport([search("dune", 0), search("Dune", 5 * MINUTE)], []);

    expect(r.retypedRefinements).toBe(0);
  });

  test("counts the searches that carried a chip, and which chip it was", () => {
    // Q4's other half: "nobody clicks a chip" and "everybody clicks kind" are different
    // findings about the facet bar, so one number could not carry both.
    const r = buildSearchReport(
      [
        { ...search("dune", 1), filters: { genre: "Sci-Fi", year: 1984 } },
        { ...search("silo", 2), filters: { genre: "Drama" } },
        search("the matrix", 3),
      ],
      [],
    );

    expect(r.chips.searches).toBe(2);
    expect(r.chips.byKey).toEqual({ genre: 2, decade: 0, year: 1, kind: 0 });
  });

  test("a chip added to a query somebody already ran is a chip refinement", () => {
    const r = buildSearchReport(
      [
        search("dune", 0),
        { ...search("dune", MINUTE), filters: { genre: "Sci-Fi" } },
        // Same chip again on a third run: nothing was narrowed, so it is not a refinement.
        { ...search("dune", 2 * MINUTE), filters: { genre: "Sci-Fi" } },
        // A DIFFERENT query that happens to carry a chip narrows nothing either.
        { ...search("silo", 3 * MINUTE), filters: { kind: "series" } },
      ],
      [],
    );

    expect(r.chips.refinements).toBe(1);
    // It is the counterpart of the retype, not a second count of the same gesture.
    expect(r.retypedRefinements).toBe(0);
  });

  test("swapping one chip for another narrows nothing", () => {
    // The reader changed their mind rather than narrowing: the result set moved sideways.
    const r = buildSearchReport(
      [
        { ...search("dune", 0), filters: { genre: "Sci-Fi" } },
        { ...search("dune", MINUTE), filters: { genre: "Drama" } },
      ],
      [],
    );

    expect(r.chips.refinements).toBe(0);
  });

  test("ranks the clicks that went deepest, because those are the scorer's failures", () => {
    const r = buildSearchReport(
      [search("budapest hostel", 1)],
      [click("budapest hostel", 3, 1, "tt0475290"), click("dune", 0), click("budapest hostel", 1)],
    );

    expect(r.clicks).toEqual({ total: 3, byRank: [1, 1, 0, 1], belowTop: 2 });
    // "dune" is absent: every click on it was on the top row, which is the scorer working.
    expect(r.rankFailures).toEqual([
      { query: "budapest hostel", worstRank: 3, clicks: 2, tconst: "tt0475290" },
    ]);
  });

  test("counts tiers only when an index was there to replay against", () => {
    const rows = [search("interstelar", 1), search("dune", 2)];

    const without = buildSearchReport(rows, []);
    expect(without.tiers.fuzzy).toBe(0);

    const withReplay = buildSearchReport(rows, [], (q) => ({
      tier: q === "interstelar" ? "fuzzy" : "fts",
      top: null,
    }));
    expect(withReplay.tiers).toMatchObject({ fuzzy: 1, fts: 1 });
  });

  test("an empty log reports a null window rather than a nonsense date range", () => {
    expect(buildSearchReport([], []).window).toBeNull();
  });
});

describe("formatSearchReport", () => {
  test("says where to look when there is nothing logged", () => {
    expect(formatSearchReport(buildSearchReport([], []), false)).toContain("/api/health");
  });

  test("refuses to report a tier breakdown it did not measure", () => {
    const text = formatSearchReport(buildSearchReport([search("dune", 1)], []), false);

    expect(text).toContain("not measured");
  });

  test("prints the chip usage beside the retypes, which is the comparison Q4 asks for", () => {
    const text = formatSearchReport(
      buildSearchReport([search("dune", 0), { ...search("dune", MINUTE), filters: { genre: "Sci-Fi" } }], []),
      false,
    );

    expect(text).toContain("chip refinements:    1");
    expect(text).toContain("searches with chips: 1 (50.0%)");
    expect(text).toContain("genre 1");
  });

  test("the Q5 heading names the characters it counts, never a language it cannot detect", () => {
    // The defect this pins: the field counted non-ASCII characters and the heading called
    // them non-English queries, so a log whose worst ranking failure was pure-ASCII Swedish
    // printed "non-English queries: 0" and read as evidence that nobody searches in another
    // language. A heading that overstates its detector is a check that measures nothing.
    const text = formatSearchReport(
      buildSearchReport([search("Jägarna", 1), search("Svenska kriminaldrama nya", 2)], []),
      false,
    );

    expect(text).toContain("non-ASCII queries:   1 (1 distinct)");
    expect(text).not.toContain("non-English");
  });

  test("prints canary candidates with the rank that condemns them", () => {
    const text = formatSearchReport(
      buildSearchReport([search("budapest hostel", 1)], [click("budapest hostel", 4, 1, "tt0475290")]),
      false,
    );

    expect(text).toContain("CANARY CANDIDATES");
    expect(text).toContain("rank 4  tt0475290  budapest hostel");
  });
});
