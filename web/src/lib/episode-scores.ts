/**
 * Per-episode IMDb scores, and the three shapes the title page draws them in.
 *
 * ## Two sources, and only one of them is ours to be complete about
 *
 * A cell on this grid is a JOIN, and the halves come from different places for different
 * reasons:
 *
 * - **the skeleton** -- which seasons exist, which episodes are in them, what they are
 *   called and when they aired -- comes from the `seasons`/`episodes` facets skyhook
 *   already provides and `SeriesPane` already draws.
 * - **the score** comes from our own index, built from IMDb's `title.episode` +
 *   `title.ratings` dumps.
 *
 * > [!IMPORTANT] A MISSING SCORE IS A NORMAL ANSWER, NOT A GAP
 * > Measured against the real dumps on 2026-09-04: IMDb lists an episode only once it
 * > EXISTS. Silo's `title.episode` rows stop at S3E9 -- there is no S4 at all, and no
 * > S3E10 -- while the skeleton knows about both. So an unaired episode has a row in the
 * > skeleton and no score, forever, and that is correct rather than something to chase.
 * > Nothing here should ever try to complete the score side against another provider.
 *
 * The direction of the join follows from that: we walk the SKELETON and look scores up,
 * never the reverse. Walking the scores would silently drop every unaired episode, which
 * is exactly the column a reader opens this to look at.
 *
 * ## Everything here is pure
 *
 * No React, no DOM, no fetching -- the same rule `facet-panes.ts` and `season-gap.ts`
 * follow, and for the same reason: these are the rules worth testing, and a rule tangled
 * up in a component is a rule tested through a renderer.
 */

/**
 * One episode's score, as our index answers it.
 *
 * RE-EXPORTED from the server module that owns the shape rather than copied. A TYPE-only
 * import across the `src/` boundary costs nothing at runtime -- it is erased -- which is
 * the precedent `HiddenByFloor` already set in `./api.ts`. That is deliberately not the
 * same permission a VALUE import would need: `decadeOf` and `personNameKey` are duplicated
 * precisely because importing them would pull a server module into the browser bundle.
 * One owner for the shape, no bundle cost, and the two halves cannot drift.
 */
import type { EpisodeScoreRow as EpisodeScore } from "../../../src/server/episode-scores";
import { episodeLabel, episodesForSeason, orderSeasons, SPECIALS_SEASON } from "./facet-panes";
import type { Episode, Season } from "./facets";

export type { EpisodeScoreRow as EpisodeScore } from "../../../src/server/episode-scores";

/**
 * The quality bands, worst to best.
 *
 * These are OURS. They are modelled on the reference design aannarr asked for, read off its
 * own rendering rather than from any documentation, and the boundaries are whole tenths so
 * a reader can predict which colour a number gets without a legend. `cinema` is a
 * deliberately tiny top band -- it means something only because almost nothing reaches it.
 */
export type ScoreBand = "garbage" | "bad" | "average" | "good" | "great" | "awesome" | "cinema";

/** The lower bound of each band, highest first -- the order `bandFor` scans in. */
const BAND_FLOORS: readonly (readonly [ScoreBand, number])[] = [
  ["cinema", 9.7],
  ["awesome", 9],
  ["great", 8],
  ["good", 7],
  ["average", 6],
  ["bad", 4],
  ["garbage", 0],
];

/** Legend order, worst to best reversed -- best first, as the reference prints it. */
export const BAND_ORDER: readonly ScoreBand[] = [
  "cinema",
  "awesome",
  "great",
  "good",
  "average",
  "bad",
  "garbage",
];

export const BAND_LABEL: Record<ScoreBand, string> = {
  cinema: "Absolute Cinema",
  awesome: "Awesome",
  great: "Great",
  good: "Good",
  average: "Average",
  bad: "Bad",
  garbage: "Garbage",
};

/**
 * Which band a score falls in, or `null` for no score at all.
 *
 * `null` in and `null` out is the whole reason this returns a nullable: an unrated episode
 * has no band, and the alternative -- coercing it to 0 and calling it `garbage` -- would
 * print the harshest label on screen for an episode nobody has watched yet.
 */
export function bandFor(rating: number | null | undefined): ScoreBand | null {
  if (rating === null || rating === undefined || !Number.isFinite(rating)) return null;
  for (const [band, floor] of BAND_FLOORS) if (rating >= floor) return band;
  return "garbage";
}

/** Key for the (season, episode) pair both sources agree on. Built and read only here. */
function pairKey(season: number, episode: number): string {
  return `${season}:${episode}`;
}

/** The scores as a lookup. Later duplicates lose, so one bad row cannot shadow a good one. */
export function scoreIndex(scores: readonly EpisodeScore[] | undefined): Map<string, EpisodeScore> {
  const out = new Map<string, EpisodeScore>();
  for (const s of scores ?? []) {
    const key = pairKey(s.season, s.number);
    if (!out.has(key)) out.set(key, s);
  }
  return out;
}

/**
 * One episode, skeleton and score joined. `rating` null covers both unaired and unrated.
 *
 * `image` and `overview` ride along because the hover card wants them and they are already
 * on the skeleton. The still is the one genuinely new use for `Episode.image`: it has been
 * fetched, proxied and cached since the facet image proxy landed, and `SeriesPane`
 * deliberately draws none of them -- one still per row over 73 rows is a different screen
 * from the one air dates are for. A card that appears for ONE episode at a time is exactly
 * the place that asset was waiting for.
 */
export interface ScoredEpisode {
  season: number;
  number: number;
  label: string;
  airDate: string | null;
  rating: number | null;
  votes: number;
  band: ScoreBand | null;
  /** Already rewritten to `/img/f/<key>` by the server. Still guard it before use. */
  image: string | null;
  overview: string | null;
}

function join(episode: Episode, scores: Map<string, EpisodeScore>): ScoredEpisode {
  const score = scores.get(pairKey(episode.season, episode.number));
  const rating = score?.rating ?? null;
  return {
    season: episode.season,
    number: episode.number,
    label: episodeLabel(episode),
    airDate: episode.airDate,
    rating,
    votes: score?.votes ?? 0,
    band: bandFor(rating),
    image: episode.image,
    overview: episode.overview,
  };
}

/**
 * The mean of the RATED episodes only, to one decimal, or `null` when none are rated.
 *
 * Excluding the unrated ones is the entire subtlety here, and it is why this function
 * exists rather than an inline `reduce` at each call site. Counting an unaired episode as
 * a zero would drag a season's average down for the crime of not having happened yet;
 * counting it as the mean would be inventing data. It is left out, and a season with
 * nothing rated reports `null` so the caller can print a placeholder rather than `0.0`.
 *
 * Rounded here rather than at the point of display so that the number a reader sees and
 * the number a band is picked from are the same one -- rounding after banding would put
 * an `8.0` label on a `great` cell computed from 7.96.
 */
export function averageRating(episodes: readonly { rating: number | null }[]): number | null {
  const rated = episodes.filter((e) => e.rating !== null).map((e) => e.rating as number);
  if (rated.length === 0) return null;
  const mean = rated.reduce((a, b) => a + b, 0) / rated.length;
  return Math.round(mean * 10) / 10;
}

// --- the grid ---------------------------------------------------------------

export interface GridColumn {
  season: number;
  /** `S1`, and `S0` for the specials -- the grid header has no room for a real name. */
  label: string;
  average: number | null;
  averageBand: ScoreBand | null;
  /** One entry per row of the grid. `null` where this season has no such episode number. */
  cells: (ScoredEpisode | null)[];
}

export interface EpisodeGrid {
  columns: GridColumn[];
  /** Episode numbers down the side, `1..n`, clamped by `maxRows`. */
  rows: number[];
  /** Rows the clamp held back. `0` when the whole grid fits. */
  hiddenRows: number;
}

/**
 * How tall the grid gets before it is clamped.
 *
 * A grid is as tall as its LONGEST column, so one enormous season sets the height of every
 * other one -- and the shape a reader came to see gets pushed off the screen by a column
 * of blanks. Thirty is comfortably past a normal season and well short of the cases that
 * break the shape.
 */
export const GRID_MAX_ROWS = 30;

/**
 * The grid: a column per season, a row per episode number.
 *
 * Ragged by nature -- seasons have different lengths and the reference pads with blanks
 * rather than staggering the rows, because reading ACROSS a row (how did every season's
 * third episode do?) is half the point of the shape.
 *
 * Column order is `orderSeasons`, which puts the specials last; the row count is the
 * longest season's highest episode NUMBER rather than its episode count, so a skeleton
 * missing an episode in the middle leaves a hole instead of shifting everything below it
 * up by one.
 */
export function episodeGrid(
  seasons: readonly Season[],
  episodes: readonly Episode[],
  scores: readonly EpisodeScore[] | undefined,
  maxRows: number = GRID_MAX_ROWS,
): EpisodeGrid {
  const index = scoreIndex(scores);

  /*
    THE SPECIALS ARE NOT IN THE GRID, and this is the rule that keeps the shape readable.

    Measured in a browser 2026-09-05: Rick and Morty's season 0 holds 187 entries against
    a longest real season of 11, so the grid rendered 187 rows, 94% of them empty, and
    what a reader opened it for was several screens above the fold. Specials are shorts,
    recaps and behind-the-scenes clips -- they are not part of a show's shape, and the
    list view still carries them one season at a time where their length costs nothing.
  */
  const real = orderSeasons(seasons).filter((s) => s.number !== SPECIALS_SEASON);

  // Join once, per season, before anything needs to know how tall the grid is.
  const perSeason = real.map((season) => ({
    season: season.number,
    scored: episodesForSeason(episodes, season.number).map((e) => join(e, index)),
  }));

  const highest = Math.max(0, ...perSeason.flatMap((s) => s.scored.map((e) => e.number)));
  const shown = Math.min(highest, Math.max(0, maxRows));
  const rows = Array.from({ length: shown }, (_, i) => i + 1);

  const columns = perSeason.map(({ season, scored }): GridColumn => {
    const byNumber = new Map(scored.map((e) => [e.number, e]));
    // Averaged over the WHOLE season rather than the visible rows: the clamp is a
    // rendering limit, and an average that moved when a reader expanded the grid would be
    // two different answers to one question.
    const average = averageRating(scored);
    return {
      season,
      label: `S${season}`,
      average,
      averageBand: bandFor(average),
      cells: rows.map((n) => byNumber.get(n) ?? null),
    };
  });

  return { columns, rows, hiddenRows: highest - shown };
}

// --- the list ---------------------------------------------------------------

export interface SeasonList {
  season: number;
  average: number | null;
  averageBand: ScoreBand | null;
  episodes: ScoredEpisode[];
}

/** One season's rows, in episode order. The list view's whole model. */
export function seasonList(
  episodes: readonly Episode[],
  scores: readonly EpisodeScore[] | undefined,
  season: number,
): SeasonList {
  // Index built ONCE, outside the map -- inside it, every episode rebuilds the whole lookup.
  const index = scoreIndex(scores);
  const scored = episodesForSeason(episodes, season).map((e) => join(e, index));
  const average = averageRating(scored);
  return { season, average, averageBand: bandFor(average), episodes: scored };
}

// --- the timeline -----------------------------------------------------------

export interface TimelinePoint extends ScoredEpisode {
  /** Position along the x axis, 0-based, counting only episodes that HAVE a score. */
  x: number;
}

export interface TimelineBand {
  season: number;
  label: string;
  /** Half-open `[from, to)` in `x` units. */
  from: number;
  to: number;
}

export interface Timeline {
  points: TimelinePoint[];
  bands: TimelineBand[];
  min: number;
  max: number;
}

/**
 * Every rated episode in broadcast order, with the season boundaries beside them.
 *
 * UNRATED EPISODES ARE DROPPED HERE, and this is the one view where that is right. The
 * grid and the list are about a series' SHAPE, so a blank cell is information -- it says
 * "this exists and has no score". A line chart has no way to draw a gap that reads as
 * anything other than a dip, so plotting the unrated ones would invent a shape the data
 * does not have. The bands still count them, so an unaired season keeps its width.
 *
 * The y range is padded to whole points around the data rather than pinned to 0-10: a
 * series whose episodes all sit between 8.0 and 9.4 is unreadable on a full-height axis,
 * and the bands carry the absolute meaning that the axis would otherwise have to.
 */
export function timeline(
  seasons: readonly Season[],
  episodes: readonly Episode[],
  scores: readonly EpisodeScore[] | undefined,
): Timeline {
  const index = scoreIndex(scores);
  const points: TimelinePoint[] = [];
  const bands: TimelineBand[] = [];

  for (const season of orderSeasons(seasons)) {
    const from = points.length;
    for (const episode of episodesForSeason(episodes, season.number)) {
      const scored = join(episode, index);
      if (scored.rating === null) continue;
      points.push({ ...scored, x: points.length });
    }
    bands.push({ season: season.number, label: `S${season.number}`, from, to: points.length });
  }

  const values = points.map((p) => p.rating as number);
  const min = values.length ? Math.max(0, Math.floor(Math.min(...values)) - 1) : 0;
  const max = values.length ? Math.min(10, Math.ceil(Math.max(...values))) : 10;
  return { points, bands, min, max: max <= min ? min + 1 : max };
}

/**
 * A centred moving average over the plotted points, for the trendline.
 *
 * Centred rather than trailing because this is a finished series being read all at once,
 * not a live signal -- a trailing average would shift every feature to the right of the
 * episode that caused it. The window shrinks at the ends instead of the line stopping
 * short, so the trend spans the same width as the data.
 */
export function trendline(points: readonly TimelinePoint[], window = 5): number[] {
  const half = Math.floor(window / 2);
  return points.map((_, i) => {
    const lo = Math.max(0, i - half);
    const hi = Math.min(points.length - 1, i + half);
    let sum = 0;
    for (let j = lo; j <= hi; j++) sum += points[j].rating as number;
    return sum / (hi - lo + 1);
  });
}

/** `23,136 votes`, or nothing at all when we have no score to have counted them for. */
export function formatVotes(votes: number, locale = "en-GB"): string {
  return `${votes.toLocaleString(locale)} vote${votes === 1 ? "" : "s"}`;
}
