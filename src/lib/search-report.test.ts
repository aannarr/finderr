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

  test("finds the non-English queries -- the whole case for the akas dump", () => {
    // Q5. If this is always empty, `finderr-localized-release-titles-via-title-akas` is a
    // 512 MB download bought on a guess.
    const r = buildSearchReport([search("Jägarna", 1), search("hunters", 2)], []);

    expect(r.nonAscii).toEqual([{ query: "Jägarna", n: 1 }]);
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

  test("prints canary candidates with the rank that condemns them", () => {
    const text = formatSearchReport(
      buildSearchReport([search("budapest hostel", 1)], [click("budapest hostel", 4, 1, "tt0475290")]),
      false,
    );

    expect(text).toContain("CANARY CANDIDATES");
    expect(text).toContain("rank 4  tt0475290  budapest hostel");
  });
});
