/**
 * What "watched" means, and the shapes a reader's watch state travels in.
 *
 * > [!IMPORTANT] PURE AND IMPORT-FREE, BECAUSE THE BROWSER IMPORTS ITS VALUES
 * > `web/src/lib/watch-api.ts` re-exports `isFinished` from here, the same way the web half
 * > already imports `src/lib/terms.ts` and `src/lib/episodes.ts`. That is only safe while this
 * > file imports NOTHING: one server import added here is pulled into the web bundle with it.
 * > So the threshold has exactly one owner and no duplicate to drift from it -- keep it that way.
 */

/** The fraction of a runtime that still counts as "the end". */
export const FINISHED_FRACTION = 0.05;

/** The most remaining time that still counts as "the end", however long the runtime. */
export const FINISHED_MAX_REMAINING_SEC = 180;

/**
 * Has the reader reached the end: within 5% of the runtime or 3 minutes of it, WHICHEVER IS
 * SMALLER.
 *
 * The smaller of the two, so neither end of the runtime scale is absurd: a 45-minute episode
 * finishes 135 s before the end (5%), and a two-hour film 180 s before it rather than six
 * minutes early. A runtime that is not positive and finite is never finished -- there is no end
 * to be near.
 */
export function isFinished(positionSec: number, durationSec: number): boolean {
  if (!Number.isFinite(positionSec) || !Number.isFinite(durationSec) || durationSec <= 0) return false;
  const remaining = durationSec - positionSec;
  return remaining <= Math.min(durationSec * FINISHED_FRACTION, FINISHED_MAX_REMAINING_SEC);
}

/**
 * One stored position, as the API sends it.
 *
 * `season` and `episode` are BOTH null for a film. On disk a film is keyed by `NOT_AN_EPISODE`
 * (`media-file.ts`), but that sentinel is a storage device and never crosses the wire -- a
 * client comparing against -1 would be a second owner of it.
 */
export interface WatchEntry {
  tconst: string;
  season: number | null;
  episode: number | null;
  positionSec: number;
  durationSec: number;
  /** `isFinished(positionSec, durationSec)`, decided on the write that stored this position. */
  finished: boolean;
  /** ISO 8601. */
  updatedAt: string;
}

/** `GET /api/watch/:tconst`. */
export interface WatchState {
  /** The most recently updated entry for this title, film or episode. Null when there is none. */
  resume: WatchEntry | null;
  /** Every episode entry for this title, ordered by season then episode. Empty for a film. */
  episodes: WatchEntry[];
}

/** `GET /api/watch/history`: newest first. */
export interface WatchHistoryPage {
  entries: WatchEntry[];
  /** Whether a further page exists at `offset + entries.length`. */
  hasMore: boolean;
}

/** The body of `PUT`/`POST /api/watch/:tconst`. Omit BOTH `season` and `episode` for a film. */
export interface WatchWrite {
  season?: number;
  episode?: number;
  positionSec: number;
  durationSec: number;
}
