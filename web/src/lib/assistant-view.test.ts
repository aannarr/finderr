/**
 * The panel's pure rules.
 *
 * The one that earns its own describe block is the null score: every convenient way of
 * writing it renders as a zero, and a zero beside episodes scoring 8.9 is a claim about
 * that episode that nobody made.
 */

import { describe, expect, test } from "bun:test";
import {
  episodeCode,
  episodeScore,
  formatCost,
  formatDuration,
  formatToolArgs,
  hasScore,
  requestedHeading,
  requestedNoun,
  retryPhrase,
  toolCallSummary,
} from "./assistant-view";

describe("episode codes", () => {
  test("pad to two digits so a list lines up", () => {
    expect(episodeCode(2, 9)).toBe("S02E09");
    expect(episodeCode(10, 12)).toBe("S10E12");
  });

  /** Season 0 is the specials, and every series has one -- see `orderSeasons`. */
  test("season 0 is a real season and prints as one", () => {
    expect(episodeCode(0, 1)).toBe("S00E01");
  });
});

describe("a missing score", () => {
  test("says so in words and NEVER renders as a number", () => {
    expect(episodeScore(null)).toBe("no score yet");
    expect(episodeScore(null)).not.toContain("0");
  });

  test("a real score keeps one decimal, including a whole one", () => {
    expect(episodeScore(9.2)).toBe("9.2");
    expect(episodeScore(8)).toBe("8.0");
  });

  /**
   * A genuine zero is not the same fact as an absent one, and the renderer styles the two
   * differently -- so the predicate has to tell them apart rather than falling for `!rating`.
   */
  test("zero is a score, and is not confused with having none", () => {
    expect(hasScore(0)).toBe(true);
    expect(hasScore(null)).toBe(false);
    expect(episodeScore(0)).toBe("0.0");
  });
});

describe("tool calls", () => {
  const calls = [
    { name: "search_titles", args: { q: "heist" }, ms: 12 },
    { name: "get_title", args: { tconst: "tt1375666" }, ms: 400 },
  ];

  test("the summary is the count and the total, which is what the collapsed line is for", () => {
    expect(toolCallSummary(calls)).toBe("2 lookups · 412ms");
  });

  test("one is singular", () => {
    expect(toolCallSummary([calls[0]])).toBe("1 lookup · 12ms");
  });

  test("no calls at all still produces a sentence rather than a NaN", () => {
    expect(toolCallSummary([])).toBe("0 lookups · 0ms");
  });

  test("arguments are truncated, because they are diagnostics rather than content", () => {
    const long = formatToolArgs({ q: "x".repeat(400) }, 40);
    expect(long).toHaveLength(40);
    expect(long.endsWith("…")).toBe(true);
  });

  test("short arguments are printed whole", () => {
    expect(formatToolArgs({ q: "heist" })).toBe('{"q":"heist"}');
  });
});

describe("numbers a reader sees", () => {
  test("milliseconds under a second, seconds over it", () => {
    expect(formatDuration(412)).toBe("412ms");
    expect(formatDuration(2400)).toBe("2.4s");
  });

  test("a cost keeps four decimals, because a turn is a fraction of a cent", () => {
    expect(formatCost(0.0031)).toBe("$0.0031");
  });

  /** `$0.0000` on every answer would make the number worthless. */
  test("a cost too small for four decimals says so rather than rounding to nothing", () => {
    expect(formatCost(0.000_01)).toBe("<$0.0001");
  });

  test("free is free, not '<$0.0001'", () => {
    expect(formatCost(0)).toBe("$0.0000");
  });

  test("a nonsense number is a dash, not NaN on screen", () => {
    expect(formatDuration(Number.NaN)).toBe("—");
    expect(formatCost(Number.NaN)).toBe("—");
  });
});

describe("when the budget comes back", () => {
  const now = new Date("2026-09-05T12:00:00Z");

  test("reads as a wait rather than as a wall", () => {
    // `formatAge` owns the wording; this only has to hand it the right instant.
    expect(retryPhrase(720, now)).toBe("in 12 minutes");
  });

  /** A zero or a missing header means we were told nothing, and inventing a time is worse. */
  test("says nothing at all when the server did not say", () => {
    expect(retryPhrase(0, now)).toBeNull();
    expect(retryPhrase(Number.NaN, now)).toBeNull();
  });
});

describe("what was requested", () => {
  /**
   * The blunt sentence is the point. "Requested" could mean it looked one up; "Started
   * downloading" cannot be misread by somebody skimming.
   */
  test("names the KIND for a single title, because the sizes differ", () => {
    expect(requestedHeading([{ tconst: "tt1", title: "Heat", kind: "movie" }])).toBe(
      "Started downloading 1 film",
    );
    expect(requestedHeading([{ tconst: "tt2", title: "The Wire", kind: "series" }])).toBe(
      "Started downloading 1 series",
    );
  });

  test("several are counted rather than listed twice", () => {
    expect(
      requestedHeading([
        { tconst: "tt1", title: "Heat", kind: "movie" },
        { tconst: "tt2", title: "The Wire", kind: "series" },
      ]),
    ).toBe("Started downloading 2 titles");
  });

  test("every kind in the contract has a noun", () => {
    for (const kind of ["movie", "series", "episode"] as const) {
      expect(requestedNoun(kind)).not.toBe("title");
    }
  });
});
