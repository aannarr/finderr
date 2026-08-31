/**
 * The pure rules behind the season selector.
 *
 * Kept out of the component for the same reason `reReadUntilSettled` is kept out of
 * `useTitleDetail`: the interesting part is a set of decisions about which seasons a
 * reader meant, and those are worth testing without React, a DOM, or a fake click.
 *
 * The encoding for the WIRE lives on the server (`src/lib/seasons.ts`) and is not
 * imported here -- that would pull a server module into the browser bundle, the same
 * boundary `decadeOf` and `personNameKey` already respect. Nothing is duplicated: this
 * file deals in `number[]`, which is exactly what the JSON body carries.
 */

import type { Season } from "./facets";

/** Season 0 is the specials. Skyhook returns one for effectively every series. */
export const SPECIALS = 0;

/**
 * What is ticked when the selector first opens: every real season, specials excluded.
 *
 * Excluding specials is not our invention -- Sonarr's own `series/lookup` returns
 * season 0 with `monitored: false` while every real season comes back `true`, so this
 * is the same default the arr would have applied. A reader who wants the 55
 * behind-the-scenes clips can tick them; a reader who says "all" almost never means
 * them.
 */
export function defaultSelection(seasons: readonly Season[]): number[] {
  return seasons
    .map((s) => s.number)
    .filter((n) => n !== SPECIALS)
    .sort((a, b) => a - b);
}

/** Add or remove one season, keeping the list sorted so callers can compare it. */
export function toggleSeason(chosen: readonly number[], season: number): number[] {
  const next = chosen.includes(season) ? chosen.filter((n) => n !== season) : [...chosen, season];
  return [...next].sort((a, b) => a - b);
}

/** Every season the series has, specials included -- what "Select all" ticks. */
export function allSeasonNumbers(seasons: readonly Season[]): number[] {
  return seasons.map((s) => s.number).sort((a, b) => a - b);
}

/**
 * Collapse consecutive runs: `[1,2,3,5]` -> `"1-3, 5"`.
 *
 * A reader picking eight of nine seasons should not be shown eight numbers to read;
 * the run is the shape they were thinking in when they clicked.
 */
export function formatSeasonRanges(chosen: readonly number[]): string {
  const nums = [...new Set(chosen)].sort((a, b) => a - b);
  if (nums.length === 0) return "";

  const runs: string[] = [];
  let start = nums[0] as number;
  let prev = start;

  for (const n of nums.slice(1)) {
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    runs.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = n;
    prev = n;
  }
  runs.push(start === prev ? `${start}` : `${start}-${prev}`);
  return runs.join(", ");
}

/**
 * The sentence the toast says, and the one under the button.
 *
 * `null`/empty means the reader never chose, which is a real state and reads as "all
 * seasons" rather than as nothing. Specials are named rather than numbered, because
 * "Season 0" is an id and nobody calls it that.
 */
export function summariseSeasons(chosen: readonly number[] | null | undefined): string {
  if (!chosen || chosen.length === 0) return "all seasons";

  const specials = chosen.includes(SPECIALS);
  const real = chosen.filter((n) => n !== SPECIALS);

  if (real.length === 0) return "specials only";

  const ranges = formatSeasonRanges(real);
  const noun = real.length === 1 ? "Season" : "Seasons";
  return specials ? `${noun} ${ranges} + specials` : `${noun} ${ranges}`;
}

/**
 * Does this selection name everything the series has?
 *
 * Used to decide whether the confirm button says "Request all" or names the subset --
 * a reader who ticked every box should not be told they picked a subset.
 */
export function isEverySeason(chosen: readonly number[], seasons: readonly Season[]): boolean {
  if (seasons.length === 0) return false;
  const have = new Set(chosen);
  return seasons.every((s) => have.has(s.number));
}
