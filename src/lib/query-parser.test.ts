import { describe, expect, test } from "bun:test";
import { kindScore, parseQuery, recencyScore, yearScore } from "./query-parser";

describe("parseQuery -- years", () => {
  test("extracts a trailing year and removes it from the text", () => {
    const p = parseQuery("The Matrix 1999");
    expect(p.year).toBe(1999);
    expect(p.text).toBe("The Matrix");
  });

  test("extracts a parenthesised year", () => {
    const p = parseQuery("Dune (1984)");
    expect(p.year).toBe(1984);
    expect(p.text.trim()).toBe("Dune");
  });

  /**
   * The trap: some titles ARE years. Stripping the number would leave nothing to
   * search on, or worse, search for the wrong thing.
   */
  test("does not strip a year that is the whole title", () => {
    expect(parseQuery("1917").year).toBeUndefined();
    expect(parseQuery("2012").year).toBeUndefined();
    expect(parseQuery("1984").year).toBeUndefined();
  });

  test("keeps a number that is part of the title", () => {
    const p = parseQuery("blade runner 2049");
    expect(p.year).toBeUndefined();
    expect(p.text).toContain("2049");
  });

  test("rejects implausible years", () => {
    expect(parseQuery("Title 1234").year).toBeUndefined();
    expect(parseQuery("Title 2999").year).toBeUndefined();
  });

  test("extracts a decade", () => {
    const p = parseQuery("horror 1980s");
    expect(p.decade).toBe(1980);
    expect(p.text).toBe("horror");
  });
});

describe("parseQuery -- type and season", () => {
  test("season marker implies a series and is stripped", () => {
    const p = parseQuery("stranger things s3");
    expect(p.season).toBe(3);
    expect(p.kind).toBe("tvSeries");
    expect(p.text).toBe("stranger things");
  });

  test("season and episode together", () => {
    const p = parseQuery("the office s2e5");
    expect(p.season).toBe(2);
    expect(p.episode).toBe(5);
    expect(p.kind).toBe("tvSeries");
  });

  test("explicit type words set the hint", () => {
    expect(parseQuery("silo series").kind).toBe("tvSeries");
    expect(parseQuery("dune movie").kind).toBe("movie");
    expect(parseQuery("the office tv series").kind).toBe("tvSeries");
  });
});

describe("parseQuery -- release junk", () => {
  test("strips scene tags people paste from release names", () => {
    const p = parseQuery("bridgerton 1080p x265 WEB-DL");
    expect(p.text.toLowerCase()).toBe("bridgerton");
    expect(p.stripped.length).toBeGreaterThan(0);
  });

  test("a query that is ONLY junk falls back to the raw input", () => {
    const p = parseQuery("1080p");
    expect(p.text).toBe("1080p");
  });
});

describe("yearScore", () => {
  test("rewards an exact year and punishes a distant one", () => {
    expect(yearScore(1999, 1999)).toBe(9);
    expect(yearScore(2000, 1999)).toBe(6);
    expect(yearScore(2001, 1999)).toBe(3);
    expect(yearScore(2020, 1999)).toBeLessThan(0);
  });

  test("a missing year is penalised only when the user asked for one", () => {
    expect(yearScore(null)).toBe(0);
    expect(yearScore(null, 1999)).toBeLessThan(0);
  });

  test("decade windows", () => {
    expect(yearScore(1985, undefined, 1980)).toBe(6);
    expect(yearScore(1995, undefined, 1980)).toBeLessThan(0);
  });
});

describe("kindScore", () => {
  test("no hint is neutral", () => {
    expect(kindScore("movie")).toBe(0);
  });

  test("series hint accepts miniseries too", () => {
    expect(kindScore("tvSeries", "tvSeries")).toBeGreaterThan(0);
    expect(kindScore("tvMiniSeries", "tvSeries")).toBeGreaterThan(0);
    expect(kindScore("movie", "tvSeries")).toBeLessThan(0);
  });

  test("movie hint accepts TV films", () => {
    expect(kindScore("tvMovie", "movie")).toBeGreaterThan(0);
    expect(kindScore("tvSeries", "movie")).toBeLessThan(0);
  });
});

describe("recencyScore", () => {
  test("is a small nudge, never a dominant term", () => {
    expect(recencyScore(2020)).toBeLessThanOrEqual(1.5);
    expect(recencyScore(1950)).toBe(0);
    expect(recencyScore(null)).toBe(0);
  });
});
