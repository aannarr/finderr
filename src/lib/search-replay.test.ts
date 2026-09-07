import { describe, expect, test } from "bun:test";
import type { ClickRow } from "./search-log";
import { buildReplayReport, formatReplayReport, RANK_WINDOW, type RankOf } from "./search-replay";

const click = (query: string, tconst: string, rank: number, at = 1): ClickRow => ({
  query,
  tconst,
  rank,
  tier: "fts",
  at,
});

/** A scorer that puts named titles where the test says, and everything else at rank 0. */
const ranker =
  (at: Record<string, number | null>): RankOf =>
  (_query, tconst) =>
    tconst in at ? at[tconst] : 0;

describe("replaying the log's clicks", () => {
  test("puts each clicked title's rank THEN beside its rank NOW", () => {
    const r = buildReplayReport([click("dune", "tt-a", 3)], ranker({ "tt-a": 1 }));
    expect(r.clicks).toEqual([{ query: "dune", tconst: "tt-a", rankThen: 3, rankNow: 1, clicks: 1 }]);
  });

  test("collapses repeat clicks on one (query, title) and keeps the DEEPEST rank", () => {
    // A reader who found it at 0 once and at 20 another time was failed at 20: the shallow
    // click says the ordering was fine that time, not that the failure did not happen.
    const r = buildReplayReport(
      [click("dune", "tt-a", 0, 1), click("dune", "tt-a", 20, 2)],
      ranker({ "tt-a": 4 }),
    );
    expect(r.clicks).toHaveLength(1);
    expect(r.clicks[0].clicks).toBe(2);
    expect(r.clicks[0].rankThen).toBe(20);
  });

  test("two titles clicked from ONE query stay two rows", () => {
    // The log's `Swedish criminal` has three of these. Collapsing on the query alone would
    // report one of them and silently drop the other two.
    const r = buildReplayReport(
      [click("q", "tt-a", 1), click("q", "tt-b", 5)],
      ranker({ "tt-a": 1, "tt-b": 5 }),
    );
    expect(r.clicks.map((c) => c.tconst).sort()).toEqual(["tt-a", "tt-b"]);
  });

  test("a title the scorer no longer returns is scored as the window, never dropped", () => {
    // THE ASSERTION THE MEAN EXISTS FOR. A constant that lifts one title and buries another
    // out of sight would otherwise report as a pure improvement.
    const r = buildReplayReport(
      [click("q", "tt-gone", 2), click("q2", "tt-top", 2)],
      ranker({ "tt-gone": null, "tt-top": 0 }),
    );
    expect(r.meanRankNow).toBe(RANK_WINDOW / 2);
    expect(r.clicks[0].rankNow).toBeNull();
  });

  test("counts the top row at both ends, so a run states what it improved on", () => {
    const r = buildReplayReport(
      [click("a", "tt-a", 0), click("b", "tt-b", 3)],
      ranker({ "tt-a": 0, "tt-b": 0 }),
    );
    expect(r.topRowThen).toBe(1);
    expect(r.topRowNow).toBe(2);
    expect(r.meanRankThen).toBe(1.5);
    expect(r.meanRankNow).toBe(0);
  });

  test("orders the table worst-current-rank first, which is where the work is", () => {
    const r = buildReplayReport(
      [click("a", "tt-a", 0), click("b", "tt-b", 0), click("c", "tt-c", 0)],
      ranker({ "tt-a": 1, "tt-b": 9, "tt-c": 0 }),
    );
    expect(r.clicks.map((c) => c.tconst)).toEqual(["tt-b", "tt-a", "tt-c"]);
  });

  test("an empty log says so rather than printing a table of nothing", () => {
    const r = buildReplayReport([], ranker({}));
    expect(r.meanRankNow).toBe(0);
    expect(formatReplayReport(r)).toContain("nothing to replay");
  });

  test("the formatted table names the movement in both directions", () => {
    const text = formatReplayReport(
      buildReplayReport(
        [click("better", "tt-up", 5), click("worse", "tt-down", 1), click("same", "tt-flat", 2)],
        ranker({ "tt-up": 1, "tt-down": 4, "tt-flat": 2 }),
      ),
    );
    expect(text).toContain("-4");
    expect(text).toContain("+3");
    expect(text).toMatch(/\s=\s/);
  });
});
