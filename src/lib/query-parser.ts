/**
 * Turns what a human typed into structured intent.
 *
 * People do not type clean titles. They type "the matrix 1999", "stranger things s3",
 * "bridgerton 1080p x265" (pasted from a release name), "silo tv series". Every one of
 * those signals should narrow the search instead of polluting the text match.
 *
 * Extracted signals are REMOVED from the text and applied as scoring rather than
 * filtering -- so a user who misremembers the year gets a demoted-but-present result
 * instead of an empty page.
 */

export type KindHint = "movie" | "tvSeries";

export interface ParsedQuery {
  /** What is left to actually match on. */
  text: string;
  /** The raw input, unchanged. */
  raw: string;
  year?: number;
  /** e.g. 1990 for "the 90s" */
  decade?: number;
  kind?: KindHint;
  season?: number;
  episode?: number;
  /** Release-name noise that was stripped, for showing "we ignored: 1080p, x265". */
  stripped: string[];
}

/** Scene-release noise. People paste these constantly. */
const RELEASE_JUNK =
  /\b(?:1080p|720p|2160p|480p|4k|uhd|hdr|hdr10|dolby[ .]?vision|bluray|blu-ray|brrip|bdrip|webrip|web-?dl|hdtv|dvdrip|x264|x265|h ?264|h ?265|hevc|avc|aac\d?(?:\.\d)?|ac3|dts(?:-hd)?|truehd|atmos|ddp?\d(?:\.\d)?|remux|proper|repack|internal|limited|extended|unrated|imax|dual[ .]?audio|multi|subbed|dubbed|yify|yts|rarbg)\b/gi;

const TYPE_WORDS =
  /\b(tv[ -]?series|tv[ -]?show|miniseries|mini[ -]?series|series|show|season|movie|film)\b/gi;

const SEASON_EPISODE = /\bs(?:eason)?[ .]?(\d{1,2})(?:[ .]?[ex](?:pisode)?[ .]?(\d{1,3}))?\b/i;
const DECADE = /\b((?:19|20)\d0)'?s\b/i;

export function parseQuery(raw: string): ParsedQuery {
  const stripped: string[] = [];
  let q = ` ${raw.trim()} `;

  // 1. release junk -- always noise, never part of a title
  q = q.replace(RELEASE_JUNK, (m) => {
    stripped.push(m);
    return " ";
  });

  const out: ParsedQuery = { text: "", raw, stripped };

  // 2. season / episode markers. These also imply the thing is a series.
  const se = q.match(SEASON_EPISODE);
  if (se) {
    out.season = Number.parseInt(se[1], 10);
    if (se[2]) out.episode = Number.parseInt(se[2], 10);
    out.kind = "tvSeries";
    q = q.replace(se[0], " ");
  }

  // 3. decade
  const dec = q.match(DECADE);
  if (dec) {
    out.decade = Number.parseInt(dec[1], 10);
    q = q.replace(dec[0], " ");
  }

  /**
   * 4. Explicit year.
   *
   * Two rules do all the work here, and no allowlist of "titles that are years" is
   * needed:
   *
   *  - A number beyond `maxYear` is not a year anyone means. That alone protects
   *    "Blade Runner 2049" -- 2049 is decades away, so it stays part of the title.
   *  - A number is only a YEAR if something remains to search on after removing it.
   *    "1917", "2012" and "1984" typed alone are titles; "Dune (1984)" is not.
   *
   * The LAST plausible candidate wins, so "1883 2022" reads as the show 1883 in 2022.
   */
  const maxYear = new Date().getFullYear() + 3;
  const candidates = [...q.matchAll(/\(?\b(1[89]\d{2}|20\d{2})\b\)?/g)].filter((m) => {
    const y = Number.parseInt(m[1], 10);
    return y >= 1900 && y <= maxYear;
  });
  if (candidates.length > 0) {
    const chosen = candidates[candidates.length - 1];
    const remainder = q.replace(chosen[0], " ").replace(/\s+/g, " ").trim();
    if (remainder.length > 0) {
      out.year = Number.parseInt(chosen[1], 10);
      q = q.replace(chosen[0], " ");
    }
  }

  // 5. explicit type words
  const types = [...q.matchAll(TYPE_WORDS)].map((m) => m[1].toLowerCase());
  if (types.length > 0) {
    if (types.some((t) => /series|show|season/.test(t))) out.kind = "tvSeries";
    else if (types.some((t) => /movie|film/.test(t))) out.kind = "movie";
    q = q.replace(TYPE_WORDS, " ");
  }

  out.text = q.replace(/\s+/g, " ").trim();
  // If stripping left us with nothing, the "noise" was the query. Fall back.
  if (out.text.length === 0) out.text = raw.trim();
  return out;
}

/**
 * Year proximity as a score, not a filter.
 * A user who says 1999 and means 1999 gets a strong push; one who is a year out still
 * finds the film; one who is a decade out sees it demoted but not deleted.
 */
export function yearScore(year: number | null, want?: number, decade?: number): number {
  if (year === null || year === undefined) return want || decade ? -4 : 0;
  if (want) {
    const d = Math.abs(year - want);
    if (d === 0) return 9;
    if (d === 1) return 6;
    if (d === 2) return 3;
    if (d <= 5) return 0.5;
    return -6;
  }
  if (decade) return year >= decade && year <= decade + 9 ? 6 : -5;
  return 0;
}

export function kindScore(kind: string, want?: KindHint): number {
  if (!want) return 0;
  if (want === "tvSeries") return kind === "tvSeries" || kind === "tvMiniSeries" ? 4 : -5;
  return kind === "movie" || kind === "tvMovie" ? 4 : -5;
}

/** Newer titles are what people usually mean, all else equal. Deliberately small. */
export function recencyScore(year: number | null): number {
  if (year === null || year === undefined) return 0;
  if (year >= 2015) return 1.2;
  if (year >= 2000) return 0.4;
  return 0;
}

/**
 * How near a title is to coming out, as a weight in `[0, 1]`.
 *
 * ## The problem it solves
 *
 * An unreleased title has zero votes BY CONSTRUCTION, not because nobody wanted it. The
 * popularity term in `rank()` spans 24.7 points and reads that zero as obscurity, so a
 * film or series releasing next year is buried under anything with an audience. aannarr,
 * 2026-09-05: a reader is *more* likely to be looking for the new thing, not less.
 *
 * ## Why it is a WEIGHT and not a bonus
 *
 * It multiplies a shrinkage toward an imputed vote count rather than adding points of its
 * own -- the empirical-Bayes shape used for item cold start in product search (Han et al.,
 * CIKM 2022), and the same move IMDb's own weighted rating makes when it blends a sparse
 * rating toward the corpus mean. An additive bonus would stack on titles that do not need
 * it and would have no natural ceiling; this one is bounded by construction and
 * self-extinguishes as real votes arrive. `rank()` owns the blend; this owns the clock.
 *
 * ## WHOLE YEARS, because that is all the index has
 *
 * `title.year` is an integer and there is no finer release date anywhere in the corpus. So
 * the distance is measured in whole years and the curve steps on 1 January rather than
 * drifting daily. That is the better trade here for a reason beyond simplicity: a weight
 * that moved every day would make an identical query return a slightly different order
 * tomorrow, and "fair ranking" in this product means stable.
 *
 * The corollary is the honest reading of a year-only stamp: **a title stamped Y is not
 * known to have been released until Y is over.** A 2026 film read in September 2026 may
 * come out in November, and nothing in the data can say otherwise -- so the current year
 * counts as unreleased.
 *
 * ## The curve, and why it is ASYMMETRIC
 *
 * Two half-Gaussians in Elasticsearch's `function_score` form -- `exp(-d^2 / 2*sigma^2)`
 * with `sigma = scale / sqrt(2*ln 2)`, so the weight is exactly 0.5 one `scale` past the
 * offset. The asymmetry is the whole design and it is about information, not taste:
 *
 * | year - now | weight | meaning |
 * |---|---|---|
 * | 0, +1 | 1.00 | out this year or next: a zero says nothing at all |
 * | +2 | 0.50 | announced and dated, but a way off |
 * | +3 | 0.06 | speculative |
 * | +5 | 0.00 | a 2031 slate entry gets nothing, as asked |
 * | -1 | 0.06 | out for a year with no votes: that IS evidence now |
 * | -2 and older | 0.00 | ordinary obscurity, judged on its votes like everything else |
 *
 *   - **Before release** a zero carries no information, so the plateau runs a full year out
 *     and the taper is slow.
 *   - **After release** a zero starts to BE evidence -- a title out for a year with nobody
 *     rating it really is obscure -- so it collapses in half the distance.
 *
 * Note that no production system publishes a date-based anticipation curve. TMDB, Trakt and
 * Letterboxd all solve this by substituting a pre-release ENGAGEMENT signal -- watchlist
 * adds, list counts, page views -- which we do not have and cannot get without a new source.
 * So this is an explicit proxy for a signal we cannot buy, and it is sized to be a tiebreak
 * against obscurity rather than evidence of quality.
 *
 * Kind-blind on purpose: a series announced for next year is as anticipated as a film, and
 * `year` is a first-air year, so a long-running show is never in the future here.
 */
export function anticipationWeight(year: number | null, now: Date = new Date()): number {
  if (year === null || year === undefined) return 0;

  const away = year - now.getUTCFullYear();
  const [offset, scale] =
    away >= 0 ? [FUTURE_PLATEAU_YEARS, FUTURE_SCALE_YEARS] : [PAST_GRACE_YEARS, PAST_SCALE_YEARS];
  const d = Math.max(0, Math.abs(away) - offset);
  if (d === 0) return 1;

  // sigma from Elasticsearch's own constant for decay 0.5 at one scale: sigma^2 =
  // -scale^2 / (2 ln 0.5), i.e. sigma = scale / sqrt(2 ln 2).
  const sigma = scale / Math.sqrt(2 * Math.LN2);
  return Math.exp(-(d * d) / (2 * sigma * sigma));
}

/**
 * Full weight for anything out this year or next.
 *
 * `0` is not a rounding allowance, it is the current year being genuinely unresolvable from
 * a year stamp -- see the whole-years note above. `1` is the "next year" aannarr asked for.
 */
const FUTURE_PLATEAU_YEARS = 1;
/** Half weight one scale past the plateau: +2 is 0.5, +3 is 0.06, +5 is nothing. */
const FUTURE_SCALE_YEARS = 1;
/** No grace behind: the current year is already covered by the plateau above. */
const PAST_GRACE_YEARS = 0;
/** Behind, a zero becomes evidence fast -- half the distance forward. */
const PAST_SCALE_YEARS = 0.5;
