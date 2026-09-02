import { describe, expect, test } from "bun:test";
import { type ArrWebhookEvent, nextStatusFor, parseArrWebhook } from "./arr-webhook";
import type { RequestStatus } from "./store";

/**
 * The payloads below are shaped from Radarr's and Sonarr's own
 * `NzbDrone.Core/Notifications/Webhook/*Payload.cs`, read 2026-09-02 -- not from the wiki
 * and not from memory. Only the fields this module reads are kept; the real ones carry
 * images, tags, custom formats and media info that nothing here looks at.
 */

const SONARR_SERIES = { id: 77, title: "Severance", imdbId: "tt11280740" };
const RADARR_MOVIE = { id: 12, title: "Inception", imdbId: "tt1375666" };

function grabbed(event: ArrWebhookEvent) {
  if (event.kind !== "grabbed") throw new Error(`expected a grab, got ${event.kind}`);
  return event;
}

describe("parseArrWebhook", () => {
  test("a body that is not an arr payload is null, which is the only 400", () => {
    expect(parseArrWebhook(null)).toBeNull();
    expect(parseArrWebhook("Grab")).toBeNull();
    expect(parseArrWebhook([])).toBeNull();
    expect(parseArrWebhook({})).toBeNull();
    expect(parseArrWebhook({ series: SONARR_SERIES })).toBeNull();
  });

  test("the connection's Test button is its own event and names no title", () => {
    expect(parseArrWebhook({ eventType: "Test", series: { id: 1, title: "Test Title" } })).toEqual({
      kind: "test",
    });
  });

  test("a grab carries the quality name and the service it came from", () => {
    const sonarr = grabbed(
      parseArrWebhook({
        eventType: "Grab",
        series: SONARR_SERIES,
        release: { quality: "WEBDL-1080p", releaseTitle: "Severance.S02E01.1080p" },
      }) as ArrWebhookEvent,
    );
    expect(sonarr).toEqual({
      kind: "grabbed",
      service: "sonarr",
      arrId: 77,
      imdbId: "tt11280740",
      quality: "WEBDL-1080p",
    });

    const radarr = grabbed(
      parseArrWebhook({ eventType: "Grab", movie: RADARR_MOVIE, release: {} }) as ArrWebhookEvent,
    );
    expect(radarr.service).toBe("radarr");
    expect(radarr.quality).toBeNull();
  });

  /*
    THE TRAP THIS FILE EXISTS TO PIN.

    Sonarr's `onImportComplete` sends `eventType: "Download"` -- the same string
    `onDownload` sends -- because `WebhookBase.BuildOnImportCompletePayload` sets
    `EventType = WebhookEventType.Download` and `ImportComplete` is not a member of that
    enum at all. The two are told apart by `episodeFiles` (plural) versus `episodeFile`.
  */
  test("import-complete and a single import share one eventType and differ by shape", () => {
    const one = parseArrWebhook({
      eventType: "Download",
      series: SONARR_SERIES,
      episodeFile: { id: 5, quality: "WEBDL-1080p" },
      isUpgrade: false,
    });
    expect(one).toEqual({
      kind: "imported",
      complete: false,
      service: "sonarr",
      arrId: 77,
      imdbId: "tt11280740",
    });

    const whole = parseArrWebhook({
      eventType: "Download",
      series: SONARR_SERIES,
      episodeFiles: [{ id: 5 }, { id: 6 }],
      fileCount: 2,
    });
    expect(whole).toMatchObject({ kind: "imported", complete: true });
  });

  test("a Radarr import is complete by construction -- a movie is one file", () => {
    expect(
      parseArrWebhook({ eventType: "Download", movie: RADARR_MOVIE, movieFile: { id: 3 } }),
    ).toMatchObject({ kind: "imported", complete: true, service: "radarr" });
  });

  test("a blocked import is its own event", () => {
    expect(
      parseArrWebhook({
        eventType: "ManualInteractionRequired",
        series: SONARR_SERIES,
        downloadStatus: "Warning",
      }),
    ).toMatchObject({ kind: "manual_interaction", service: "sonarr", arrId: 77 });
  });

  test("a file delete reports WHY, which is the whole reason it is read", () => {
    expect(
      parseArrWebhook({
        eventType: "EpisodeFileDelete",
        series: SONARR_SERIES,
        deleteReason: "Upgrade",
      }),
    ).toMatchObject({ kind: "file_removed", forUpgrade: true });

    expect(
      parseArrWebhook({
        eventType: "MovieFileDelete",
        movie: RADARR_MOVIE,
        deleteReason: "MissingFromDisk",
      }),
    ).toMatchObject({ kind: "file_removed", forUpgrade: false, service: "radarr" });

    // No reason at all is not an upgrade. `undefined` must never read as "yes".
    expect(parseArrWebhook({ eventType: "MovieFileDelete", movie: RADARR_MOVIE })).toMatchObject({
      kind: "file_removed",
      forUpgrade: false,
    });
  });

  test("a real event with no use is ignored rather than refused", () => {
    for (const eventType of ["Rename", "SeriesAdd", "MovieAdded", "ApplicationUpdate"]) {
      expect(parseArrWebhook({ eventType, series: SONARR_SERIES, movie: undefined })).toEqual({
        kind: "ignored",
        eventType,
      });
    }
  });

  test("an event carrying no title is ignored -- there is no row to key it on", () => {
    expect(parseArrWebhook({ eventType: "Health", level: "warning" })).toEqual({
      kind: "ignored",
      eventType: "Health",
    });
  });

  /*
    Radarr's own `WebhookEventType.cs` carries `// TODO: In v4 this will likely be changed
    to the default camel case`, so the casing is a documented future change rather than a
    hypothetical one. One `toLowerCase()` beats finding out from a silent stop in updates.
  */
  test("event types match case-insensitively, because Radarr says the casing will change", () => {
    expect(parseArrWebhook({ eventType: "grab", movie: RADARR_MOVIE })).toMatchObject({
      kind: "grabbed",
    });
    expect(parseArrWebhook({ eventType: "manualInteractionRequired", movie: RADARR_MOVIE })).toMatchObject({
      kind: "manual_interaction",
    });
  });

  test("a title with no IMDb id still resolves through the arr's own row id", () => {
    expect(
      parseArrWebhook({ eventType: "Grab", movie: { id: 12, title: "Untracked", imdbId: "" } }),
    ).toMatchObject({ arrId: 12, imdbId: null });
  });
});

describe("nextStatusFor", () => {
  const grab: ArrWebhookEvent = { kind: "grabbed", service: "radarr", arrId: 1, imdbId: null, quality: null };
  const imported: ArrWebhookEvent = {
    kind: "imported",
    service: "radarr",
    arrId: 1,
    imdbId: null,
    complete: true,
  };
  const blocked: ArrWebhookEvent = {
    kind: "manual_interaction",
    service: "radarr",
    arrId: 1,
    imdbId: null,
  };

  const EVERY_STATUS: RequestStatus[] = [
    "queued",
    "sent",
    "grabbed",
    "downloading",
    "available",
    "failed",
    "no_release",
    "manual_import",
  ];

  test("a grab is the first thing that has ever written the `grabbed` status", () => {
    expect(nextStatusFor(grab, "sent")).toBe("grabbed");
  });

  /*
    `RequestWorker.process` refuses to run for anything that is not `queued`, so advancing
    a queued row here would silently drop the add finderr has not made yet. A grab arriving
    first only means the arr already held the title.
  */
  test("a queued request is never moved, whatever arrives", () => {
    for (const event of [grab, imported, blocked]) expect(nextStatusFor(event, "queued")).toBeNull();
  });

  /*
    `reconcile` is the one writer of `available`, and it is also where the arrival
    notification fires and `available_seen_at` is cleared. A second writer would tell
    somebody twice about one film.
  */
  test("nothing a webhook can say moves an available request", () => {
    for (const event of [grab, imported, blocked]) expect(nextStatusFor(event, "available")).toBeNull();
  });

  test("`available` is not in the range of this function at all", () => {
    for (const status of EVERY_STATUS) {
      for (const event of [grab, imported, blocked]) {
        expect(nextStatusFor(event, status)).not.toBe("available");
      }
    }
  });

  /*
    Ruling D14: a request that ages out stays monitored in the arr, so RSS can still catch
    a REPACK weeks later. This is what that is worth -- the late grab brings the row back.
  */
  test("a late grab brings a given-up request back to life", () => {
    expect(nextStatusFor(grab, "no_release")).toBe("grabbed");
    expect(nextStatusFor(imported, "no_release")).toBe("downloading");
  });

  test("a failed request comes back too -- the add was made by hand", () => {
    expect(nextStatusFor(grab, "failed")).toBe("grabbed");
  });

  test("an import is the way out of a blocked one, and the only way", () => {
    expect(nextStatusFor(imported, "manual_import")).toBe("downloading");
    expect(nextStatusFor(grab, "manual_import")).toBeNull();
  });

  test("a blocked import can happen to anything the arr is working on", () => {
    expect(nextStatusFor(blocked, "sent")).toBe("manual_import");
    expect(nextStatusFor(blocked, "grabbed")).toBe("manual_import");
    expect(nextStatusFor(blocked, "downloading")).toBe("manual_import");
  });

  test("a grab while something is already downloading changes nothing", () => {
    // A series downloading one episode grabs the next; nothing has gone backwards.
    expect(nextStatusFor(grab, "downloading")).toBeNull();
    expect(nextStatusFor(grab, "grabbed")).toBeNull();
  });

  /*
    A delete FOR UPGRADE is a replacement in progress. Knocking the row back would clear
    `available_seen_at` on the way to `available` again and announce one film twice.
  */
  test("a file leaving the library never moves a request, upgrade or not", () => {
    for (const forUpgrade of [true, false]) {
      const event: ArrWebhookEvent = {
        kind: "file_removed",
        forUpgrade,
        service: "radarr",
        arrId: 1,
        imdbId: null,
      };
      for (const status of EVERY_STATUS) expect(nextStatusFor(event, status)).toBeNull();
    }
  });

  test("a test and an ignored event write nothing", () => {
    for (const status of EVERY_STATUS) {
      expect(nextStatusFor({ kind: "test" }, status)).toBeNull();
      expect(nextStatusFor({ kind: "ignored", eventType: "Rename" }, status)).toBeNull();
    }
  });
});
