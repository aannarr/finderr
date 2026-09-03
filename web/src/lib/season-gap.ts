/**
 * How much of a series we actually hold, season by season.
 *
 * The household question is "get me the REST of this show", and until now the product had
 * no sentence for it: the title header carries one percentage off the library mirror, and
 * the episode rows carry one dot each. Neither answers "which seasons am I short".
 *
 * > [!IMPORTANT] ONE fact, and it is Sonarr's `hasFile`
 * > `progress`, `hasFile` and `plex_item` are three different facts about the same series.
 * > This module reads exactly one of them -- whether OUR Sonarr has a file -- and the copy
 * > says "downloaded" rather than "available" for that reason. A series can be complete
 * > here and unplayable in Plex, which has not scanned it yet; `plex_item` is the only
 * > table that knows what is playable and nothing below consults it.
 *
 * Nothing here fetches. Both sides are already on the page: the `episodes` facet is what
 * EXISTS (skyhook, cached in SQLite) and `episodeState` is what Sonarr HOLDS, and they
 * join on the (season, episode) pair -- the same join `SeriesPane` already draws per row.
 * This is that row rule rolled up, not a second rule: every classification below comes out
 * of `episodeStanding`, so a season summary can never contradict the dots beneath it.
 */

import { airedWithoutFile, type EpisodeState, episodeStanding } from "../../../src/lib/episodes";
import { episodeStateIndex, episodesForSeason, SPECIALS_SEASON } from "./facet-panes";
import type { Episode, Season } from "./facets";
import { summariseSeasons } from "./season-select";

/**
 * Where one season stands.
 *
 * `current` exists so that a season still airing is not called `complete`. Holding every
 * episode broadcast so far is the best a reader can be, but saying "complete" about a
 * season with four more episodes to come would be a promise the show has not kept yet.
 */
export type SeasonHolding = "complete" | "current" | "partial";

export interface SeasonGap {
  season: number;
  holding: SeasonHolding;
  /** Aired episodes with no file. Zero unless `holding` is `partial`. */
  missing: number;
}

/**
 * Every season we can say something honest about, in the order they were given.
 *
 * Empty when there is nothing to say, and that is the common case: a series Sonarr does
 * not hold sends no `episodeState` at all, so every episode is `unknown` and no season
 * survives the filter. The pane then draws nothing rather than a sentence about zero.
 *
 * SEASON 0 IS EXCLUDED. It is the specials -- trailers, recaps, behind-the-scenes shorts,
 * 55 of them on Game of Thrones -- and counting them as missing content would tell every
 * reader of every series that they are short of a show they have in full.
 */
export function seriesGap(
  seasons: readonly Season[],
  episodes: readonly Episode[],
  episodeState: readonly EpisodeState[] | undefined,
  today: string,
): SeasonGap[] {
  const state = episodeStateIndex(episodeState);
  if (state.size === 0) return [];

  const gaps: SeasonGap[] = [];
  for (const season of seasons) {
    if (season.number === SPECIALS_SEASON) continue;
    const gap = seasonGap(season.number, episodesForSeason(episodes, season.number), state, today);
    if (gap) gaps.push(gap);
  }
  return gaps;
}

/**
 * One season, or null when it is too early to have an opinion about it.
 *
 * "Too early" is every episode reading `unknown`: either the season has not started airing
 * or Sonarr has never heard of it. Both mean the same thing to a reader -- there is
 * nothing to be short of yet -- and saying so would be noise on a row of nine seasons.
 */
function seasonGap(
  number: number,
  episodes: readonly Episode[],
  state: Map<string, EpisodeState>,
  today: string,
): SeasonGap | null {
  let owned = 0;
  let missing = 0;
  let unaired = 0;

  for (const episode of episodes) {
    const standing = episodeStanding(state.get(`${episode.season}:${episode.number}`), today);
    if (standing === "owned") owned += 1;
    // `airedWithoutFile` owns the wanted/missing pair, so this count and the ids the
    // season request actually enqueues can never mean two different things.
    else if (airedWithoutFile(standing)) missing += 1;
    else unaired += 1;
  }

  if (owned + missing === 0) return null;
  if (missing > 0) return { season: number, holding: "partial", missing };
  return { season: number, holding: unaired > 0 ? "current" : "complete", missing: 0 };
}

/**
 * The one line the pane draws: `Downloaded: Seasons 1-2 complete, Season 3 missing 4 episodes`.
 *
 * Three clauses at most, whatever the series looks like. The partial seasons collapse into
 * a range with ONE total the same way the complete ones do, so a series where nothing has
 * been downloaded yet reads `Seasons 1-8 missing 73 episodes` instead of eight clauses
 * nobody finishes. The per-season detail is one chip away, which is where a reader who
 * wants it is already headed.
 *
 * `summariseSeasons` does the run-collapsing and the singular/plural noun, because the
 * request dialog already had to solve exactly that and a second copy would drift.
 */
export function summariseSeriesGap(gap: readonly SeasonGap[]): string | null {
  if (gap.length === 0) return null;

  const clauses = [
    seasonsClause(gap, "complete", "complete"),
    seasonsClause(gap, "current", "up to date"),
    partialClause(gap),
  ].filter((c): c is string => c !== null);

  return clauses.length === 0 ? null : `Downloaded: ${clauses.join(", ")}`;
}

function seasonsClause(gap: readonly SeasonGap[], holding: SeasonHolding, suffix: string): string | null {
  const numbers = gap.filter((g) => g.holding === holding).map((g) => g.season);
  return numbers.length === 0 ? null : `${summariseSeasons(numbers)} ${suffix}`;
}

function partialClause(gap: readonly SeasonGap[]): string | null {
  const partial = gap.filter((g) => g.holding === "partial");
  if (partial.length === 0) return null;
  const total = partial.reduce((sum, g) => sum + g.missing, 0);
  const noun = total === 1 ? "episode" : "episodes";
  return `${summariseSeasons(partial.map((g) => g.season))} missing ${total} ${noun}`;
}
