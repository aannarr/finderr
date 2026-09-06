/**
 * The request log's rules, tested without rendering anything.
 *
 * The two that matter are ordering (a log is ordered by when it was ASKED, not by when the
 * worker last touched the row) and attribution (the browser never decides who may see a
 * name -- it reads whether the server sent one).
 *
 * The two that `/requests` added are its own ordering, where the interesting half is that a
 * "New" marker outlives the server clearing the flag it came from, and whether the page has
 * anything left worth refetching for.
 */

import { describe, expect, test } from "bun:test";
import type { MediaRequest } from "./api";
import {
  attributionVisible,
  BUCKET_LABEL,
  byRequester,
  groupByState,
  hasWorkInFlight,
  logOrder,
  newsFirst,
  requesters,
  seasonLine,
} from "./request-log";

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

describe("ordering your own requests", () => {
  const arrived = row({ id: 1, created_at: "2026-09-01T09:00:00.000Z", isNew: true });
  const older = row({ id: 2, created_at: "2026-09-02T09:00:00.000Z", isNew: false });

  test("news goes to the top and the server's order is kept underneath", () => {
    expect(newsFirst([older, arrived], new Set()).map((r) => r.id)).toEqual([1, 2]);
  });

  /*
    THE REGRESSION POLLING WOULD OTHERWISE INTRODUCE.

    Opening the page marks everything seen, so every later poll comes back with `isNew`
    false. Without the visit's own memory the markers a reader is looking at would disappear
    a few seconds after they arrived, and the arrivals would drop back into the list.
  */
  test("a marker survives the server clearing the flag under it", () => {
    const cleared = { ...arrived, isNew: false };
    const kept = newsFirst([older, cleared], new Set([cleared.tconst]));
    expect(kept.map((r) => r.id)).toEqual([1, 2]);
    expect(kept[0]?.isNew).toBe(true);
  });

  test("it marks a copy rather than the caller's row", () => {
    const cleared = { ...arrived, isNew: false };
    newsFirst([cleared], new Set([cleared.tconst]));
    expect(cleared.isNew).toBe(false);
  });
});

describe("whether the page has anything to watch", () => {
  /*
    This is what decides `/requests` refetches at all, so both answers are load-bearing in
    opposite directions: false and the bar freezes, true forever and the page polls a list
    that will never change again.
  */
  test("a request still moving keeps the page polling", () => {
    for (const requestVerdict of ["queued", "searching", "downloading"] as const) {
      expect(hasWorkInFlight([{ requestVerdict }])).toBe(true);
    }
  });

  test("arrived and dead-ended rows are finished, however many of them there are", () => {
    for (const requestVerdict of [
      "imported",
      "needs_manual_import",
      "nothing_accepted",
      "no_releases",
      "failed",
    ] as const) {
      expect(hasWorkInFlight([{ requestVerdict }])).toBe(false);
    }
  });

  /** A verdict the server could not form is not a reason to keep asking forever. */
  test("a row with no verdict is not work", () => {
    expect(hasWorkInFlight([{ requestVerdict: null }])).toBe(false);
  });

  test("one moving row among finished ones is enough", () => {
    expect(hasWorkInFlight([{ requestVerdict: "imported" }, { requestVerdict: "downloading" }])).toBe(true);
  });

  test("an empty list has nothing to watch", () => {
    expect(hasWorkInFlight([])).toBe(false);
  });
});

describe("grouping by state", () => {
  const grouped = (rows: Partial<MediaRequest>[]) =>
    groupByState(rows.map((over, i) => row({ id: i + 1, created_at: "2026-09-05T00:00:00.000Z", ...over })));

  /*
    THE FOURTH BUCKET IS A SPLIT INSIDE `working`, on one predicate: has the arr actually got
    something coming down. Three tones plus that split is four states, and the split is the
    difference between a bar a reader can watch and a wait they can only refresh.
  */
  test("waiting and downloading are the same tone told apart by the bar", () => {
    const groups = grouped([
      { requestVerdict: "searching", requestProgress: null },
      { requestVerdict: "downloading", requestProgress: 0.4 },
    ]);

    expect(groups.map((g) => g.bucket)).toEqual(["downloading", "waiting"]);
  });

  test("both dead ends land together, whichever one it is", () => {
    const groups = grouped([{ requestVerdict: "no_releases" }, { requestVerdict: "failed" }]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.bucket).toBe("failed");
    expect(groups[0]?.rows).toHaveLength(2);
  });

  test("an arrived request is its own bucket", () => {
    expect(grouped([{ requestVerdict: "imported" }])[0]?.bucket).toBe("arrived");
  });

  /*
    A heading over nothing is the page claiming a state it is not in -- "Needs attention (0)"
    reads as a warning at a glance, which is the one thing the grouping exists to make cheap.
  */
  test("empty buckets are dropped rather than drawn with a zero", () => {
    expect(grouped([{ requestVerdict: "imported" }]).map((g) => g.bucket)).toEqual(["arrived"]);
    expect(grouped([])).toEqual([]);
  });

  test("the order is downloading, waiting, arrived, failed -- whatever order the rows arrive in", () => {
    const groups = grouped([
      { requestVerdict: "failed" },
      { requestVerdict: "imported" },
      { requestVerdict: "queued" },
      { requestVerdict: "downloading", requestProgress: 0.1 },
    ]);

    expect(groups.map((g) => g.bucket)).toEqual(["downloading", "waiting", "arrived", "failed"]);
  });

  /*
    `/requests` hands rows that have already been through `newsFirst`, so a newly-arrived
    title must stay at the top of its group. A partition that sorted would undo that.
  */
  test("the caller's order survives inside a bucket", () => {
    const groups = grouped([
      { tconst: "tt-second", requestVerdict: "imported" },
      { tconst: "tt-first", requestVerdict: "imported" },
    ]);

    expect(groups[0]?.rows.map((r) => r.tconst)).toEqual(["tt-second", "tt-first"]);
  });

  /*
    A row the server could say nothing about is WAITING, not dropped. It is not a state
    `/requests` reaches today -- every row there has a stored request behind it -- but a
    bucket function that returned undefined would take the row off the page entirely.
  */
  test("a row with no verdict is waiting rather than missing", () => {
    const groups = grouped([{ requestVerdict: null }]);

    expect(groups.map((g) => g.bucket)).toEqual(["waiting"]);
    expect(groups[0]?.rows).toHaveLength(1);
  });

  test("every bucket has a label, so a heading can never draw a raw enum", () => {
    for (const { bucket } of grouped([
      { requestVerdict: "downloading", requestProgress: 0.5 },
      { requestVerdict: "queued" },
      { requestVerdict: "imported" },
      { requestVerdict: "failed" },
    ])) {
      expect(BUCKET_LABEL[bucket]).toBeTruthy();
    }
  });
});
