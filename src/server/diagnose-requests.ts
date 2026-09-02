/**
 * Gather the evidence behind "why is this taking so long", from three services at once.
 *
 * Called by `RequestWorker.reconcile` on its timer and nowhere else. The split from the
 * worker is the render-path rule this repo runs on, one layer up: the worker owns what a
 * request's STATUS is, this owns what we have OBSERVED, and neither knows how any of it is
 * worded -- that is `../lib/request-diagnostics.ts`.
 *
 * Everything here takes its clients as arguments, so the whole collector runs in a test
 * against three plain objects with no network and no arr.
 *
 * > [!IMPORTANT] The call count is fixed, not per request
 * > Three reads per pass -- two arr queues, two arr histories, one Prowlarr history -- no
 * > matter how many requests are open. The obvious alternative (Radarr's
 * > `/history/movie?movieId=`, Prowlarr filtered per query) is a call per open request
 * > every thirty seconds, which is how finderr would become the reason the NAS is slow.
 */

import type { ArrClient, QueueItem } from "../lib/arr";
import type { ProwlarrClient } from "../lib/prowlarr";
import {
  type DownloadProgress,
  downloadProgressOf,
  type RequestDiagnostic,
  searchEvidenceFor,
} from "../lib/request-diagnostics";
import type { MediaRequest } from "../lib/store";

/** Radarr's and Sonarr's history word for "a release was taken". They agree on it. */
const ARR_GRAB_EVENT = "grabbed";

/** Only what this module calls, so a test hands over an object literal. */
export interface DiagnoseDeps {
  radarr?: Pick<ArrClient, "queue" | "history">;
  sonarr?: Pick<ArrClient, "queue" | "history">;
  /** Optional. Without it a request that has found nothing can only be reported as still looking. */
  prowlarr?: Pick<ProwlarrClient, "history">;
  log: (...args: unknown[]) => void;
}

/** The grab an arr recorded for one library item. */
interface Grab {
  at: string;
  /** The arr's own quality name, e.g. "Bluray-1080p". The one arr string safe to forward. */
  quality: string | null;
}

/**
 * Read from a service that may not be configured and may not be up. `null` for either.
 *
 * The two are folded into one helper because every caller here treats them identically: a
 * diagnostics pass is decoration on a timer, so a missing Prowlarr and a Radarr that timed
 * out both cost the reader a detail and neither may cost them the reconcile. The message is
 * logged rather than stored, for the reason `safeArrMessage` exists -- an arr's own error
 * text quotes its response body.
 */
async function readFrom<C, T>(
  client: C | undefined,
  what: string,
  log: DiagnoseDeps["log"],
  read: (client: C) => Promise<T | null>,
): Promise<T | null> {
  if (!client) return null;
  try {
    return await read(client);
  } catch (err) {
    log(`diagnostics: ${what} unavailable -- ${(err as Error).message}`);
    return null;
  }
}

/**
 * What both arr queues say, reduced to one bar per library item.
 *
 * Keyed by ARR ID and not by tconst, because that is the only id a queue record carries.
 * Exported because `reconcile` needs the same answer for a different question -- whether a
 * request is downloading at all -- and reading the queues twice on one pass would be two
 * answers that can disagree.
 */
export async function downloadsByArrId(deps: DiagnoseDeps): Promise<Map<number, DownloadProgress>> {
  const pages = await Promise.all([
    readFrom(deps.radarr, "radarr queue", deps.log, (c) => c.queue()),
    readFrom(deps.sonarr, "sonarr queue", deps.log, (c) => c.queue()),
  ]);

  const byId = new Map<number, QueueItem[]>();
  for (const page of pages) {
    for (const rec of page?.records ?? []) {
      const arrId = rec.movieId ?? rec.seriesId;
      if (arrId === undefined) continue;
      const bucket = byId.get(arrId);
      if (bucket) bucket.push(rec);
      else byId.set(arrId, [rec]);
    }
  }

  return new Map([...byId].map(([arrId, items]) => [arrId, downloadProgressOf(items)]));
}

/**
 * The most recent grab each library item has, from one page of each arr's history.
 *
 * History arrives newest first, so the FIRST record seen for an id is the one to keep --
 * a title grabbed, failed and grabbed again should report the latest attempt.
 */
async function grabsByArrId(deps: DiagnoseDeps): Promise<Map<number, Grab>> {
  const pages = await Promise.all([
    readFrom(deps.radarr, "radarr history", deps.log, (c) => c.history()),
    readFrom(deps.sonarr, "sonarr history", deps.log, (c) => c.history()),
  ]);

  const grabs = new Map<number, Grab>();
  for (const page of pages) {
    for (const rec of page?.records ?? []) {
      if (rec.eventType !== ARR_GRAB_EVENT) continue;
      const arrId = rec.movieId ?? rec.seriesId;
      if (arrId === undefined || !rec.date || grabs.has(arrId)) continue;
      grabs.set(arrId, { at: rec.date, quality: rec.quality?.quality?.name ?? null });
    }
  }
  return grabs;
}

/**
 * One evidence row per open request, ready for `Store.upsertRequestDiagnostic`.
 *
 * Rows are returned rather than written, so the collector never touches the database and
 * the worker keeps sole ownership of what gets persisted.
 *
 * A request the queues and histories know nothing about still gets a row, with nulls in it.
 * That is deliberate and is what makes a finished download stop drawing a progress bar: the
 * upsert replaces the whole row, so "we no longer see this" is recorded rather than left
 * behind as the last thing we saw.
 */
export async function diagnoseRequests(
  deps: DiagnoseDeps,
  open: readonly MediaRequest[],
  downloads: Map<number, DownloadProgress>,
): Promise<Omit<RequestDiagnostic, "updated_at">[]> {
  if (open.length === 0) return [];

  const [grabs, prowlarrHistory] = await Promise.all([
    grabsByArrId(deps),
    readFrom(deps.prowlarr, "prowlarr history", deps.log, (c) => c.history()),
  ]);
  const searches = prowlarrHistory?.records ?? [];

  return open.map((r) => {
    const download = r.arr_id === null ? undefined : downloads.get(r.arr_id);
    const grab = r.arr_id === null ? undefined : grabs.get(r.arr_id);
    // No Prowlarr configured means no evidence at all, which must stay distinct from
    // "asked and found nothing" -- so the counts are null rather than zero.
    const evidence = deps.prowlarr
      ? searchEvidenceFor(searches, { title: r.title, sinceIso: r.created_at })
      : { indexers: null, releasesSeen: null, lastSearchAt: null };

    return {
      tconst: r.tconst,
      download_progress: download?.progress ?? null,
      eta_at: download?.etaAt ?? null,
      grabbed_at: grab?.at ?? null,
      grabbed_quality: grab?.quality ?? null,
      indexers_searched: evidence.indexers,
      releases_seen: evidence.releasesSeen,
      last_search_at: evidence.lastSearchAt,
    };
  });
}
