import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadConfig } from "../lib/config";
import { type MediaRequest, type RequestStatus, Store } from "../lib/store";
import { RequestWorker } from "./request-worker";

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
