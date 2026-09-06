/**
 * What Sonarr and Radarr say when they push, and what it means for a request.
 *
 * The arrs already know the moment a release is grabbed, imported, or stuck waiting for a
 * human. finderr's poller learns the same things up to thirty seconds later, and there is
 * one thing it never learns at all -- that an import is BLOCKED and needs somebody to sort
 * it out by hand. This module is the translation from their vocabulary to ours.
 *
 * > [!IMPORTANT] PURE ON PURPOSE -- no SQLite, no fetch, no clock, no HTTP
 * > Parsing an untrusted body and deciding a state transition are two things worth testing
 * > against object literals, and both are worth reading without an HTTP handler around them.
 * > The route, the credentials and the writes live in `../server/arr-webhook.ts`; this is
 * > the half that has no I/O in it. It mirrors the split `./request-diagnostics.ts` already
 * > makes against `../server/diagnose-requests.ts`.
 *
 * > [!CAUTION] THE WIRE VOCABULARY IS NOT THE CONNECTION'S FIELD NAMES
 * > A Webhook connection is configured with toggles called `onGrab`, `onDownload`,
 * > `onImportComplete`, `onManualInteractionRequired` and so on -- that is what
 * > `GET /api/v3/notification/schema` returns. The `eventType` on the WIRE is a different,
 * > shorter set: `Test Grab Download Rename SeriesAdd SeriesDelete EpisodeFileDelete Health
 * > HealthRestored ApplicationUpdate ManualInteractionRequired`, and Radarr swaps the series
 * > trio for `MovieAdded MovieDelete MovieFileDelete`. Read from
 * > `NzbDrone.Core/Notifications/Webhook/WebhookEventType.cs` in both projects, 2026-09-02.
 * >
 * > The trap this cost: **`onImportComplete` sends `eventType: "Download"`, exactly like
 * > `onDownload`.** `ImportComplete` is not a member of the enum at all --
 * > `WebhookBase.BuildOnImportCompletePayload` sets `EventType = WebhookEventType.Download`.
 * > The two are told apart by their PAYLOAD: import-complete carries `episodeFiles` (plural,
 * > with `fileCount`, `sourcePath`, `destinationPath`), a single import carries `episodeFile`
 * > (singular, with `isUpgrade`). See `importedEvent` below.
 */

import type { RequestStatus } from "./store";

/** Which of the two library arrs sent this. Prowlarr has no webhook finderr wants. */
export type ArrService = "radarr" | "sonarr";

/**
 * Which title an event is about, in the two ids the payload carries.
 *
 * BOTH, because neither is reliable alone: a movie or series without an IMDb id sends
 * `imdbId: null` (Radarr happily holds one), and the arr's own row id is only meaningful
 * next to the service that issued it. The resolver in `../server/arr-webhook.ts` tries the
 * IMDb id first and falls back to `(service, arrId)`.
 */
export interface ArrSubject {
  service: ArrService;
  /** The arr's own row id for the movie or series. Null when the payload omitted it. */
  arrId: number | null;
  /** IMDb id (`tt...`), or null when the arr does not hold one for this title. */
  imdbId: string | null;
}

/**
 * One arr webhook, reduced to the vocabulary finderr reasons in.
 *
 * A DISCRIMINATED UNION rather than the raw payload, so `nextStatusFor` switches on a
 * closed set the compiler can check exhaustively, and so a payload shape change upstream is
 * one edit here rather than a hunt through the route. `ignored` is a real member rather than
 * a null return: an event we deliberately do nothing about and an event we could not read
 * are different answers, and only the second is worth a 400.
 */
export type ArrWebhookEvent =
  /** The connection's own "Test" button. Nothing to do but say yes, loudly enough to pass. */
  | { kind: "test" }
  /** A release was taken. The first thing that has ever written the `grabbed` status. */
  | ({ kind: "grabbed"; quality: string | null } & ArrSubject)
  /**
   * A file was imported into the library.
   *
   * `complete` distinguishes Sonarr's import-complete (the whole grab landed) from a single
   * file of one -- see the caution at the top for why that is a payload question and not an
   * event-type one. Radarr imports a movie as one file, so it is always complete there.
   */
  | ({ kind: "imported"; complete: boolean } & ArrSubject)
  /** The download finished and the arr cannot file it without a human. */
  | ({ kind: "manual_interaction" } & ArrSubject)
  /**
   * A file left the library. `forUpgrade` is the whole reason this event is read at all:
   * it separates a replacement from a loss. See `nextStatusFor`.
   */
  | ({ kind: "file_removed"; forUpgrade: boolean } & ArrSubject)
  /** A real event this application has no use for. Accepted and dropped. */
  | { kind: "ignored"; eventType: string };

/**
 * The members that name a title, which are the only ones a request row can be found for.
 *
 * Derived rather than listed, so a member added above joins it by carrying `ArrSubject` and
 * cannot be forgotten here.
 */
export type ArrTitleEvent = Extract<ArrWebhookEvent, ArrSubject>;

/**
 * Read one field off an untrusted body without pretending to know the whole shape.
 *
 * Everything below goes through these three rather than through a cast: the body arrives
 * from the network, and an `as WebhookPayload` would be a lie the compiler then propagates
 * into every field access.
 */
function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function int(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

/**
 * The subject of an event, from whichever of `movie` and `series` the payload carries.
 *
 * Which key is present IS the service: a Radarr payload has `movie` and a Sonarr payload has
 * `series`, on every event type that names a title. `instanceName` is deliberately not used
 * for this -- it is operator-editable free text and defaults to the product name, so an
 * operator who renamed their instance would break the routing silently.
 */
function subjectOf(payload: Record<string, unknown>): ArrSubject | null {
  const movie = obj(payload.movie);
  const series = obj(payload.series);
  const body = movie ?? series;
  if (!body) return null;
  return {
    service: movie ? "radarr" : "sonarr",
    arrId: int(body.id),
    imdbId: str(body.imdbId),
  };
}

/** Radarr's and Sonarr's shared `DeleteMediaFileReason` member for "a better one arrived". */
const DELETE_REASON_UPGRADE = "upgrade";

/**
 * Turn a `Download` payload into an event, reading `complete` off the payload's SHAPE.
 *
 * `episodeFiles` (plural) is Sonarr's import-complete payload and `episodeFile` (singular)
 * is one file of an import. Radarr sends neither -- a movie is one file and the import is
 * complete by construction -- so the absence of both plural and singular episode keys reads
 * as complete rather than as unknown.
 */
function importedEvent(payload: Record<string, unknown>, subject: ArrSubject): ArrWebhookEvent {
  const complete = Array.isArray(payload.episodeFiles) || payload.episodeFile === undefined;
  return { kind: "imported", complete, ...subject };
}

/**
 * An arr's webhook body as an event, or null when it is not one.
 *
 * Null means "this is not something an arr sent" -- no object, or no `eventType` -- which is
 * the only case worth a 400. Everything else is either understood or explicitly `ignored`.
 *
 * Matching is CASE-INSENSITIVE on the event type. Not defensive padding: Radarr's own
 * `WebhookEventType.cs` carries a standing `// TODO: In v4 this will likely be changed to
 * the default camel case`, so the casing is a documented future change and one
 * `toLowerCase()` is cheaper than finding out from a silent stop in request updates.
 */
export function parseArrWebhook(body: unknown): ArrWebhookEvent | null {
  const payload = obj(body);
  if (!payload) return null;
  const eventType = str(payload.eventType);
  if (!eventType) return null;

  const type = eventType.toLowerCase();
  if (type === "test") return { kind: "test" };

  const subject = subjectOf(payload);
  // Health, application-update and the two delete-the-whole-title events either carry no
  // title or carry one finderr has nothing to say about. Without a subject there is nothing
  // to key a request row on, so they are dropped here rather than in every branch below.
  if (!subject) return { kind: "ignored", eventType };

  switch (type) {
    case "grab":
      return { kind: "grabbed", quality: str(obj(payload.release)?.quality), ...subject };
    case "download":
      return importedEvent(payload, subject);
    case "manualinteractionrequired":
      return { kind: "manual_interaction", ...subject };
    case "episodefiledelete":
    case "moviefiledelete":
      return {
        kind: "file_removed",
        forUpgrade: str(payload.deleteReason)?.toLowerCase() === DELETE_REASON_UPGRADE,
        ...subject,
      };
    default:
      return { kind: "ignored", eventType };
  }
}

/**
 * The status a request should move to because of this event, or null to leave it alone.
 *
 * > [!IMPORTANT] `available` is NOT in the range of this function, and that is the design
 * > A request becomes available in exactly one place -- `RequestWorker.reconcile`, from the
 * > library mirror -- and that is also the one place the arrival notification fires and
 * > `available_seen_at` is cleared. A second writer here would give "this arrived" two
 * > owners that can disagree, and the visible failure would be somebody being told twice
 * > about one film. So the furthest a webhook may push a row is `downloading`, and the
 * > mirror closes the last step within a library refresh plus a reconcile pass (~90s on the
 * > defaults). Fast where we are entitled to be fast, and unchanged where we are not.
 *
 * Two more rules worth reading before adding a case:
 *
 * - **`queued` is never moved.** The row is still waiting for `RequestWorker.process`, which
 *   refuses to run for anything that is not `queued` -- so advancing it here would silently
 *   drop the add. A grab arriving first only means the arr already held the title.
 * - **Nothing ever moves backwards.** `available`, `queued` and `removed` are left alone by
 *   every event; the rest are states a webhook is allowed to advance out of, including the two
 *   dead ends. `no_release` coming back to life on a late grab is the RSS-catches-a-REPACK
 *   case that ruling D14 leaves the arr entry monitored for, and `failed` coming back means
 *   the add finderr could not make had already been made by hand.
 * - **`removed` is a DECISION and not an observation**, which is why no event may revive it.
 *   An admin took the title out of the arr; if somebody puts it back by hand and it imports,
 *   the arr will say so and this function will still say nothing, because our record of who
 *   removed what must not be erased by the arr. Asking for the title again is what re-opens
 *   the row -- see `RequestStatus.removed`.
 */
export function nextStatusFor(event: ArrWebhookEvent, current: RequestStatus): RequestStatus | null {
  switch (event.kind) {
    case "grabbed":
      return moveTo("grabbed", current, GRAB_MOVES);
    case "imported":
      return moveTo("downloading", current, IMPORT_MOVES);
    case "manual_interaction":
      return moveTo("manual_import", current, BLOCK_MOVES);
    /*
      A file leaving the library never moves a request, and the upgrade case is why the
      event is read at all rather than left out.

      A delete FOR UPGRADE is a replacement in progress: the arr already holds a better
      release and is about to file it. Knocking the row back to `downloading` would send the
      person who asked a second arrival notification for one film, because the transition
      into `available` clears `available_seen_at`. A delete for any other reason is the
      library mirror's business -- it is the owner of what is on disk, and it will notice.
    */
    case "file_removed":
    case "test":
    case "ignored":
      return null;
  }
}

/**
 * A grab means the arr took a release.
 *
 * Not from `downloading`: a series downloading one episode grabs the next without anything
 * having gone backwards. Not from `manual_import` either -- that row's download already
 * finished and is waiting for a person, and a fresh grab elsewhere in the same series must
 * not erase the one status no other source can tell us.
 */
const GRAB_MOVES: ReadonlySet<RequestStatus> = new Set(["sent", "failed", "no_release"]);

/**
 * An import means a file landed. It is the event that CLEARS `manual_import`, which is the
 * only way out of that state short of the mirror seeing the file.
 */
const IMPORT_MOVES: ReadonlySet<RequestStatus> = new Set([
  "sent",
  "grabbed",
  "failed",
  "no_release",
  "manual_import",
]);

/** A blocked import can happen to anything the arr is actively working on. */
const BLOCK_MOVES: ReadonlySet<RequestStatus> = new Set([
  "sent",
  "grabbed",
  "downloading",
  "failed",
  "no_release",
]);

/**
 * `target`, if `current` is one of the states this event may move, else null.
 *
 * Each set is written out rather than derived from an ordering, because the lifecycle is not
 * a line: `manual_import` sits beside `downloading` rather than after it, and a rank would
 * have to be argued about instead of read. `queued`, `available` and `removed` are in NO set,
 * which is how the rules on `nextStatusFor` are enforced rather than restated.
 */
function moveTo(
  target: RequestStatus,
  current: RequestStatus,
  from: ReadonlySet<RequestStatus>,
): RequestStatus | null {
  return from.has(current) ? target : null;
}
