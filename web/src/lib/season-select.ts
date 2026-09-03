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

import { SPECIALS_SEASON } from "./facet-panes";
import type { Season } from "./facets";
import type { SeasonGap } from "./season-gap";

/**
 * Season 0 is the specials. Skyhook returns one for effectively every series.
 *
 * Re-exported rather than declared: `facet-panes` already owned this number for
 * `orderSeasons` and `seasonLabel`, and a second `= 0` here is a rule two files could
 * disagree about. The alias survives because callers read better for it.
 */
export const SPECIALS = SPECIALS_SEASON;

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
 * What is ticked when the selector opens over a series we ALREADY hold: the seasons with a
 * hole in them, and nothing else.
 *
 * The add path's default is "everything", because a series nobody holds is a series you want
 * all of. Here the reader can see the sentence saying which seasons are short, and pre-ticking
 * a season they already have in full would offer to re-search 12 episodes they own.
 *
 * `current` seasons -- everything aired so far, more to come -- are deliberately NOT ticked.
 * They have no hole today, and Sonarr is already monitoring the rest.
 */
export function fillSelection(gap: readonly SeasonGap[]): number[] {
  return gap
    .filter((g) => g.holding === "partial")
    .map((g) => g.season)
    .sort((a, b) => a - b);
}

/**
 * How many episodes the current selection would actually fetch.
 *
 * The confirm button says this number, so it comes from the same `SeasonGap` list the chips
 * were annotated from -- a button offering 85 while the chips add up to 83 is the exact
 * disagreement `missingEpisodeIdsIn` exists to prevent on the server side.
 *
 * A ticked season with no hole contributes zero rather than being an error: the server drops
 * it the same way, and the two must agree about what a redundant tick means.
 */
export function episodesInSelection(gap: readonly SeasonGap[], chosen: readonly number[]): number {
  const wanted = new Set(chosen);
  return gap.reduce((sum, g) => (wanted.has(g.season) ? sum + g.missing : sum), 0);
}

/**
 * The number a chip wears in fill mode, or nothing at all.
 *
 * A season we hold in full gets no number, because "0" reads as a count of something rather
 * than as the absence of a hole. The seasons worth ticking are exactly the ones wearing a
 * figure, which is what makes the row scannable without reading a legend.
 */
export function missingInSeason(gap: readonly SeasonGap[], season: number): number | undefined {
  const found = gap.find((g) => g.season === season);
  return found && found.missing > 0 ? found.missing : undefined;
}

/**
 * Stand-in seasons built from the numbers the episode mirror knows.
 *
 * The dialog is driven by the `seasons` facet, which is skyhook's and arrives whenever it
 * arrives. The HEADER button that opens it is driven by the episode mirror, which is local
 * -- so a reader can open the chooser before the facet has landed, and an empty dialog
 * would be a worse answer than one whose chips read "Season 3" instead of "Season 3 ·
 * Identity". Every field but the number is null, which is exactly what `seasonLabel` and
 * `orderSeasons` already handle for a season skyhook never named.
 */
export function seasonsFromNumbers(numbers: readonly number[]): Season[] {
  return [...new Set(numbers)]
    .sort((a, b) => a - b)
    .map((number) => ({
      number,
      name: null,
      episodeCount: null,
      premiereDate: null,
      endDate: null,
      image: null,
    }));
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
