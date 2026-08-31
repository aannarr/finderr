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
