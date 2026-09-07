import { describe, expect, test } from "bun:test";
import { anticipationWeight, kindScore, parseQuery, recencyScore, yearScore } from "./query-parser";

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

  /**
   * The plural is how people describe a SET rather than name one title -- "swedish crime
   * films", "korean shows" -- and leaving it in the text put `films` up against titles.
   */
  test("plural type words set the hint and leave the text", () => {
    const films = parseQuery("swedish crime films");
    expect(films.kind).toBe("movie");
    expect(films.text).toBe("swedish crime");

    const shows = parseQuery("korean shows");
    expect(shows.kind).toBe("tvSeries");
    expect(shows.text).toBe("korean");

    expect(parseQuery("scary movies").kind).toBe("movie");
  });

  /**
   * `seasons` is a plural noun, not a way of saying "a series" -- "The Four Seasons" is a
   * title -- so it is the one plural deliberately left out of the list.
   */
  test("'seasons' is not a type word", () => {
    const p = parseQuery("the four seasons");
    expect(p.kind).toBeUndefined();
    expect(p.text).toBe("the four seasons");
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

/**
 * The anticipation curve: how much credit a title gets for not being out yet.
 *
 * A FIXED `now` in every case. `new Date()` would make these assertions expire, and the
 * one thing worse than an untested curve is one whose tests go red on New Year's Day.
 */
describe("anticipationWeight", () => {
  const now = new Date("2026-09-05T00:00:00Z");
  const w = (year: number | null) => anticipationWeight(year, now);

  test("a title out this year or next gets full weight", () => {
    // The current year counts as unreleased, and that is the honest reading of a year-only
    // stamp rather than a rounding allowance: a film dated 2026, read in September 2026,
    // may still come out in November and nothing in the index can say otherwise.
    expect(w(2026)).toBe(1);
    expect(w(2027)).toBe(1);
  });

  test("it tapers into the future and is gone by the speculative end", () => {
    // Half at one scale past the plateau, which is Elasticsearch's own definition of the
    // decay parameter. The point of the taper is that a 2031 slate entry gets nothing.
    expect(w(2028)).toBeCloseTo(0.5, 6);
    expect(w(2029)).toBeCloseTo(0.0625, 4);
    expect(w(2031)).toBeLessThan(0.001);
  });

  test("it decays behind with no plateau, because a zero starts to be evidence", () => {
    // Half a year behind, near-nothing at two, gone by three. The past side has no plateau
    // at all, which is what keeps it strictly under the future side at every distance even
    // though the two scales are now the same number.
    expect(w(2025)).toBeCloseTo(0.5, 6);
    expect(w(2024)).toBeCloseTo(0.0625, 4);
    expect(w(2023)).toBeLessThan(0.01);
    expect(w(1994)).toBe(0);
  });

  test("the past side is strictly steeper than the future side, at every distance", () => {
    // Stated as a property rather than as more numbers: whatever the constants become,
    // being a year late must never be worth as much as being a year early.
    for (const d of [1, 2, 3, 4]) expect(w(2026 - d)).toBeLessThan(w(2026 + d));
  });

  test("it never leaves [0, 1], for anything a dump can contain", () => {
    // The blend in `popularity` multiplies by this, so a weight outside the unit interval
    // would either do nothing or lift a title past the prior it is being shrunk toward.
    for (const y of [null, 0, 1874, 1900, 2026, 2050, 9999]) {
      expect(w(y)).toBeGreaterThanOrEqual(0);
      expect(w(y)).toBeLessThanOrEqual(1);
    }
  });

  test("an undated title is credited with nothing, never guessed at", () => {
    // The same rule `applyRank` follows for an unrated one: no year is the absence of a
    // fact, and imputing a release date would be inventing the very thing being measured.
    expect(w(null)).toBe(0);
  });

  test("it steps on whole years rather than drifting daily", () => {
    // Deliberate: the index carries no finer date, and a weight that moved every day would
    // reorder an identical query overnight. "Fair ranking" here means stable.
    const janOne = new Date("2026-01-01T00:00:00Z");
    const newYearsEve = new Date("2026-12-31T23:59:59Z");
    expect(anticipationWeight(2027, janOne)).toBe(anticipationWeight(2027, newYearsEve));
    expect(anticipationWeight(2026, janOne)).toBe(anticipationWeight(2026, newYearsEve));
  });
});
