import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { ArrError, type SonarrClient } from "../lib/arr";
import { loadConfig } from "../lib/config";
import { type MediaRequest, type RequestStatus, Store } from "../lib/store";
import { MAX_SEND_ATTEMPTS, RequestWorker } from "./request-worker";

/**
 * PUSH FOR SPEED, POLL FOR TRUTH -- this file guards the second half.
 *
 * The arr webhooks (`./arr-webhook.ts`) move a request the moment something happens, and
 * `manual_import` is a state only they can reach. That makes the reconcile loop MORE
 * important rather than less: a webhook that never arrives, because finderr restarted or an
 * operator disabled the connection, must not strand a request forever. So what is asserted
 * here is that the poller still finishes every job a webhook started, including the one it
 * could not have started itself.
 *
 * Neither arr is configured, which is deliberate: `downloadsByArrId` and `diagnoseRequests`
 * both answer empty for an unconfigured service, so the pass runs with no network and the
 * assertions are about the library mirror alone.
 */

let dir: string;
let store: Store;
let logged: string[];

function worker() {
  return new RequestWorker({ store, log: (...args) => logged.push(args.join(" ")) });
}

/** A request row in whatever state a test needs, without going through the queue. */
function request(tconst: string, status: RequestStatus, over: Partial<MediaRequest> = {}): void {
  store.createRequest({
    tconst,
    title: over.title ?? "Inception",
    year: 2010,
    kind: "movie",
    service: "radarr",
  });
  store.updateRequest(tconst, { status, arr_id: over.arr_id ?? null });
}

/** Tell the mirror this title is on disk, which is the only thing that makes it available. */
function onDisk(tconst: string): void {
  store.replaceLibrary("radarr", [{ imdb_id: tconst, arr_id: 12, has_file: 1, monitored: 1, progress: 1 }]);
}

beforeEach(() => {
  dir = mkdtempSync(`${tmpdir()}/finderr-worker-`);
  process.env.FINDERR_DATA_DIR = dir;
  store = new Store(loadConfig(true));
  logged = [];
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  process.env.FINDERR_DATA_DIR = undefined;
});

describe("reconcile finishes what a webhook started", () => {
  /*
    THE REASON `manual_import` IS IN THE OPEN LIST.

    A webhook put the row there because the arr could not file the download itself. Leaving
    it out of this pass would have made it a dead end: the reader would go on being told to
    import something by hand long after they had done it.
  */
  test("a blocked import becomes available once somebody sorts it out", async () => {
    request("tt1375666", "manual_import");
    onDisk("tt1375666");

    await worker().reconcile();

    expect(store.getRequest("tt1375666")?.status).toBe("available");
  });

  test("it is news, so the arrival listener fires for it like any other", async () => {
    request("tt1375666", "manual_import");
    onDisk("tt1375666");
    const announced: string[] = [];
    const w = new RequestWorker({
      store,
      log: (...args) => logged.push(args.join(" ")),
      onAvailable: (r) => announced.push(r.tconst),
    });

    await w.reconcile();

    expect(announced).toEqual(["tt1375666"]);
  });

  /*
    Only a `sent` request ages out. A blocked import has already found and downloaded a
    release, so calling it "no releases found" after 24 hours would be a confident lie about
    a file that is sitting on the disk waiting for somebody.
  */
  test("a blocked import never ages out to no_release, however long it waits", async () => {
    request("tt1375666", "manual_import");
    const w = worker();
    for (let i = 0; i < 12; i++) await w.reconcile();

    expect(store.getRequest("tt1375666")).toMatchObject({ status: "manual_import", search_attempts: 0 });
  });

  test("a request still in flight is left in flight", async () => {
    request("tt1375666", "downloading");
    await worker().reconcile();
    expect(store.getRequest("tt1375666")?.status).toBe("downloading");
  });
});

describe("a dead-end request asked for again is picked up rather than dropped", () => {
  /**
   * Wait for the queue to go quiet. `enqueue` starts the drain without returning it, so a
   * test has no promise to await; the alternative is a fixed sleep, which is either slower
   * than it needs to be or flaky.
   */
  async function drained(w: RequestWorker): Promise<void> {
    for (let i = 0; i < 400 && (w.stats().pending > 0 || w.stats().running); i++) await Bun.sleep(5);
  }

  /*
    THE WHOLE OF THE SILENT NO-OP, from the worker's side. `process` opens with
    `if (req.status !== "queued") return`, so before `createRequest` revived the row this job
    was taken off the queue and thrown away -- the reader got a 202 and nothing ever happened.

    Neither arr is configured here, which is the point: the request comes back `failed` with
    an error rather than sitting on its old status, and only a job that actually RAN can do
    that. What a configured Radarr would have been sent is `../lib/arr.test.ts`'s business.
  */
  test("re-asking a no_release title enqueues a job the worker actually runs", async () => {
    const film = { tconst: "tt1375666", title: "Inception", year: 2010, kind: "movie" };
    store.createRequest({ ...film, service: "radarr" });
    store.updateRequest(film.tconst, { status: "no_release" });

    store.createRequest({ ...film, service: "radarr" });
    const w = worker();
    w.enqueue(film.tconst);
    await drained(w);

    expect(store.getRequest(film.tconst)).toMatchObject({
      status: "failed",
      // Sanitised by `safeArrMessage`, which is what makes this a browser-safe column.
      error: "The request could not be sent",
    });
    expect(w.stats().failed).toBe(1);
  });
});

/**
 * A BUSY ARR IS NOT A DEAD END.
 *
 * Measured 2026-09-11 on the NAS: finderr asked Sonarr for The Rehearsal while Sonarr was still
 * refreshing the series added just before it. Our 20 s client timeout fired at 08:03:31, Sonarr
 * answered `database is locked` at 08:03:42, and the request sat on "Request failed" for four
 * days with nothing retrying it. aannarr: "failed requests should be queued, and retried
 * (serialized) over time".
 */

/** A Sonarr whose `add` answers from a script, one entry per call. */
function scriptedSonarr(script: Array<() => unknown>) {
  const calls: string[] = [];
  const sonarr = {
    add: async (opts: { imdbId: string }) => {
      calls.push(opts.imdbId);
      const next = script.shift();
      if (!next) throw new Error("script exhausted");
      return next();
    },
  } as unknown as SonarrClient;
  return { sonarr, calls };
}

/** Nothing queued, nothing sending, nothing waiting on a retry timer. */
async function settled(w: RequestWorker): Promise<void> {
  for (let i = 0; i < 1000 && (w.stats().pending > 0 || w.stats().running || w.stats().waiting > 0); i++) {
    await Bun.sleep(5);
  }
}

describe("a transient arr failure is queued again, not failed", () => {
  const show = { tconst: "tt10802170", title: "The Rehearsal", year: 2022, kind: "tvSeries" };

  const timeout = () => {
    throw new DOMException("The operation timed out.", "TimeoutError");
  };
  const locked = () => {
    throw new ArrError("sonarr", 500, "database is locked");
  };

  test("a timeout re-queues it with a retry time, then the retry lands", async () => {
    store.createRequest({ ...show, service: "sonarr" });
    const { sonarr, calls } = scriptedSonarr([timeout, () => ({ id: 77 })]);
    const w = new RequestWorker({
      store,
      sonarr,
      pauseMs: 0,
      log: (...a) => logged.push(a.join(" ")),
      retryDelayMs: () => 20,
    });

    w.enqueue(show.tconst);
    for (let i = 0; i < 200 && store.getRequest(show.tconst)?.send_attempts !== 1; i++) await Bun.sleep(2);

    const waiting = store.getRequest(show.tconst);
    expect(waiting).toMatchObject({ status: "queued", send_attempts: 1 });
    expect(waiting?.retry_at).not.toBeNull();
    // The reader is told it is still coming, never "Request failed".
    expect(waiting?.error).toBe("Sonarr did not answer yet -- trying again automatically");

    await settled(w);
    expect(calls).toEqual([show.tconst, show.tconst]);
    expect(store.getRequest(show.tconst)).toMatchObject({
      status: "sent",
      arr_id: 77,
      error: null,
      retry_at: null,
    });
  });

  test("an arr 5xx is transient too", async () => {
    store.createRequest({ ...show, service: "sonarr" });
    const { sonarr } = scriptedSonarr([locked, () => ({ id: 5 })]);
    const w = new RequestWorker({ store, sonarr, pauseMs: 0, log: () => {}, retryDelayMs: () => 1 });
    w.enqueue(show.tconst);
    await settled(w);
    expect(store.getRequest(show.tconst)).toMatchObject({ status: "sent", arr_id: 5 });
  });

  test("a title the arr cannot find fails at once -- asking again will not change it", async () => {
    store.createRequest({ ...show, service: "sonarr" });
    const { sonarr, calls } = scriptedSonarr([
      () => {
        throw new ArrError("sonarr", 404, "", "Sonarr could not resolve tt10802170");
      },
    ]);
    const w = new RequestWorker({ store, sonarr, pauseMs: 0, log: () => {}, retryDelayMs: () => 1 });
    w.enqueue(show.tconst);
    await settled(w);
    expect(calls).toHaveLength(1);
    expect(store.getRequest(show.tconst)).toMatchObject({
      status: "failed",
      error: "Sonarr could not find that title",
    });
  });

  test("it gives up after MAX_SEND_ATTEMPTS and only then says failed", async () => {
    store.createRequest({ ...show, service: "sonarr" });
    const { sonarr, calls } = scriptedSonarr(Array.from({ length: MAX_SEND_ATTEMPTS + 3 }, () => locked));
    const w = new RequestWorker({ store, sonarr, pauseMs: 0, log: () => {}, retryDelayMs: () => 1 });
    w.enqueue(show.tconst);
    await settled(w);
    expect(calls).toHaveLength(MAX_SEND_ATTEMPTS);
    // Names the cause and the effort. "The request could not be sent" under a "Request failed"
    // label said the same thing twice and told the reader nothing about why.
    expect(store.getRequest(show.tconst)).toMatchObject({
      status: "failed",
      retry_at: null,
      error: `Sonarr did not accept it after ${MAX_SEND_ATTEMPTS} tries`,
    });
  });

  test("Try again during the wait sends now and starts the count over", async () => {
    store.createRequest({ ...show, service: "sonarr" });
    const { sonarr, calls } = scriptedSonarr([timeout, () => ({ id: 9 })]);
    // An hour: the scheduled retry must NOT be what sends it.
    const w = new RequestWorker({ store, sonarr, pauseMs: 0, log: () => {}, retryDelayMs: () => 3_600_000 });
    w.enqueue(show.tconst);
    for (let i = 0; i < 200 && store.getRequest(show.tconst)?.send_attempts !== 1; i++) await Bun.sleep(2);

    store.requeueRequest(show.tconst);
    expect(store.getRequest(show.tconst)).toMatchObject({ send_attempts: 0, retry_at: null });
    w.enqueue(show.tconst);
    for (let i = 0; i < 400 && store.getRequest(show.tconst)?.status !== "sent"; i++) await Bun.sleep(5);

    expect(calls).toHaveLength(2);
    expect(store.getRequest(show.tconst)).toMatchObject({ status: "sent", arr_id: 9 });
    w.stop();
  });

  test("a restart honours a retry time still in the future instead of sending at boot", async () => {
    store.createRequest({ ...show, service: "sonarr" });
    store.updateRequest(show.tconst, {
      send_attempts: 2,
      retry_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const { sonarr, calls } = scriptedSonarr([() => ({ id: 1 })]);
    const w = new RequestWorker({ store, sonarr, pauseMs: 0, log: () => {} });
    w.start();
    await Bun.sleep(30);
    expect(calls).toHaveLength(0);
    expect(w.stats().waiting).toBe(1);
    w.stop();
  });
});

describe("the one-off requeue of every failed request", () => {
  /*
    aannarr 2026-09-15: "requeue all failed on deploy". Every row that failed under the old
    worker failed with no retry at all, so each gets ONE more pass through the new one. Once:
    a flag in kv keeps a permanently failing title from being re-sent on every restart.
  */
  test("failed rows are sent again on the first boot only", async () => {
    const show = { title: "The Rehearsal", year: 2022, kind: "tvSeries", service: "sonarr" as const };
    store.createRequest({ ...show, tconst: "tt0000001" });
    store.updateRequest("tt0000001", { status: "failed", error: "The request could not be sent" });
    store.createRequest({ ...show, tconst: "tt0000002" });
    store.updateRequest("tt0000002", { status: "no_release" });

    const { sonarr, calls } = scriptedSonarr([() => ({ id: 3 })]);
    const first = new RequestWorker({ store, sonarr, pauseMs: 0, log: () => {} });
    first.start();
    await settled(first);
    expect(calls).toEqual(["tt0000001"]);
    expect(store.getRequest("tt0000001")).toMatchObject({ status: "sent", arr_id: 3, error: null });
    // Only `failed` is swept. A no_release title is a verdict about indexers, not a send that broke.
    expect(store.getRequest("tt0000002")?.status).toBe("no_release");

    store.updateRequest("tt0000001", { status: "failed", error: "Sonarr could not find that title" });
    const again = scriptedSonarr([() => ({ id: 4 })]);
    const second = new RequestWorker({ store, sonarr: again.sonarr, pauseMs: 0, log: () => {} });
    second.start();
    await settled(second);
    expect(again.calls).toEqual([]);
    expect(store.getRequest("tt0000001")?.status).toBe("failed");
  });
});
