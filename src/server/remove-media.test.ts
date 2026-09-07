import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { ArrError, type ArrHoldings, type ArrRemoval } from "../lib/arr";
import { loadConfig } from "../lib/config";
import { utcDayStart } from "../lib/request-quota";
import { type MediaRequest, type RequestStatus, Store } from "../lib/store";
import { removalPreview, removeMedia } from "./remove-media";

/**
 * The rule behind the Remove button, against a REAL store and a fake arr -- the same shape
 * `./withdraw-request.test.ts` uses, and for the same reason: half of what removing means is
 * what the database looks like afterwards. The row's terminal state, the audit record, the
 * library mirror losing a title and the day's quota NOT being refunded are all facts about
 * SQLite that no stub can show.
 *
 * The arr is a recorder. What goes on the wire -- the DELETE verb, the `deleteFiles` flag,
 * the import exclusion that must never be set -- is asserted one layer down in
 * `../lib/arr.test.ts`, which is the only place that can see it.
 */

let dir: string;
let store: Store;
let logged: string[];

const ADMIN = { userId: "u-admin" };
const HOLDINGS: ArrHoldings = { files: 1, bytes: 13_000_000_000, quality: "Bluray-1080p" };

/** An arr that remembers what it was asked to remove, and optionally refuses. */
function arr(
  over: { holdings?: ArrHoldings | null; fail?: Error } = {},
): ArrRemoval & { removals: { arrId: number; deleteFiles: boolean }[] } {
  const removals: { arrId: number; deleteFiles: boolean }[] = [];
  return {
    removals,
    async holdings() {
      return over.holdings === undefined ? HOLDINGS : over.holdings;
    },
    async remove(arrId: number, opts: { deleteFiles: boolean }) {
      removals.push({ arrId, deleteFiles: opts.deleteFiles });
      if (over.fail) throw over.fail;
      return null;
    },
  };
}

/** A request row plus the library mirror row an arrived title always has beside it. */
function arrived(
  tconst: string,
  over: Partial<Pick<MediaRequest, "status" | "service" | "arr_id">> & { inLibrary?: boolean } = {},
): void {
  const service = over.service ?? "radarr";
  store.createRequest({ tconst, title: "Inception", year: 2010, kind: "movie", service, requestedBy: "u-a" });
  store.updateRequest(tconst, {
    status: (over.status ?? "available") as RequestStatus,
    arr_id: over.arr_id ?? null,
  });
  if (over.inLibrary !== false) {
    store.replaceLibrary(service, [
      { imdb_id: tconst, arr_id: 42, has_file: 1, monitored: 1, progress: null },
    ]);
  }
}

function deps(radarr?: ArrRemoval, sonarr?: ArrRemoval, inPlex: string[] = []) {
  return {
    store,
    radarr,
    sonarr,
    plexHolds: (tconst: string) => inPlex.includes(tconst),
    log: (...args: unknown[]) => logged.push(args.join(" ")),
  };
}

beforeEach(() => {
  dir = mkdtempSync(`${tmpdir()}/finderr-remove-`);
  process.env.FINDERR_DATA_DIR = dir;
  store = new Store(loadConfig(true));
  logged = [];
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  process.env.FINDERR_DATA_DIR = undefined;
});

describe("what the confirmation is told before anything is deleted", () => {
  test("the title, the file count, the size and the quality come from the arr", async () => {
    arrived("tt1375666");

    const outcome = await removalPreview(deps(arr()), "tt1375666");

    expect(outcome).toEqual({
      ok: true,
      value: {
        tconst: "tt1375666",
        title: "Inception",
        year: 2010,
        service: "radarr",
        files: 1,
        bytes: 13_000_000_000,
        quality: "Bluray-1080p",
        inPlex: false,
      },
    });
  });

  /*
    Plex residency comes from the Plex mirror and never from the arr's `hasFile`: they answer
    different questions, and only this one says whether the household would notice the film
    disappear from the app they actually watch in.
  */
  test("Plex still holding it is stated, and it is not the arr that says so", async () => {
    arrived("tt1375666");

    const outcome = await removalPreview(deps(arr(), undefined, ["tt1375666"]), "tt1375666");

    expect(outcome).toMatchObject({ ok: true, value: { inPlex: true } });
  });

  test("nothing is removed by asking what would be", async () => {
    arrived("tt1375666");
    const radarr = arr();

    await removalPreview(deps(radarr), "tt1375666");

    expect(radarr.removals).toEqual([]);
    expect(store.getRequest("tt1375666")?.status).toBe("available");
  });

  /*
    A row the arr no longer holds is somebody having removed it by hand. The confirmation must
    not open on it -- the delete would refuse for the same reason, and a dialogue that offers
    to delete something already gone is a dialogue that lies about what pressing Yes does.
  */
  test("a title the arr has already lost refuses rather than confirming", async () => {
    arrived("tt1375666");

    const outcome = await removalPreview(deps(arr({ holdings: null })), "tt1375666");

    expect(outcome).toMatchObject({ ok: false, status: 409 });
  });
});

describe("removing media that arrived", () => {
  test("the arr is told to delete the files, and the row reaches its terminal state", async () => {
    arrived("tt1375666");
    const radarr = arr();

    const outcome = await removeMedia(deps(radarr), "tt1375666", { deleteFiles: true }, ADMIN);

    expect(outcome).toEqual({
      ok: true,
      value: { tconst: "tt1375666", deletedFiles: true, bytes: 13_000_000_000 },
    });
    expect(radarr.removals).toEqual([{ arrId: 42, deleteFiles: true }]);
    expect(store.getRequest("tt1375666")?.status).toBe("removed");
  });

  /*
    THE ROW SURVIVES, and that is the point of a terminal state rather than a delete: `/log`
    has to go on explaining where a household's film went. A withdraw destroys the row; this
    must not, or an admin's deliberate act becomes indistinguishable from an ask never made.
  */
  test("the request is not deleted -- the log still carries it", async () => {
    arrived("tt1375666");

    await removeMedia(deps(arr()), "tt1375666", { deleteFiles: true }, ADMIN);

    expect(store.getRequest("tt1375666")).not.toBeNull();
    expect(store.listRequests("removed").map((r) => r.tconst)).toEqual(["tt1375666"]);
  });

  test("keeping the files is honoured and echoed back", async () => {
    arrived("tt1375666");
    const radarr = arr();

    const outcome = await removeMedia(deps(radarr), "tt1375666", { deleteFiles: false }, ADMIN);

    expect(radarr.removals).toEqual([{ arrId: 42, deleteFiles: false }]);
    expect(outcome).toMatchObject({ ok: true, value: { deletedFiles: false } });
  });

  /*
    The arr id comes from the library MIRROR, not from `request.arr_id`, which is null whenever
    somebody else added the title first. An admin removing a film they did not request is the
    ordinary case for this feature, and reading the request row alone would refuse it.
  */
  test("a title finderr never added is still removable, by the id the mirror holds", async () => {
    arrived("tt1375666", { arr_id: null });
    const radarr = arr();

    expect((await removeMedia(deps(radarr), "tt1375666", { deleteFiles: true }, ADMIN)).ok).toBe(true);
    expect(radarr.removals).toEqual([{ arrId: 42, deleteFiles: true }]);
  });

  test("a series goes to Sonarr and never to Radarr", async () => {
    arrived("tt0903747", { service: "sonarr" });
    const radarr = arr();
    const sonarr = arr();

    await removeMedia(deps(radarr, sonarr), "tt0903747", { deleteFiles: true }, ADMIN);

    expect(sonarr.removals).toHaveLength(1);
    expect(radarr.removals).toEqual([]);
  });
});

describe("the audit record", () => {
  test("who, what, when, and whether the files went", async () => {
    arrived("tt1375666");

    await removeMedia(deps(arr()), "tt1375666", { deleteFiles: true }, ADMIN);

    expect(store.getMediaRemoval("tt1375666")).toMatchObject({
      tconst: "tt1375666",
      title: "Inception",
      service: "radarr",
      arr_id: 42,
      deleted_files: 1,
      bytes: 13_000_000_000,
      removed_by: "u-admin",
    });
    expect(store.getMediaRemoval("tt1375666")?.removed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  /*
    The system API key is not a person and owns nothing, so it records a null actor rather than
    a made-up one -- the same rule `request.requested_by` follows.
  */
  test("the system key records no actor rather than inventing one", async () => {
    arrived("tt1375666");

    await removeMedia(deps(arr()), "tt1375666", { deleteFiles: false }, { userId: null });

    expect(store.getMediaRemoval("tt1375666")?.removed_by).toBeNull();
  });

  /*
    The size is the one fact the record can never recover: after the delete the arr has nothing
    left to say about it. Reading it fails soft, because a courtesy lookup must not be able to
    block a removal somebody has already decided about.
  */
  test("an arr that will not report a size still gets a record, with a null size", async () => {
    arrived("tt1375666");

    await removeMedia(deps(arr({ holdings: null })), "tt1375666", { deleteFiles: true }, ADMIN);

    expect(store.getMediaRemoval("tt1375666")?.bytes).toBeNull();
  });
});

describe("our own mirrors stop claiming to hold it", () => {
  /*
    Both mirrors are otherwise swapped on a 60-second timer, and that minute is the problem: a
    card saying "in your library", and a re-request refused with "already in your library", on
    the page the admin who deleted it is looking at.
  */
  test("the library row goes with it, so a re-request is not refused for a minute", async () => {
    arrived("tt1375666");

    await removeMedia(deps(arr()), "tt1375666", { deleteFiles: true }, ADMIN);

    expect(store.libraryMap().has("tt1375666")).toBe(false);
  });

  test("a series' mirrored episodes go too", async () => {
    arrived("tt0903747", { service: "sonarr" });
    store.replaceEpisodes("tt0903747", [
      { season: 1, episode: 1, arr_episode_id: 1, has_file: 1, monitored: 1, air_date: "2008-01-20" },
    ]);

    await removeMedia(deps(undefined, arr()), "tt0903747", { deleteFiles: true }, ADMIN);

    expect(store.episodeMap("tt0903747").size).toBe(0);
  });
});

describe("what may not be removed", () => {
  test("a request still in flight is refused -- that is what withdrawing is for", async () => {
    for (const status of ["queued", "sent", "grabbed", "downloading", "manual_import"] as const) {
      arrived(`tt${status}`, { status });
      const radarr = arr();

      const outcome = await removeMedia(deps(radarr), `tt${status}`, { deleteFiles: true }, ADMIN);

      expect(outcome, status).toMatchObject({ ok: false, status: 409 });
      expect(radarr.removals, status).toEqual([]);
    }
  });

  test("removing something twice is refused the second time", async () => {
    arrived("tt1375666");
    await removeMedia(deps(arr()), "tt1375666", { deleteFiles: true }, ADMIN);

    const again = await removeMedia(deps(arr()), "tt1375666", { deleteFiles: true }, ADMIN);

    expect(again).toMatchObject({ ok: false, status: 409 });
  });

  test("a title nobody ever requested is an ordinary 404", async () => {
    expect(await removeMedia(deps(arr()), "tt0000000", { deleteFiles: true }, ADMIN)).toEqual({
      ok: false,
      status: 404,
      error: "unknown request",
    });
  });

  test("an unconfigured arr refuses rather than pretending it removed something", async () => {
    arrived("tt1375666");

    const outcome = await removeMedia(deps(undefined), "tt1375666", { deleteFiles: true }, ADMIN);

    expect(outcome).toMatchObject({ ok: false, status: 503 });
    expect(store.getRequest("tt1375666")?.status).toBe("available");
  });

  test("an arrived request the mirror has no arr id for cannot be removed", async () => {
    arrived("tt1375666", { arr_id: null, inLibrary: false });

    expect(await removeMedia(deps(arr()), "tt1375666", { deleteFiles: true }, ADMIN)).toMatchObject({
      ok: false,
      status: 409,
    });
  });
});

describe("when the arr will not cooperate", () => {
  /*
    THE ORDER THIS PINS, and it is the opposite risk from the one `withdrawRequest` guards.
    Marking the row `removed` before a failed delete would tell a household their film was gone
    while it was still sitting in the library.
  */
  test("a refusal leaves the row, the mirror and the audit exactly as they were", async () => {
    arrived("tt1375666");
    const radarr = arr({ fail: new ArrError("radarr", 500, "/plex/movies is unavailable") });

    const outcome = await removeMedia(deps(radarr), "tt1375666", { deleteFiles: true }, ADMIN);

    expect(outcome).toEqual({
      ok: false,
      status: 502,
      // SANITISED: the arr's own body named a root folder and none of it reaches the caller.
      error: "radarr is having trouble -- try again shortly",
    });
    expect(store.getRequest("tt1375666")?.status).toBe("available");
    expect(store.libraryMap().has("tt1375666")).toBe(true);
    expect(store.getMediaRemoval("tt1375666")).toBeNull();
  });

  /*
    A 404 means the row we were going to remove is already gone, so the state asked for holds.
    The audit still records it, because what it records is the DECISION and who made it.
  */
  test("a title already gone from the arr completes, and is still recorded", async () => {
    arrived("tt1375666");
    const radarr = arr({ fail: new ArrError("radarr", 404, "NotFound") });

    const outcome = await removeMedia(deps(radarr), "tt1375666", { deleteFiles: true }, ADMIN);

    expect(outcome.ok).toBe(true);
    expect(store.getRequest("tt1375666")?.status).toBe("removed");
    expect(store.getMediaRemoval("tt1375666")?.removed_by).toBe("u-admin");
  });
});

describe("asking for it again", () => {
  /*
    THE WAY BACK, and it has to work or a mistaken removal is permanent. `RequestWorker.process`
    refuses anything that is not `queued`, so a fresh ask must genuinely re-open the row rather
    than upsert onto a terminal one.
  */
  test("a fresh request revives the row to queued", async () => {
    arrived("tt1375666");
    await removeMedia(deps(arr()), "tt1375666", { deleteFiles: true }, ADMIN);

    store.createRequest({
      tconst: "tt1375666",
      title: "Inception",
      year: 2010,
      kind: "movie",
      service: "radarr",
      requestedBy: "u-b",
    });

    expect(store.getRequest("tt1375666")?.status).toBe("queued");
    // The NEW asker, and no stale arr id pointing at a library row that no longer exists.
    expect(store.getRequest("tt1375666")?.requested_by).toBe("u-b");
    expect(store.getRequest("tt1375666")?.arr_id).toBeNull();
  });

  /*
    And it COSTS a request. The quota is derived from the row count, so a removal that left the
    old row in place would have made that title free for everybody, forever.
  */
  test("the fresh ask spends a quota row", async () => {
    arrived("tt1375666");
    await removeMedia(deps(arr()), "tt1375666", { deleteFiles: true }, ADMIN);
    expect(store.countRequestsSince("u-b", utcDayStart())).toBe(0);

    store.createRequest({
      tconst: "tt1375666",
      title: "Inception",
      year: 2010,
      kind: "movie",
      service: "radarr",
      requestedBy: "u-b",
    });

    expect(store.countRequestsSince("u-b", utcDayStart())).toBe(1);
  });

  /* The audit outlives the row it described: the removal happened whatever was asked next. */
  test("the record of the removal survives the re-request", async () => {
    arrived("tt1375666");
    await removeMedia(deps(arr()), "tt1375666", { deleteFiles: true }, ADMIN);

    store.createRequest({
      tconst: "tt1375666",
      title: "Inception",
      year: 2010,
      kind: "movie",
      service: "radarr",
      requestedBy: "u-b",
    });

    expect(store.getMediaRemoval("tt1375666")?.removed_by).toBe("u-admin");
  });
});
