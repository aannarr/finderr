/**
 * The collector, against three plain objects standing in for Radarr, Sonarr and Prowlarr.
 *
 * Every client is injected, so nothing here opens a socket or a database. What is worth
 * pinning is the failure behaviour: a service that is down or absent must cost a detail
 * and never the pass, and it must never turn "we do not know" into a number.
 */

import { describe, expect, test } from "bun:test";
import type { ArrHistoryRecord, QueueItem } from "../lib/arr";
import type { ProwlarrHistoryRecord } from "../lib/prowlarr";
import type { MediaRequest } from "../lib/store";
import { type DiagnoseDeps, diagnoseRequests, downloadsByArrId } from "./diagnose-requests";

const silent = () => {};

const request = (over: Partial<MediaRequest> = {}): MediaRequest =>
  ({
    tconst: "tt0000001",
    title: "Sicario",
    status: "sent",
    service: "radarr",
    arr_id: 7,
    created_at: "2026-09-02T10:00:00Z",
    ...over,
  }) as MediaRequest;

const queueItem = (over: Partial<QueueItem>): QueueItem =>
  ({ id: 1, title: "x", status: "downloading", size: 1000, sizeleft: 400, ...over }) as QueueItem;

/** A client that answers with a fixed page. */
const serves = <T>(records: T[]) => ({
  queue: async () => ({ records }),
  history: async () => ({ records }),
});

/** A client that is configured but unreachable. */
const broken = {
  queue: async () => {
    throw new Error("connect ECONNREFUSED");
  },
  history: async () => {
    throw new Error("connect ECONNREFUSED");
  },
};

describe("reading the arr queues", () => {
  test("keys progress by arr id, from whichever service reported it", async () => {
    const deps: DiagnoseDeps = {
      radarr: serves([queueItem({ movieId: 7 })]),
      sonarr: serves([queueItem({ seriesId: 22, size: 200, sizeleft: 100 })]),
      log: silent,
    };
    const downloads = await downloadsByArrId(deps);
    expect(downloads.get(7)?.progress).toBeCloseTo(0.6, 5);
    expect(downloads.get(22)?.progress).toBeCloseTo(0.5, 5);
  });

  test("several episodes of one series are one entry", async () => {
    const deps: DiagnoseDeps = {
      sonarr: serves([
        queueItem({ seriesId: 22, size: 1000, sizeleft: 0 }),
        queueItem({ seriesId: 22, size: 1000, sizeleft: 1000 }),
      ]),
      log: silent,
    };
    const downloads = await downloadsByArrId(deps);
    expect(downloads.size).toBe(1);
    expect(downloads.get(22)?.progress).toBeCloseTo(0.5, 5);
  });

  test("a record belonging to neither a movie nor a series is dropped", async () => {
    const deps: DiagnoseDeps = { radarr: serves([queueItem({})]), log: silent };
    expect((await downloadsByArrId(deps)).size).toBe(0);
  });

  test("an arr that is down costs a queue, not the pass", async () => {
    const said: string[] = [];
    const deps: DiagnoseDeps = {
      radarr: broken,
      sonarr: serves([queueItem({ seriesId: 22 })]),
      log: (...a) => said.push(String(a[0])),
    };
    const downloads = await downloadsByArrId(deps);
    expect(downloads.has(22)).toBe(true);
    expect(said.join(" ")).toContain("radarr queue unavailable");
  });
});

describe("building an evidence row per open request", () => {
  const grabbed = (over: Partial<ArrHistoryRecord>): ArrHistoryRecord => ({
    eventType: "grabbed",
    date: "2026-09-02T10:03:00Z",
    quality: { quality: { name: "Bluray-1080p" } },
    ...over,
  });

  const searched = (over: Partial<ProwlarrHistoryRecord> = {}): ProwlarrHistoryRecord => ({
    eventType: "indexerQuery",
    date: "2026-09-02T11:00:00Z",
    indexerId: 3,
    data: { query: "Sicario 2015", queryResults: "4" },
    ...over,
  });

  test("a downloading request carries its bar, its grab and its searches", async () => {
    const deps: DiagnoseDeps = {
      radarr: {
        queue: async () => ({
          records: [queueItem({ movieId: 7, estimatedCompletionTime: "2026-09-02T12:00:00Z" })],
        }),
        history: async () => ({ records: [grabbed({ movieId: 7 })] }),
      },
      prowlarr: { history: async () => ({ records: [searched()] }) },
      log: silent,
    };
    const downloads = await downloadsByArrId(deps);
    const [row] = await diagnoseRequests(deps, [request()], downloads);

    expect(row).toEqual({
      tconst: "tt0000001",
      download_progress: 0.6,
      eta_at: "2026-09-02T12:00:00Z",
      grabbed_at: "2026-09-02T10:03:00Z",
      grabbed_quality: "Bluray-1080p",
      indexers_searched: 1,
      releases_seen: 4,
    });
  });

  /**
   * The whole-row rule: a finished download must lose its bar in the same write that
   * notices, or the page keeps drawing one for something that stopped.
   */
  test("a request the queue no longer knows about reports no progress", async () => {
    const deps: DiagnoseDeps = { radarr: serves<QueueItem>([]), log: silent };
    const [row] = await diagnoseRequests(deps, [request()], new Map());
    expect(row?.download_progress).toBeNull();
    expect(row?.eta_at).toBeNull();
  });

  /**
   * The honesty limit at the collector: no Prowlarr means no evidence, and no evidence
   * must not read as "the indexers had nothing" -- which is what a zero here would become
   * once `verdictFor` saw it.
   */
  test("without Prowlarr the search counts are unknown, never zero", async () => {
    const deps: DiagnoseDeps = { radarr: serves<QueueItem>([]), log: silent };
    const [row] = await diagnoseRequests(deps, [request()], new Map());
    expect(row?.releases_seen).toBeNull();
    expect(row?.indexers_searched).toBeNull();
  });

  test("a Prowlarr that is down is the same as an absent one, and says so once", async () => {
    const said: string[] = [];
    const deps: DiagnoseDeps = { prowlarr: broken, log: (...a) => said.push(String(a[0])) };
    const [row] = await diagnoseRequests(deps, [request()], new Map());
    expect(row?.releases_seen).toBeNull();
    expect(said.join(" ")).toContain("prowlarr history unavailable");
  });

  test("history newest-first means the LATEST grab wins", async () => {
    const deps: DiagnoseDeps = {
      radarr: {
        queue: async () => ({ records: [] }),
        history: async () => ({
          records: [
            grabbed({
              movieId: 7,
              date: "2026-09-02T18:00:00Z",
              quality: { quality: { name: "WEBDL-1080p" } },
            }),
            grabbed({ movieId: 7, date: "2026-09-02T10:03:00Z" }),
          ],
        }),
      },
      log: silent,
    };
    const [row] = await diagnoseRequests(deps, [request()], new Map());
    expect(row?.grabbed_at).toBe("2026-09-02T18:00:00Z");
    expect(row?.grabbed_quality).toBe("WEBDL-1080p");
  });

  test("an import event is not a grab", async () => {
    const deps: DiagnoseDeps = {
      radarr: {
        queue: async () => ({ records: [] }),
        history: async () => ({ records: [grabbed({ movieId: 7, eventType: "downloadFolderImported" })] }),
      },
      log: silent,
    };
    const [row] = await diagnoseRequests(deps, [request()], new Map());
    expect(row?.grabbed_at).toBeNull();
  });

  test("a request never sent to an arr has no id to join on and gets a row of nulls", async () => {
    const deps: DiagnoseDeps = {
      radarr: {
        queue: async () => ({ records: [queueItem({ movieId: 7 })] }),
        history: async () => ({ records: [grabbed({ movieId: 7 })] }),
      },
      log: silent,
    };
    const downloads = await downloadsByArrId(deps);
    const [row] = await diagnoseRequests(deps, [request({ arr_id: null })], downloads);
    expect(row?.download_progress).toBeNull();
    expect(row?.grabbed_at).toBeNull();
  });

  test("nothing open means nothing asked of anybody", async () => {
    let asked = 0;
    const deps: DiagnoseDeps = {
      radarr: {
        queue: async () => ({ records: [] }),
        history: async () => {
          asked++;
          return { records: [] };
        },
      },
      log: silent,
    };
    expect(await diagnoseRequests(deps, [], new Map())).toEqual([]);
    expect(asked).toBe(0);
  });

  /** The call count is fixed: one history page serves every open request. */
  test("one history read however many requests are open", async () => {
    let prowlarrReads = 0;
    const deps: DiagnoseDeps = {
      prowlarr: {
        history: async () => {
          prowlarrReads++;
          return { records: [searched()] };
        },
      },
      log: silent,
    };
    const rows = await diagnoseRequests(
      deps,
      [request(), request({ tconst: "tt0000002", title: "Arrival" }), request({ tconst: "tt0000003" })],
      new Map(),
    );
    expect(rows).toHaveLength(3);
    expect(prowlarrReads).toBe(1);
    // Only the two rows whose title the query matches inherit the evidence.
    expect(rows.map((r) => r.releases_seen)).toEqual([4, null, 4]);
  });
});
