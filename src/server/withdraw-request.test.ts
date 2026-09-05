import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { ArrError, type ArrUnmonitor } from "../lib/arr";
import { loadConfig } from "../lib/config";
import { utcDayStart } from "../lib/request-quota";
import { type MediaRequest, type RequestStatus, Store } from "../lib/store";
import { withdrawRequest } from "./withdraw-request";

/**
 * The rule behind the Withdraw button, against a REAL store and a fake arr.
 *
 * A real `Store` because half of what withdrawing means is what the database looks like
 * afterwards -- the row gone, the diagnostic gone with it, the day's quota refunded -- and
 * none of that is observable against a stub. The arr is a recorder, because what matters
 * there is WHETHER it was called and with which id; what goes on the wire is asserted one
 * layer down, in `../lib/arr.test.ts`, which is the only place that can see the HTTP verb.
 */

let dir: string;
let store: Store;
let logged: string[];

const ADMIN = { userId: "u-admin", role: "admin" as const };
const ASKER = { userId: "u-asker", role: "user" as const };
const SOMEBODY_ELSE = { userId: "u-else", role: "user" as const };

/** An arr client that remembers what it was told to unmonitor, and optionally refuses. */
function arr(fail?: Error): ArrUnmonitor & { calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    async unmonitor(arrId: number) {
      calls.push(arrId);
      if (fail) throw fail;
      return null;
    },
  };
}

/**
 * A request row in whatever state a test needs, without going through the worker.
 *
 * `arr_id` is set exactly where the worker would set it: a request the arr accepted from us.
 * Leaving it null is the "somebody else already had this title" case, and every test that
 * cares says which it means.
 */
function request(
  tconst: string,
  status: RequestStatus,
  over: Partial<Pick<MediaRequest, "arr_id" | "service" | "requested_by">> = {},
): void {
  store.createRequest({
    tconst,
    title: "Inception",
    year: 2010,
    kind: "movie",
    service: over.service ?? "radarr",
    requestedBy: over.requested_by === undefined ? ASKER.userId : over.requested_by,
  });
  store.updateRequest(tconst, { status, arr_id: over.arr_id ?? null });
}

function deps(radarr?: ArrUnmonitor, sonarr?: ArrUnmonitor) {
  return { store, radarr, sonarr, log: (...args: unknown[]) => logged.push(args.join(" ")) };
}

beforeEach(() => {
  dir = mkdtempSync(`${tmpdir()}/finderr-withdraw-`);
  process.env.FINDERR_DATA_DIR = dir;
  store = new Store(loadConfig(true));
  logged = [];
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  process.env.FINDERR_DATA_DIR = undefined;
});

describe("a queued request is dropped before the arr ever hears about it", () => {
  test("the row goes and the arr is not called", async () => {
    request("tt1375666", "queued");
    const radarr = arr();

    const outcome = await withdrawRequest(deps(radarr), "tt1375666", ASKER);

    expect(outcome).toEqual({ ok: true, unmonitored: false });
    expect(store.getRequest("tt1375666")).toBeNull();
    expect(radarr.calls).toEqual([]);
  });

  test("the quota row it spent is free again the same day", async () => {
    request("tt1375666", "queued");
    expect(store.countRequestsSince(ASKER.userId, utcDayStart())).toBe(1);

    await withdrawRequest(deps(arr()), "tt1375666", ASKER);

    expect(store.countRequestsSince(ASKER.userId, utcDayStart())).toBe(0);
  });
});

describe("an in-flight request is unmonitored, and nothing is deleted from the library", () => {
  test("a downloading film unmonitors in Radarr by the id we added it under", async () => {
    request("tt1375666", "downloading", { arr_id: 42 });
    const radarr = arr();

    const outcome = await withdrawRequest(deps(radarr), "tt1375666", ASKER);

    expect(outcome).toEqual({ ok: true, unmonitored: true });
    expect(radarr.calls).toEqual([42]);
    expect(store.getRequest("tt1375666")).toBeNull();
  });

  test("a series goes to Sonarr and never to Radarr", async () => {
    request("tt0903747", "grabbed", { arr_id: 7, service: "sonarr" });
    const radarr = arr();
    const sonarr = arr();

    await withdrawRequest(deps(radarr, sonarr), "tt0903747", ASKER);

    expect(sonarr.calls).toEqual([7]);
    expect(radarr.calls).toEqual([]);
  });

  /*
    THE CASE THE `arr_id` TEST EXISTS FOR.

    `RequestWorker.process` marks a request `sent` with NO arr id when the arr answers 400
    because the title was already there -- somebody else's library row. Switching monitoring
    off on it would reach into a decision that was never ours.
  */
  test("a request the arr already had is dropped without touching the arr", async () => {
    request("tt1375666", "sent", { arr_id: null });
    const radarr = arr();

    const outcome = await withdrawRequest(deps(radarr), "tt1375666", ASKER);

    expect(outcome).toEqual({ ok: true, unmonitored: false });
    expect(radarr.calls).toEqual([]);
    expect(store.getRequest("tt1375666")).toBeNull();
  });
});

describe("a request that has arrived cannot be withdrawn", () => {
  test("it is refused, the row stays, and the arr is not called", async () => {
    request("tt1375666", "available", { arr_id: 42 });
    const radarr = arr();

    const outcome = await withdrawRequest(deps(radarr), "tt1375666", ASKER);

    expect(outcome.ok).toBe(false);
    expect(outcome).toMatchObject({ status: 409 });
    expect(store.getRequest("tt1375666")?.status).toBe("available");
    expect(radarr.calls).toEqual([]);
  });

  test("even an admin is refused -- removing the media is a library operation", async () => {
    request("tt1375666", "available", { arr_id: 42 });

    expect((await withdrawRequest(deps(arr()), "tt1375666", ADMIN)).ok).toBe(false);
  });
});

describe("only the requester or an admin may withdraw, and the refusal says nothing", () => {
  test("somebody else's request is INDISTINGUISHABLE from a title nobody asked for", async () => {
    request("tt1375666", "queued");
    const radarr = arr();

    const theirs = await withdrawRequest(deps(radarr), "tt1375666", SOMEBODY_ELSE);
    const nothing = await withdrawRequest(deps(radarr), "tt0000000", SOMEBODY_ELSE);

    expect(theirs).toEqual(nothing);
    expect(theirs).toEqual({ ok: false, status: 404, error: "unknown request" });
    // The row survives the refusal, and so does the arr.
    expect(store.getRequest("tt1375666")).not.toBeNull();
    expect(radarr.calls).toEqual([]);
  });

  test("an admin may withdraw a request they did not make", async () => {
    request("tt1375666", "queued");

    expect(await withdrawRequest(deps(arr()), "tt1375666", ADMIN)).toEqual({
      ok: true,
      unmonitored: false,
    });
  });

  test("a request attributed to nobody belongs to nobody -- only an admin may drop it", async () => {
    request("tt1375666", "queued", { requested_by: null });

    expect((await withdrawRequest(deps(arr()), "tt1375666", ASKER)).ok).toBe(false);
    expect((await withdrawRequest(deps(arr()), "tt1375666", ADMIN)).ok).toBe(true);
  });
});

describe("when the arr will not cooperate", () => {
  test("a refusal keeps the row, so the reader can press the button again", async () => {
    request("tt1375666", "downloading", { arr_id: 42 });
    const radarr = arr(new ArrError("radarr", 500, "/plex/movies is unavailable"));

    const outcome = await withdrawRequest(deps(radarr), "tt1375666", ASKER);

    expect(outcome).toEqual({
      ok: false,
      status: 502,
      // SANITISED: the arr's own body named a root folder and none of it reaches the caller.
      error: "radarr is having trouble -- try again shortly",
    });
    expect(store.getRequest("tt1375666")).not.toBeNull();
  });

  test("a 404 means the row we added is already gone, which is what was asked for", async () => {
    request("tt1375666", "sent", { arr_id: 42 });
    const radarr = arr(new ArrError("radarr", 404, "NotFound"));

    const outcome = await withdrawRequest(deps(radarr), "tt1375666", ASKER);

    expect(outcome).toEqual({ ok: true, unmonitored: false });
    expect(store.getRequest("tt1375666")).toBeNull();
  });

  test("an unconfigured arr refuses rather than silently dropping a monitored title", async () => {
    request("tt1375666", "sent", { arr_id: 42 });

    const outcome = await withdrawRequest(deps(undefined), "tt1375666", ASKER);

    expect(outcome).toMatchObject({ ok: false, status: 503 });
    expect(store.getRequest("tt1375666")).not.toBeNull();
  });
});

describe("nothing is left behind for the reconcile pass to keep chewing on", () => {
  test("the diagnostic goes with the request", async () => {
    request("tt1375666", "downloading", { arr_id: 42 });
    store.upsertRequestDiagnostic({
      tconst: "tt1375666",
      download_progress: 0.4,
      eta_at: null,
      grabbed_quality: "Bluray-1080p",
      indexers_searched: 3,
      releases_seen: 2,
    });

    await withdrawRequest(deps(arr()), "tt1375666", ASKER);

    expect(store.getRequestDiagnostic("tt1375666")).toBeNull();
    expect(store.requestDiagnosticMap().size).toBe(0);
  });

  test("the withdrawn title is gone from every list the worker reconciles", async () => {
    request("tt1375666", "downloading", { arr_id: 42 });

    await withdrawRequest(deps(arr()), "tt1375666", ASKER);

    expect(store.listRequests("downloading")).toEqual([]);
    expect(store.recentlyRequestedIds()).toEqual([]);
    expect(store.requestMap().size).toBe(0);
  });
});
