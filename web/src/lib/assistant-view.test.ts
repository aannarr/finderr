/**
 * The panel's pure rules.
 *
 * The one that earns its own describe block is the null score: every convenient way of
 * writing it renders as a zero, and a zero beside episodes scoring 8.9 is a claim about
 * that episode that nobody made.
 */

import { describe, expect, test } from "bun:test";
import type { AgentRequested } from "./agent-api";
import {
  argLabel,
  declinedOf,
  declinedPhrase,
  disclosureFor,
  disclosureOpen,
  episodeCode,
  episodeScore,
  formatArgValue,
  formatCost,
  formatDuration,
  formatToolArgs,
  hasScore,
  queuedOf,
  requestedDetail,
  requestedHeading,
  requestedNoun,
  retryPhrase,
  syncDisclosure,
  toggleDisclosure,
  toolCallSummary,
  toolLabel,
  toolResultText,
  toolSubject,
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

  test("an episode says which one, rather than only that it was an episode", () => {
    expect(requestedDetail({ tconst: "tt1", title: "GoT", kind: "episode", season: 2, episode: 9 })).toBe(
      "S02E09",
    );
    expect(requestedDetail({ tconst: "tt1", title: "Heat", kind: "movie" })).toBeNull();
  });
});

/**
 * THE SPLIT THAT KEEPS THE PANEL HONEST.
 *
 * `RequestOutcome` on the server reports five statuses and only `queued` spent anything.
 * The first version of this panel drew all five under "Started downloading", which turns a
 * refusal into a claim about disk and bandwidth that a reader cannot check.
 */
describe("queued versus merely attempted", () => {
  const outcomes: AgentRequested[] = [
    { tconst: "tt1", title: "Heat", kind: "movie", status: "queued" },
    { tconst: "tt2", title: "The Wire", kind: "series", status: "already_have" },
    { tconst: "tt3", title: "Nope", kind: "movie", status: "not_found" },
  ];

  test("only `queued` counts as a download", () => {
    expect(queuedOf(outcomes).map((r) => r.tconst)).toEqual(["tt1"]);
    expect(declinedOf(outcomes).map((r) => r.tconst)).toEqual(["tt2", "tt3"]);
  });

  test("the heading counts the queued ones, not everything attempted", () => {
    expect(requestedHeading(queuedOf(outcomes))).toBe("Started downloading 1 film");
  });

  /**
   * The contract this client was written against carried no status at all. Treating "did
   * not say" as a refusal is the more dangerous mistake of the two -- it would silently
   * demote every real download on such a server to a footnote.
   */
  test("an absent status counts as queued", () => {
    const noStatus: AgentRequested[] = [{ tconst: "tt1", title: "Heat", kind: "movie" }];
    expect(queuedOf(noStatus)).toHaveLength(1);
    expect(declinedOf(noStatus)).toHaveLength(0);
  });

  test("every declined status has words of its own", () => {
    for (const status of ["already_have", "already_requested", "not_found", "refused"] as const) {
      expect(declinedPhrase(status)).not.toBe("not requested");
    }
  });
});

/**
 * A TOOL CALL, IN A READER'S WORDS.
 *
 * `list_episodes` with `{"tconst":"tt0944947","season":2}` beside it is a log line somebody
 * left on the page. These four functions are what turn it into a sentence, and each one is
 * a string that can be wrong quietly.
 */
describe("how a tool call reads", () => {
  test("every tool the agent has is named in English", () => {
    // The list is `TOOL_SCHEMAS` in `src/lib/agent/schemas.ts`. A tool added there without
    // an entry here still renders -- it just renders less well, which this pins as the
    // deliberate fallback rather than as an accident.
    for (const name of [
      "find_title",
      "find_person",
      "list_cast",
      "list_credits",
      "get_title",
      "get_person",
      "browse_titles",
      "find_connections",
      "navigate",
      "list_episodes",
      "request",
    ]) {
      expect(toolLabel(name)).not.toContain("_");
    }
  });

  /** Forward compatibility: a twelfth tool gets a slightly ugly row, never a blank one. */
  test("an unknown tool falls back to its own identifier, readably", () => {
    expect(toolLabel("count_awards")).toBe("count awards");
  });

  /** A row that could be about anything is a row nobody can follow. */
  test("the subject is the argument worth reading, not all of them", () => {
    expect(toolSubject("find_title", { name: "Heat", year: 1995 })).toBe('"Heat" · 1995');
    expect(toolSubject("list_episodes", { tconst: "tt0944947", season: 2, limit: 200 })).toBe(
      '"tt0944947" · 2',
    );
  });

  /**
   * `match` USED TO BE FILTERED OUT HERE, and this test asserted that it was.
   *
   * The rule it was defending is still right -- the subject is the interesting argument, not
   * every argument -- but `match` had been filed under diagnostics on the assumption that a
   * reader never needs it. A retry at `match: "loose"` is the DOCUMENTED response to a strict
   * search finding nothing, so the two calls carry the same `name` and differ only here, and
   * the transcript drew them as two identical rows reporting 0 matches and 5 matches. An
   * argument that makes two otherwise-identical rows disagree is the definition of one worth
   * reading. Reported by aannarr, 2026-09-06.
   */
  test("a strict and a loose search of the same name do not render identically", () => {
    const strict = toolSubject("find_title", { name: "Andrenochrome", match: "strict" });
    const loose = toolSubject("find_title", { name: "Andrenochrome", match: "loose" });
    expect(strict).not.toBe(loose);
    expect(loose).toBe('"Andrenochrome" · "loose"');
  });

  test("a tool with no arguments has no subject rather than an empty one", () => {
    expect(toolSubject("get_title", {})).toBe("");
  });

  /** IMDb's words for its two id spaces appear nowhere a reader would have learnt them. */
  test("tconst and nconst get names a reader knows", () => {
    expect(argLabel("tconst")).toBe("title");
    expect(argLabel("nconst")).toBe("person");
    expect(argLabel("min_rating")).toBe("min rating");
  });

  /** An array is a comma list; punctuation a reader has to parse past is not legibility. */
  test("values are formatted rather than stringified", () => {
    expect(formatArgValue(["actor", "actress"])).toBe('"actor", "actress"');
    expect(formatArgValue(8)).toBe("8");
    expect(formatArgValue(null)).toBe("—");
  });

  test("a long value is truncated rather than pushing the answer off screen", () => {
    expect(formatArgValue("x".repeat(400)).length).toBeLessThan(130);
  });

  /**
   * The server read the payload and we did not, so a count invented here would be a second,
   * worse answer. No summary means the row prints only its duration.
   */
  test("the result line is the server's own summary, or nothing", () => {
    expect(toolResultText("24 episodes", null)).toBe("24 episodes");
    expect(toolResultText(null, null)).toBeNull();
    expect(toolResultText("  ", null)).toBeNull();
    expect(toolResultText("24 episodes", "upstream refused")).toBe("upstream refused");
  });
});

/**
 * THE THINKING DISCLOSURE, AS A SEQUENCE.
 *
 * Every case here is a sequence rather than a single call, because the bug this exists for
 * is not expressible as one: each individual state was correct and the ORDER is what broke
 * it. It shipped, rendered correctly in every render test in this repo, and was caught by
 * opening the panel on a phone-width browser and watching three blocks of working sit open
 * under a finished answer.
 */
describe("the thinking disclosure", () => {
  test("opens itself while the block is being written", () => {
    expect(disclosureOpen(disclosureFor(true), true)).toBe(true);
  });

  test("and a settled one stays shut", () => {
    expect(disclosureOpen(disclosureFor(false), false)).toBe(false);
  });

  /**
   * THE REGRESSION, measured in a browser 2026-09-05.
   *
   * `<details>` fires `toggle` when its ATTRIBUTE changes, not only when a human clicks it.
   * So React opening a live block fires the handler, the reader's choice latches `true`, and
   * the block can never fold again -- a settled answer buried under its own working, which
   * is the state this whole pane is arranged to prevent. There is no `isTrusted` to filter
   * on: a programmatic toggle and a real one are the same event.
   */
  test("folds when the thinking stops, even though React's own open fired a toggle", () => {
    let d = disclosureFor(true);
    expect(disclosureOpen(d, true)).toBe(true);
    // React set `open`; the browser fired `toggle` back at us with the value we just drove.
    d = toggleDisclosure(d, true);
    expect(disclosureOpen(d, true)).toBe(true);
    // A tool call lands after it, so this block is finished and must fold.
    expect(disclosureOpen(d, false)).toBe(false);
  });

  test("a reader who closes it mid-stream keeps it closed while tokens keep arriving", () => {
    const d = toggleDisclosure(disclosureFor(true), false);
    expect(disclosureOpen(d, true)).toBe(false);
  });

  test("a reader who opens a finished one keeps it open, and can close it again", () => {
    let d = toggleDisclosure(disclosureFor(false), true);
    expect(disclosureOpen(d, false)).toBe(true);
    d = toggleDisclosure(d, false);
    expect(disclosureOpen(d, false)).toBe(false);
  });

  /** Spending the choice is what the reset does, and only a CHANGE in `live` spends it. */
  test("`live` staying the same never discards the reader's choice", () => {
    const d = toggleDisclosure(disclosureFor(false), true);
    // Identity, not just equality: the component compares by reference to decide whether to
    // set state during render, and a fresh object every call would loop forever.
    expect(syncDisclosure(d, false)).toBe(d);
    expect(syncDisclosure(d, true).choice).toBeNull();
  });
});
