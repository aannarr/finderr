/**
 * What a reader's watch state MEANS on screen: where to resume, how far through an episode they
 * are, and which episode comes next.
 *
 * PURE, the split the rest of the player uses. The threshold for "finished" is not here --
 * `isFinished` in `src/lib/watch-progress.ts` owns it and the server stores its verdict on every
 * write -- so this reads `finished` rather than re-deciding it.
 */

import { episodeLabel } from "./facet-panes";
import type { Episode } from "./facets";
import type { WatchEntry, WatchState } from "./watch-api";

/**
 * Below this, starting from the top is what the reader wants. Thirty seconds is the opening
 * of a film -- a studio card, a cold open -- and offering to "resume" at 0:12 is noise.
 */
export const RESUME_MIN_SEC = 30;

/** Worth resuming: not finished, and far enough in to matter. */
const resumable = (entry: WatchEntry | null | undefined): entry is WatchEntry =>
  !!entry && !entry.finished && entry.positionSec >= RESUME_MIN_SEC;

/** Where to start this film or episode, in seconds, or null to start at the top. */
export function resumeFor(
  state: WatchState | null,
  at: { season?: number; episode?: number },
): number | null {
  if (!state) return null;
  const entry =
    at.season === undefined || at.episode === undefined
      ? state.resume?.season === null
        ? state.resume
        : null
      : state.episodes.find((e) => e.season === at.season && e.episode === at.episode);
  return resumable(entry) ? entry.positionSec : null;
}

/**
 * What the title header offers to resume: the most recently watched entry, if it is unfinished.
 *
 * For a series that is an EPISODE, so the header's control plays that episode -- the reader
 * asked "carry on", not "start the show again".
 */
export function headerResume(state: WatchState | null): WatchEntry | null {
  return resumable(state?.resume) ? (state?.resume ?? null) : null;
}

/** `S1E3`. */
export const episodeCode = (season: number, episode: number): string => `S${season}E${episode}`;

/** `S1E3 · The Dragon's Nest` -- what the player's top bar and the up-next card call an episode. */
export const episodeTitleLine = (episode: Episode): string =>
  `${episodeCode(episode.season, episode.number)} · ${episodeLabel(episode)}`;

/**
 * The episode after this one, across a season boundary, never into season 0.
 *
 * `playable` is asked per candidate and the first yes wins, so an episode we do not hold is
 * skipped rather than offered as a Next that would only answer "nothing playable". Sorted here
 * rather than trusted: the facet is in provider order, and "next" must not depend on it.
 */
export function nextEpisode(
  episodes: readonly Episode[],
  current: { season: number; episode: number },
  playable: (season: number, episode: number) => boolean = () => true,
): Episode | null {
  const ordered = episodes
    .filter((e) => e.season > 0)
    .sort((a, b) => a.season - b.season || a.number - b.number);
  return (
    ordered.find(
      (e) =>
        (e.season > current.season || (e.season === current.season && e.number > current.episode)) &&
        playable(e.season, e.number),
    ) ?? null
  );
}

/** A title's episode entries as a lookup, keyed on the same `season:episode` pair the rows use. */
export function watchIndex(entries: readonly WatchEntry[] | undefined): Map<string, WatchEntry> {
  return new Map((entries ?? []).map((e) => [`${e.season}:${e.episode}`, e]));
}

/**
 * How far through an episode the reader is, for a row's progress bar.
 *
 * Null when there is nothing to draw: never started, or finished (which draws a check instead,
 * not a full bar -- a full bar and "watched" are the same fact, and one mark is enough).
 */
export function progressFraction(entry: WatchEntry | undefined): number | null {
  if (!entry || entry.finished || entry.durationSec <= 0 || entry.positionSec <= 0) return null;
  return Math.min(1, entry.positionSec / entry.durationSec);
}
