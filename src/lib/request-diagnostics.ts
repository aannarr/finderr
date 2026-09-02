/**
 * Why is this request taking so long?
 *
 * Seerr answers that with "Processing" forever, and never distinguishes *searching right
 * now* from *no release has ever existed and never will*. This module is the honest
 * answer: a closed vocabulary of verdicts, the words each one is allowed to say, and the
 * derivation from evidence to verdict.
 *
 * > [!IMPORTANT] PURE ON PURPOSE -- no SQLite, no fetch, no clock of its own
 * > The browser imports `VERDICT_COPY` and `formatRemaining` directly (`web/src` already
 * > reaches into `src/lib` for `facets` and `panes`), so the wording a reader sees and the
 * > vocabulary the server derives have exactly ONE owner. Anything that touches the network
 * > lives in `../server/diagnose-requests.ts`; anything that touches the database lives in
 * > `./store.ts`. Adding either here would take the copy off the wire and put a second copy
 * > in the component.
 *
 * > [!CAUTION] THE HONESTY LIMIT IS THE FEATURE
 * > Every verdict below is derived from evidence we actually hold, and the confident one --
 * > `nothing_accepted` -- is reached only from a POSITIVE observation. Where the evidence
 * > runs out the verdict falls back to the narrower answer rather than guessing, because a
 * > confident lie about somebody's download is worse than an unhelpful truth.
 */

import type { QueueItem } from "./arr";
import { normalizeStripped } from "./normalize";
import type { ProwlarrHistoryRecord } from "./prowlarr";
import type { MediaRequest } from "./store";

/**
 * What a reader may be told about a request. A CLOSED set, and it stays closed.
 *
 * A verdict earns a place here only when finderr has a source that can establish it. The
 * seedbox-cleanup case is the standing example of one that does not: a title that vanished
 * when the seedbox pruned it at day 21 falls into `searching` here, because reading the
 * seedbox was ruled out (aannarr, 2026-09-02) and inventing a "seedbox" verdict with no
 * source behind it is exactly the confident lie this vocabulary exists to prevent.
 */
export type RequestVerdict =
  | "queued"
  | "searching"
  | "downloading"
  | "imported"
  | "nothing_accepted"
  | "no_releases"
  | "failed";

/**
 * The words. One label for a chip, one sentence for a reader who wants to know why.
 *
 * `Record<RequestVerdict, ...>` rather than a lookup with a fallback, so adding a verdict
 * to the union above is a compile error until it has been given words -- which is what
 * stops a new state shipping as a raw enum string in front of a human.
 */
export const VERDICT_COPY: Record<RequestVerdict, { label: string; sentence: string }> = {
  queued: {
    label: "Queued",
    sentence: "Waiting its turn to be sent. Requests go out one at a time so the indexers are not flooded.",
  },
  searching: {
    label: "Searching",
    sentence: "Your indexers are being asked for this. Nothing has turned up yet.",
  },
  downloading: {
    label: "Downloading",
    sentence: "A release was found and is downloading now.",
  },
  imported: {
    label: "Available",
    sentence: "Downloaded and added to your library.",
  },
  nothing_accepted: {
    label: "Nothing accepted",
    // Deliberately does NOT name the quality profile as the cause. A release can be turned
    // down for a size limit, a minimum seeder count or a blocked release group just as
    // easily, and finderr cannot see which -- the arrs record what they GRABBED, never what
    // they were offered and refused. "Usually" is the strongest claim the evidence carries.
    sentence:
      "Your indexers do have releases for this, but none of them were accepted -- usually a quality profile that does not take what is on offer.",
  },
  no_releases: {
    label: "No releases found",
    sentence:
      "Your indexers have been asked for this since you requested it and none of them have a release. That is unlikely to change on its own.",
  },
  failed: {
    label: "Request failed",
    sentence: "The request could not be sent.",
  },
};

/**
 * The evidence gathered for one request. Mirrors the `request_diagnostic` table exactly.
 *
 * EVIDENCE ONLY -- the verdict is derived by `verdictFor` and never stored. A verdict
 * column would be a second copy of a fact whose inputs are right beside it, free to go
 * stale the moment the derivation changes and impossible to notice when it does.
 *
 * Every field is nullable and null means "we do not know", never "no". The distinction
 * carries the whole honesty limit: `releases_seen: 0` is *we asked and the indexers had
 * nothing*, while `releases_seen: null` is *we never got a count*, and only the first of
 * those is allowed to become a verdict.
 */
export interface RequestDiagnostic {
  tconst: string;
  /** Fraction downloaded, 0..1, or null when nothing is in the arr's queue for this. */
  download_progress: number | null;
  /** When the arr expects the download to finish, ISO. See `QueueItem.estimatedCompletionTime`. */
  eta_at: string | null;
  /** When a release was grabbed for this title, ISO. */
  grabbed_at: string | null;
  /** The arr's own quality name for that grab, e.g. "Bluray-1080p". Safe to show; see `ArrHistoryRecord`. */
  grabbed_quality: string | null;
  /** How many distinct indexers ran a query matching this title since it was requested. */
  indexers_searched: number | null;
  /** The most releases any ONE of those searches returned. Null = searched, count unknown. */
  releases_seen: number | null;
  last_search_at: string | null;
  updated_at: string;
}

/**
 * Status plus evidence in, one verdict out.
 *
 * The mapping is mostly the request status renamed for a human -- the interesting part is
 * the ONE place evidence changes the answer: a request the worker has given up on splits
 * into "nobody has this" and "somebody has it and your setup will not take it", which is
 * the difference between shrugging and going to change a quality profile.
 *
 * > [!IMPORTANT] The 24-hour patience rule is NOT re-implemented here
 * > `RequestWorker.reconcile` owns when a request stops being worth waiting for, and it
 * > writes that decision as `status: "no_release"`. This function only refines a decision
 * > that has already been made. A second age check here would be a second definition of
 * > "long enough", and the two would drift the first time either was tuned.
 */
export function verdictFor(
  request: Pick<MediaRequest, "status">,
  diagnostic: Pick<RequestDiagnostic, "releases_seen"> | null,
): RequestVerdict {
  switch (request.status) {
    case "queued":
      return "queued";
    case "failed":
      return "failed";
    case "available":
      return "imported";
    // `grabbed` is the arr having taken a release; from a reader's seat that is the same
    // thing as downloading, and there is nothing more to say until it lands.
    case "grabbed":
    case "downloading":
      return "downloading";
    case "sent":
      return "searching";
    case "no_release":
      // A positive count is the only thing that earns the confident answer. No diagnostic,
      // or a count we never got, both fall back to the narrower verdict.
      return (diagnostic?.releases_seen ?? 0) > 0 ? "nothing_accepted" : "no_releases";
  }
}

// ---------------------------------------------------------------------------
// Live progress -- slice A1
// ---------------------------------------------------------------------------

/** How far along a download is, and when the arr thinks it will land. */
export interface DownloadProgress {
  /** 0..1, clamped. Null when the arr reported a size we cannot divide by. */
  progress: number | null;
  etaAt: string | null;
}

/**
 * Read every queue record belonging to one library item as a single bar.
 *
 * A LIST rather than one record, because a series downloading four episodes at once has
 * four rows against the same `seriesId` and the reader asked for the series. So the bar is
 * the whole ask: bytes summed, and the ETA the LAST of them to land -- picking the first
 * would promise a finish while three episodes were still coming.
 *
 * `size` is bytes and `sizeleft` counts DOWN, so the fraction is what has already arrived.
 * Each record is clamped BEFORE it is summed, because an arr briefly reports `sizeleft`
 * above `size` while a download is being verified and one such row would drag the total
 * backwards.
 */
export function downloadProgressOf(items: readonly QueueItem[]): DownloadProgress {
  let size = 0;
  let left = 0;
  let etaAt: string | null = null;
  let etaMs = Number.NEGATIVE_INFINITY;

  for (const item of items) {
    if (item.size > 0) {
      size += item.size;
      left += Math.min(Math.max(item.sizeleft, 0), item.size);
    }
    // Parsed rather than string-compared: an arr may answer with an offset instead of Z,
    // and "2026-09-02T21:00:00+07:00" sorts after "2026-09-02T15:00:00Z" as text while
    // being the same instant.
    const at = item.estimatedCompletionTime ? Date.parse(item.estimatedCompletionTime) : Number.NaN;
    if (Number.isFinite(at) && at > etaMs) {
      etaMs = at;
      etaAt = item.estimatedCompletionTime ?? null;
    }
  }

  if (size <= 0) return { progress: null, etaAt };
  return { progress: (size - left) / size, etaAt };
}

/**
 * A duration in milliseconds as something a person would say. Never a false precision.
 *
 * Returns null for a duration in the past, which is the honest answer for a stalled
 * download whose estimate has expired: the caller draws no ETA at all rather than
 * counting up, because "-3 min remaining" reads as broken and "0 min" reads as a promise.
 */
export function formatRemaining(ms: number): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
  const days = Math.round(hours / 24);
  return days === 1 ? "about a day" : `about ${days} days`;
}

// ---------------------------------------------------------------------------
// The Prowlarr correlation -- slice A3
// ---------------------------------------------------------------------------

/** What Prowlarr's history says about one title. */
export interface SearchEvidence {
  /** Distinct indexers that ran a matching query. */
  indexers: number;
  /** The most releases any one of those searches returned. Null when no count was given. */
  releasesSeen: number | null;
  lastSearchAt: string | null;
}

/** Prowlarr's word for a search somebody asked for, as opposed to a feed it polls itself. */
const INDEXER_QUERY = "indexerQuery";

/**
 * Does this history row belong to the title we are asking about?
 *
 * > [!CAUTION] There is no id to join on, and there never will be
 * > Prowlarr's history is keyed by the QUERY STRING an arr sent -- no IMDb id, no request
 * > id, nothing finderr holds. So the join is the text, and it is fuzzy by construction.
 *
 * The rule: normalise both sides, then the query must BEGIN with the title, on a word
 * boundary. Radarr and Sonarr both put the title first and append -- a year, `S01E02`,
 * `Season 1` -- so a prefix match catches every real query while a threshold on some
 * similarity score would need a magic number and would fail on short titles ("Us" shares
 * almost no trigrams with "Us 2019").
 *
 * Its two failure modes, both deliberate:
 *
 * - **A title that PREFIXES another matches it.** "Sicario" matches a search for "Sicario
 *   Day of the Soldado". This is the mis-attribution the design accepted: it is good
 *   enough for *has anything ever been found for this* and is exactly why the copy never
 *   claims a search COUNT.
 * - **An arr searching under an alternate or original title matches nothing**, and the
 *   verdict stays at the narrower `searching`. Under-reporting is the safe direction.
 */
export function matchesRequestedTitle(title: string, query: string | undefined): boolean {
  const wanted = normalizeStripped(title);
  const asked = normalizeStripped(query);
  if (wanted === "" || asked === "") return false;
  return asked === wanted || asked.startsWith(`${wanted} `);
}

/**
 * `queryResults` as a number, or null when Prowlarr did not give one.
 *
 * Prowlarr serialises every `data` value as TEXT, so a genuine zero arrives as `"0"` --
 * and `Number(undefined)` is NaN while `Number(null)` is 0, which is the trap: read
 * carelessly, "we never got a count" becomes "the indexer found nothing".
 */
function resultCount(raw: string | number | undefined): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Everything Prowlarr's history says about one requested title since it was asked for.
 *
 * `releasesSeen` is the MAXIMUM across matching searches, never the sum: the same release
 * is returned by every indexer that carries it and by every repeat search, so adding them
 * up would report forty releases for a film with one.
 */
export function searchEvidenceFor(
  records: readonly ProwlarrHistoryRecord[],
  target: { title: string; sinceIso: string },
): SearchEvidence {
  const since = Date.parse(target.sinceIso);
  const indexers = new Set<number>();
  let releasesSeen: number | null = null;
  let lastSearchAt: string | null = null;

  for (const rec of records) {
    // An RSS poll happens whether or not anybody asked for anything -- counting it would
    // make every title on the instance look heavily searched.
    if (rec.eventType !== INDEXER_QUERY) continue;
    if (!matchesRequestedTitle(target.title, rec.data?.query)) continue;
    const at = rec.date ? Date.parse(rec.date) : Number.NaN;
    // A search that ran BEFORE the request cannot be about it. Records with no usable date
    // are dropped rather than assumed recent.
    if (!Number.isFinite(at) || (Number.isFinite(since) && at < since)) continue;

    if (rec.indexerId !== undefined) indexers.add(rec.indexerId);
    const found = resultCount(rec.data?.queryResults);
    if (found !== null) releasesSeen = Math.max(releasesSeen ?? 0, found);
    if (lastSearchAt === null || at > Date.parse(lastSearchAt)) lastSearchAt = rec.date ?? null;
  }

  return { indexers: indexers.size, releasesSeen, lastSearchAt };
}
