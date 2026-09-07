/**
 * "Take this back out" -- removing media that has already arrived, and recording who did.
 *
 * The other end of a request's life from `./withdraw-request.ts`, and deliberately its own
 * module rather than a branch inside it. Withdrawing calls off an ask and cannot touch a file;
 * this deletes a library entry and, when asked, the files under it. Fusing them would give one
 * function two authorities and put the destructive one an `if` away from the safe one.
 *
 * > [!CAUTION] THE ARR OWNS THE DELETE. finderr never touches the filesystem
 * > Everything here goes through `ArrRemoval`, whose only implementations are the Radarr and
 * > Sonarr clients. There is no path from this module to a file.
 *
 * > [!IMPORTANT] REPLACEMENT-FIRST IS STILL THE RULE, and this feature must not read as its
 * > opposite
 * > The arr brief's standing rule for media is: download the replacement, verify it is
 * > better, then delete. So nothing here offers to delete in order to re-request, the
 * > confirmation copy never suggests it, and the way back is a fresh request that has to be
 * > made deliberately. What this exists for is the mistake -- the wrong Dune, the duplicate,
 * > the thing nobody wants -- which until now could only be fixed by opening Radarr.
 *
 * ADMIN-ONLY, and that rule is NOT here: it is the route, which lives under `/api/admin/` and
 * is guarded by `auth.requireAdmin` -- the one owner of "is this caller an admin". This module
 * takes an actor and records it; it does not decide who may be one.
 *
 * Everything it touches is injected, so the whole policy runs in a test against plain objects
 * with no SQLite, no arr and no network -- the same shape `./withdraw-request.ts` uses.
 */

import { ArrError, type ArrRemoval, safeArrMessage } from "../lib/arr";
import { isRemovable, type MediaRemovalPreview } from "../lib/media-removal";
import type { MediaRequest, Store } from "../lib/store";

/** Only what this module calls, so a test hands over an object literal. */
export interface RemoveMediaDeps {
  store: Pick<
    Store,
    | "getRequest"
    | "updateRequest"
    | "libraryMap"
    | "forgetLibraryEntry"
    | "replaceEpisodes"
    | "recordMediaRemoval"
  >;
  radarr?: ArrRemoval;
  sonarr?: ArrRemoval;
  /** Does Plex still hold this title? From `plex_item` -- see `MediaRemovalPreview.inPlex`. */
  plexHolds: (tconst: string) => boolean;
  log: (...args: unknown[]) => void;
}

/** The admin doing it. Null for the system API key, which is not a person. */
export interface Remover {
  userId: string | null;
}

/** What was removed, as the route reports it back. */
export interface Removed {
  tconst: string;
  /** Did the files go too, or only the arr's entry? Echoes what was asked for. */
  deletedFiles: boolean;
  /** Bytes the arr said it was holding, or null when it reported none. */
  bytes: number | null;
}

/**
 * What happened, as a discriminated union rather than a Response.
 *
 * Generic over the success payload so the PREVIEW and the REMOVAL share one refusal
 * vocabulary: every way this can be declined is declined identically whichever of the two
 * asked, which is what stops a confirmation opening on something the delete would then refuse.
 */
export type RemovalOutcome<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

const UNKNOWN: RemovalOutcome<never> = { ok: false, status: 404, error: "unknown request" };

/**
 * The library item behind a request, resolved once for both halves of the operation.
 *
 * > [!IMPORTANT] The ARR ID comes from the library MIRROR, not from `request.arr_id`
 * > `arr_id` on the request row is written only when OUR add created the arr's row, and is
 * > deliberately left null when the arr answered "already exists" -- see `stopSearching` in
 * > `./withdraw-request.ts`, which relies on exactly that to avoid unmonitoring somebody
 * > else's library entry. Removing asks a different question: not "did we put this here" but
 * > "what is here now", and the mirror is the one thing that knows. An admin removing a film
 * > somebody else added by hand is the ordinary case, not the exception.
 *
 * The mirror also carries the SERVICE, which is the authority on which arr holds the title
 * today; the request row's own `service` is only the fallback for a title the mirror has not
 * caught up with.
 */
function resolveTarget(
  deps: RemoveMediaDeps,
  tconst: string,
): RemovalOutcome<{ row: MediaRequest; service: "radarr" | "sonarr"; arrId: number; client: ArrRemoval }> {
  const row = deps.store.getRequest(tconst);
  if (!row) return UNKNOWN;
  if (!isRemovable(row.status)) {
    return { ok: false, status: 409, error: "nothing has arrived for this request yet" };
  }

  const held = deps.store.libraryMap().get(tconst);
  const service = held?.service ?? row.service;
  const arrId = held?.arr_id ?? row.arr_id;
  if (arrId === null) {
    return { ok: false, status: 409, error: `${service} does not hold this title` };
  }

  const client = service === "radarr" ? deps.radarr : deps.sonarr;
  if (!client) return { ok: false, status: 503, error: `${service} is not configured` };
  return { ok: true, value: { row, service, arrId, client } };
}

/** Turn an arr failure into something a browser may be shown, and keep the rest in the log. */
function arrRefusal(deps: RemoveMediaDeps, what: string, err: unknown): RemovalOutcome<never> {
  // SANITISED, for the reason `safeArrMessage` exists: an arr's error text quotes its response
  // body, which carries root folder paths and internal hostnames, and this string goes to a
  // browser. The full message stays in the log, where an operator debugging it is looking.
  deps.log(`remove FAILED ${what}: ${(err as Error).message}`);
  return { ok: false, status: 502, error: safeArrMessage(err) };
}

/**
 * What deleting this would actually delete -- the facts the confirmation has to state.
 *
 * READ AT THE MOMENT THE QUESTION IS ASKED, and that is the whole reason it is a round trip
 * rather than a field on the request row. A size and a quality mirrored an hour ago describe
 * whatever was on disk an hour ago; an upgrade since then means the confirmation would be
 * about a file that no longer exists. One arr call, made only when somebody presses Remove.
 */
export async function removalPreview(
  deps: RemoveMediaDeps,
  tconst: string,
): Promise<RemovalOutcome<MediaRemovalPreview>> {
  const target = resolveTarget(deps, tconst);
  if (!target.ok) return target;
  const { row, service, arrId, client } = target.value;

  let holdings: Awaited<ReturnType<ArrRemoval["holdings"]>>;
  try {
    holdings = await client.holdings(arrId);
  } catch (err) {
    return arrRefusal(deps, `preview for ${tconst}`, err);
  }
  // Null is the arr saying it no longer holds that row -- somebody removed it by hand. There
  // is nothing to confirm, and 409 is the same answer the delete itself would give.
  if (!holdings) return { ok: false, status: 409, error: `${service} does not hold this title` };

  return {
    ok: true,
    value: {
      tconst,
      title: row.title,
      year: row.year,
      service,
      files: holdings.files,
      bytes: holdings.bytes,
      quality: holdings.quality,
      inPlex: deps.plexHolds(tconst),
    },
  };
}

/**
 * Remove one title's media, then leave a record of it.
 *
 * THE ORDER IS DELIBERATE -- the arr first, our own state second, and it is the opposite risk
 * from the one `withdrawRequest` guards. There, a row deleted before a failed unmonitor would
 * leave a title being searched for that finderr no longer knows about. Here, marking the row
 * `removed` before a failed delete would tell a household their film was gone while it was
 * still sitting in the library. A failed arr call leaves everything exactly as it was and the
 * admin can press the button again.
 *
 * A 404 from the arr is SUCCESS, not a failure: the row we were going to remove is already
 * gone, so the state asked for holds. The audit still records the removal, because what it
 * records is the DECISION and who made it.
 */
export async function removeMedia(
  deps: RemoveMediaDeps,
  tconst: string,
  opts: { deleteFiles: boolean },
  by: Remover,
): Promise<RemovalOutcome<Removed>> {
  const target = resolveTarget(deps, tconst);
  if (!target.ok) return target;
  const { row, service, arrId, client } = target.value;

  // Read BEFORE the delete, because afterwards the arr has nothing to tell us and the size is
  // the one fact the audit row can never recover. A failure to read it is not a reason to
  // refuse the removal, so this is a null rather than a refusal.
  const bytes = await sizeBeforeRemoval(deps, client, arrId);

  try {
    await client.remove(arrId, { deleteFiles: opts.deleteFiles });
  } catch (err) {
    if (!(err instanceof ArrError) || err.status !== 404) {
      return arrRefusal(deps, `"${row.title}" (${tconst})`, err);
    }
    deps.log(`remove: ${service} no longer holds ${tconst} (id ${arrId})`);
  }

  forgetLocally(deps, tconst, service);
  deps.store.updateRequest(tconst, { status: "removed", error: null });
  deps.store.recordMediaRemoval({
    tconst,
    title: row.title,
    service,
    arr_id: arrId,
    deleted_files: opts.deleteFiles ? 1 : 0,
    bytes,
    removed_by: by.userId,
  });
  deps.log(
    `remove: "${row.title}" (${tconst}) out of ${service}` +
      `${opts.deleteFiles ? " with its files" : ", entry only"} by ${by.userId ?? "the system key"}`,
  );

  return { ok: true, value: { tconst, deletedFiles: opts.deleteFiles, bytes } };
}

/** The arr's byte count for the audit row, or null if it will not say. Never throws. */
async function sizeBeforeRemoval(
  deps: RemoveMediaDeps,
  client: ArrRemoval,
  arrId: number,
): Promise<number | null> {
  try {
    return (await client.holdings(arrId))?.bytes ?? null;
  } catch (err) {
    deps.log(`remove: could not read holdings for arr id ${arrId} -- ${(err as Error).message}`);
    return null;
  }
}

/**
 * Bring our mirrors into line with an arr that has just stopped holding this title.
 *
 * Both mirrors are otherwise swapped on a 60-second timer, and that minute is the problem:
 * until it elapses every card says "in your library", `POST /api/requests` refuses a re-ask
 * with "already in your library", and a series still reports per-season progress for episodes
 * that are gone -- on the page the admin who deleted them is looking at.
 *
 * Episodes only for a series, because only Sonarr's mirror has any. `replaceEpisodes` with an
 * empty list is the existing owner of "this series has no mirrored episodes".
 */
function forgetLocally(deps: RemoveMediaDeps, tconst: string, service: "radarr" | "sonarr"): void {
  deps.store.forgetLibraryEntry(tconst);
  if (service === "sonarr") deps.store.replaceEpisodes(tconst, []);
}
