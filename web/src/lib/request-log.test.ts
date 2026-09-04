/**
 * The request log's rules, tested without rendering anything.
 *
 * The two that matter are ordering (a log is ordered by when it was ASKED, not by when the
 * worker last touched the row) and attribution (the browser never decides who may see a
 * name -- it reads whether the server sent one).
 */

import { describe, expect, test } from "bun:test";
import type { MediaRequest } from "./api";
import { attributionVisible, byRequester, logOrder, requesters, seasonLine } from "./request-log";

function row(over: Partial<MediaRequest> & { id: number; created_at: string }): MediaRequest {
  return {
    tconst: `tt${over.id}`,
    title: "A film",
    year: 1994,
    kind: "movie",
    service: "radarr",
    status: "queued",
    error: null,
    updated_at: over.created_at,
    seasons: null,
    requestVerdict: "queued",
    requestProgress: null,
    requestEtaAt: null,
    requestEvidence: null,
    ...over,
  } as MediaRequest;
}

describe("ordering the log", () => {
  /*
    The trap this exists for: the worker rewrites `updated_at` on every status change, so a
    week-old request retrying a stalled download would otherwise sit above everything asked
    for since -- in a list whose whole question is what was asked and when.
  */
  test("newest ASKED first, whatever the worker has touched since", () => {
    const old = row({
      id: 1,
      created_at: "2026-08-01T09:00:00.000Z",
      updated_at: "2026-09-04T09:00:00.000Z",
    });
    const recent = row({
      id: 2,
      created_at: "2026-09-03T09:00:00.000Z",
      updated_at: "2026-09-03T09:00:00.000Z",
    });

    expect(logOrder([old, recent]).map((r) => r.id)).toEqual([2, 1]);
  });

  /** Two requests made in the same millisecond share an ISO string; the order must not roll. */
  test("a tie breaks on id, so the list does not reshuffle between loads", () => {
    const a = row({ id: 7, created_at: "2026-09-03T09:00:00.000Z" });
    const b = row({ id: 8, created_at: "2026-09-03T09:00:00.000Z" });

    expect(logOrder([a, b]).map((r) => r.id)).toEqual([8, 7]);
    expect(logOrder([b, a]).map((r) => r.id)).toEqual([8, 7]);
  });

  test("it copies rather than sorting the caller's array in place", () => {
    const rows = [
      row({ id: 1, created_at: "2026-08-01T09:00:00.000Z" }),
      row({ id: 2, created_at: "2026-09-01T09:00:00.000Z" }),
    ];
    logOrder(rows);
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
  });
});

describe("who may be shown", () => {
  /*
    THE client half of the privacy rule, and it is deliberately not a rule at all: the server
    omits `requestedByName` for anybody who is not an admin, so its presence is the whole
    answer. Nothing here re-derives it from a role.
  */
  test("the column exists because the server sent a name, not because of any check here", () => {
    const attributed = row({ id: 1, created_at: "2026-09-01T09:00:00.000Z", requestedByName: "Ada" });
    const stripped = row({ id: 2, created_at: "2026-09-01T09:00:00.000Z" });

    expect(attributionVisible([attributed])).toBe(true);
    expect(attributionVisible([stripped])).toBe(false);
  });

  /** A name the server sent as null is still attribution -- the row is simply unattributed. */
  test("a null name is still a sent name", () => {
    expect(attributionVisible([row({ id: 1, created_at: "x", requestedByName: null })])).toBe(true);
  });

  test("an empty log needs no column", () => {
    expect(attributionVisible([])).toBe(false);
  });
});

describe("the people in the log", () => {
  const rows = [
    row({ id: 1, created_at: "2026-09-01T09:00:00.000Z", requested_by: "u1", requestedByName: "Ada" }),
    row({ id: 2, created_at: "2026-09-02T09:00:00.000Z", requested_by: "u1", requestedByName: "Ada" }),
    row({ id: 3, created_at: "2026-09-03T09:00:00.000Z", requested_by: "u2", requestedByName: "Bo" }),
    row({ id: 4, created_at: "2026-09-04T09:00:00.000Z", requested_by: null, requestedByName: null }),
  ];

  test("counted per person, most prolific first", () => {
    expect(requesters(rows).map((p) => [p.name, p.count])).toEqual([
      ["Ada", 2],
      ["Bo", 1],
      ["Unattributed", 1],
    ]);
  });

  /** Dropping them would make the counts disagree with the log sitting under them. */
  test("rows nobody is attached to collapse into one entry rather than vanishing", () => {
    expect(requesters(rows).find((p) => p.id === null)?.count).toBe(1);
  });

  test("a reader who was sent no attribution sees nobody to filter by", () => {
    expect(requesters([row({ id: 1, created_at: "x" })])).toEqual([]);
  });

  /* `undefined` is "no filter"; `null` is a real selection -- the unattributed rows. */
  test("filtering by nobody is not the same as not filtering", () => {
    expect(byRequester(rows, undefined)).toHaveLength(4);
    expect(byRequester(rows, "u1").map((r) => r.id)).toEqual([1, 2]);
    expect(byRequester(rows, null).map((r) => r.id)).toEqual([4]);
  });
});

describe("the season line", () => {
  test("a film and a whole series both say nothing", () => {
    expect(seasonLine({ seasons: null })).toBe(null);
  });

  test("a stored list that parses to no numbers says nothing rather than an empty range", () => {
    expect(seasonLine({ seasons: "," })).toBe(null);
  });

  test("chosen seasons read as a range", () => {
    expect(seasonLine({ seasons: "1,2,3" })).toBe("Seasons 1-3");
  });
});
