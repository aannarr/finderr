/**
 * TMDB's daily popularity, turned into IMPUTED VOTES for titles too new to have real ones.
 *
 * ## The problem
 *
 * `sacrifice` put Netflix's *Sacrifice* (tt32268992, Chris Evans and Anya Taylor-Joy,
 * streaming 2026-10-16) at #10 on 2026-09-24. It had 464 IMDb votes because it had not been
 * released, and `anticipationWeight` can only impute from the YEAR -- a flat 1,500 votes --
 * so a Netflix tentpole got the same lift as any unknown film dated this year. The popularity
 * term reads votes, and a title with no audience yet has no votes to read.
 *
 * ## The signal
 *
 * TMDB publishes a KEYLESS daily export of every film and series id with a `popularity`
 * field (`files.tmdb.org/p/exports/`, ~28 MB and ~5 MB gzipped). Popularity is TMDB's own
 * engagement measure -- page views, watchlist adds, votes, over the last day -- which is
 * exactly the pre-release signal the anticipation curve's doc says we could not buy. It
 * carries no IMDb id; `title_ids` (the Wikidata crosswalk) supplies one.
 *
 * ## The shape: QUANTILE MAPPING, GATED ON RECENCY
 *
 * A recent title at popularity percentile P is credited with the IMDb votes at percentile P,
 * both percentiles measured over ESTABLISHED titles (released at least three years ago, so
 * their votes have caught up with them). Measured 2026-09-24: popularity 49 maps to about
 * 314k votes, 10 to 16k, 5 to 4k. The result is `buzz_votes`, and ranking reads
 * `max(votes, buzz_votes)` -- nothing is added on top, so it cannot double-count, and it
 * stops mattering by itself once real votes overtake it.
 *
 * **THE RECENCY GATE IS THE WHOLE DIFFERENCE BETWEEN A WIN AND A LOSS**, measured offline over
 * the NAS click log and a generated set of 73 hot shared-name titles:
 *
 * | variant | canary | hot titles at #1 | click replay mean rank | sacrifice |
 * |---|---|---|---|---|
 * | baseline | 100% | 12 | 1.91 | #10 |
 * | quantile, every age | 100% | 49 | 2.26 (worse) | #1 |
 * | quantile, year >= now-1 | 100% | 51 | 1.88 (better) | #1 |
 *
 * **Re-measured with the REAL ENGINE once built**, M1 Max 2026-09-24, one index built from the
 * 2026-09-14 dumps and the 2026-09-23 export, against a clone of it with `buzz_votes` zeroed.
 * Unlike the offline run this includes the window order and the escalation gate:
 *
 * | | baseline | buzz |
 * |---|---|---|
 * | canary | 48/48 | 48/48 |
 * | hot titles at #1 / top 3 | 12 / 56 of 73 | 52 / 72 of 73 |
 * | `search:replay`, NAS log, 40 clicks | 0.97, 27 at #1 | 0.95, 28 at #1 |
 * | `sacrifice` | tt32268992 not in top 3 | #1, 65.5 against 60.7 |
 * | canary queries, mean / p95 | 7.60 / 28.46 ms | 7.59 / 28.37 ms |
 * | hot-title queries, mean | 10.93 ms | 4.26 ms |
 *
 * The last row is `weak()` no longer second-guessing a hit it believes: 21 of those 80 queries
 * escalated to the fuzzy tier before and 4 do now. Every other query costs what it did.
 *
 * Popularity on an OLD title is noise about the title: *Criminal Minds* (2005, popularity 322)
 * was imputed 1.7M votes and 2000s anime jumped descriptive queries. On a NEW one it is the
 * only audience measurement there is. So only titles dated `BUZZ_RECENT_YEARS` back or later
 * get a value at all.
 *
 * Also measured and rejected: CAST STAR POWER. Sacrifice's top star has 1.58M votes of
 * filmography; a 2000 Michael Madsen B-movie scores 1.32M on the same measure, and *Pawn
 * Sacrifice* has more big names. It cannot tell a tentpole from a direct-to-video thriller.
 *
 * ## Build time only
 *
 * The export is downloaded by the build JOB and read by a build STAGE, the same division the
 * crosswalks follow. Nothing here runs on a render path. The value changes once per nightly
 * build as popularity moves and is stable within a day, which is the stability "fair
 * ranking" asks for.
 */

import type { Database } from "bun:sqlite";
import { existsSync, renameSync, statSync, unlinkSync } from "node:fs";

/** Where TMDB publishes its daily id exports. Public, keyless, no rate limit stated. */
export const POPULARITY_EXPORT_BASE = "https://files.tmdb.org/p/exports";

/**
 * One export: TMDB's filename stem for it, and where the copy lives beside the dumps.
 *
 * `series` decides which TMDB id space a title is matched in, and it is the same split
 * `loadCrosswalk` makes when it picks P4947 or P4983 -- a series looked up among films finds
 * somebody else's title.
 */
export interface PopularityExport {
  stem: string;
  file: string;
  series: boolean;
}

export const POPULARITY_EXPORTS: readonly PopularityExport[] = [
  { stem: "movie_ids", file: "tmdb-movie-popularity.json.gz", series: false },
  { stem: "tv_series_ids", file: "tmdb-tv-popularity.json.gz", series: true },
];

/** The `title.kind` values matched against the SERIES export; everything else is a film. */
export const SERIES_KINDS = ["tvSeries", "tvMiniSeries"] as const;

/**
 * How many years back a title may be dated and still be imputed. `1`: this year and last.
 *
 * The measured winner (`q-recent1`). Two years was measured beside it: the same 51 of 73 hot
 * titles first, and a WORSE click replay, 1.98 against 1.88 -- the extra year buys nothing on
 * the case this is for and starts reordering older queries somebody actually clicked.
 */
export const BUZZ_RECENT_YEARS = 1;

/**
 * How old a title must be before its votes count as the truth the mapping is measured against.
 *
 * Three years, so a title's IMDb votes have had time to catch up with its audience. A younger
 * reference set would map a hot title onto the votes of other titles that are ALSO still
 * accruing them, and understate every imputation.
 */
export const ESTABLISHED_AGE_YEARS = 3;

/**
 * Below this many established titles the mapping is not built at all.
 *
 * A quantile map over a handful of points is a lookup table of accidents. The real index has
 * hundreds of thousands; a fixture or a build without the crosswalk has almost none, and the
 * right answer there is "no imputation" rather than a confident wrong one.
 */
export const MIN_ESTABLISHED = 1_000;

/**
 * How long a downloaded export is reused before trying for a newer one.
 *
 * TMDB publishes once a day, around 07:00-08:00 UTC, and the build runs at 09:00 UTC. Twenty
 * hours means each daily build fetches exactly once and a hand-run rebuild an hour later reuses
 * the file rather than downloading 33 MB again for the same numbers.
 */
export const POPULARITY_MAX_AGE_MS = 20 * 60 * 60 * 1000;

/** The export's own date, kept beside the file so the build can say which day it ranked on. */
export const popularityDatePath = (path: string): string => `${path}.date`;

/** `movie_ids_09_23_2026.json.gz` for 2026-09-23 -- TMDB's MM_DD_YYYY, in UTC. */
export function exportUrl(stem: string, day: Date): string {
  const mm = String(day.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(day.getUTCDate()).padStart(2, "0");
  return `${POPULARITY_EXPORT_BASE}/${stem}_${mm}_${dd}_${day.getUTCFullYear()}.json.gz`;
}

/**
 * Download one export into `dumpDir`, unless the copy there is recent enough.
 *
 * Tries TODAY, then the two days before: today's file does not exist until TMDB publishes it
 * (the bucket answers 403, not 404, for a file that is not there yet), and a missed day upstream
 * should cost a day of freshness rather than the signal.
 *
 * A FAILED DOWNLOAD LEAVES THE OLD FILE ALONE, the rule `fetchCrosswalk` follows: yesterday's
 * popularity is a far better ranking signal than none. Written to a `.part` and renamed, so a
 * truncated body is never mistaken for the export.
 *
 * Returns whether a usable file is on disk afterwards.
 */
export async function fetchPopularityExport(
  source: PopularityExport,
  dumpDir: string,
  opts: {
    now?: () => number;
    maxAgeMs?: number;
    fetchImpl?: typeof fetch;
    log?: (m: string) => void;
  } = {},
): Promise<boolean> {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const doFetch = opts.fetchImpl ?? fetch;
  const path = `${dumpDir}/${source.file}`;
  const cached = existsSync(path) ? statSync(path) : null;

  // Clamped at zero: a file written this millisecond can carry an mtime a fraction AHEAD of
  // `Date.now()`, and a negative age would count as fresh under any limit, zero included.
  if (cached && Math.max(0, now() - cached.mtimeMs) < (opts.maxAgeMs ?? POPULARITY_MAX_AGE_MS)) {
    log(`popularity ${source.stem}: reusing ${(cached.size / 1e6).toFixed(1)} MB already on disk`);
    return true;
  }

  const DAY = 24 * 60 * 60 * 1000;
  for (let back = 0; back < 3; back++) {
    const day = new Date(now() - back * DAY);
    const url = exportUrl(source.stem, day);
    try {
      const res = await doFetch(url, { headers: { "User-Agent": "finderr (self-hosted media request UI)" } });
      if (!res.ok) continue;
      const bytes = new Uint8Array(await res.arrayBuffer());
      const part = `${path}.part`;
      await Bun.write(part, bytes);
      renameSync(part, path);
      await Bun.write(popularityDatePath(path), day.toISOString().slice(0, 10));
      log(
        `popularity ${source.stem}: downloaded ${(bytes.length / 1e6).toFixed(1)} MB for ${day.toISOString().slice(0, 10)}`,
      );
      return true;
    } catch (err) {
      log(
        `popularity ${source.stem}: ${url.slice(url.lastIndexOf("/") + 1)} failed (${(err as Error).message})`,
      );
      if (existsSync(`${path}.part`)) unlinkSync(`${path}.part`);
    }
  }
  log(
    cached
      ? `popularity ${source.stem}: no export in the last three days -- keeping the copy on disk`
      : `popularity ${source.stem}: no export in the last three days -- recent titles rank on votes and year alone`,
  );
  return cached !== null;
}

/** One row of an export: TMDB's id and its popularity. */
export interface PopularityRow {
  id: number;
  popularity: number;
}

/**
 * One line of an export, or `null` for anything that is not a usable row.
 *
 * DROPPED rather than repaired, the crosswalk rule: a half-read line attributes a popularity to
 * the wrong id, and that is a wrong ranking with nothing on screen to say why. A popularity that
 * is not a finite non-negative number is dropped for the same reason.
 */
export function parsePopularityLine(line: string): PopularityRow | null {
  if (line.length === 0) return null;
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  const { id, popularity } = o as { id?: unknown; popularity?: unknown };
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) return null;
  if (typeof popularity !== "number" || !Number.isFinite(popularity) || popularity < 0) return null;
  return { id, popularity };
}

/**
 * Every row of a gzipped export, streamed.
 *
 * STREAMED rather than read whole: the film export decompresses to over 100 MB of text, and the
 * build runs inside the container's memory cap beside a ratings map that is already the largest
 * thing it holds.
 */
export async function* readPopularityExport(path: string): AsyncGenerator<PopularityRow> {
  const stream = Bun.file(path).stream().pipeThrough(new DecompressionStream("gzip"));
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    let start = 0;
    let nl = buffer.indexOf("\n", start);
    while (nl !== -1) {
      const row = parsePopularityLine(buffer.slice(start, nl));
      if (row) yield row;
      start = nl + 1;
      nl = buffer.indexOf("\n", start);
    }
    buffer = buffer.slice(start);
  }
  buffer += decoder.decode();
  const last = parsePopularityLine(buffer.trim());
  if (last) yield last;
}

/**
 * The quantile map: popularity percentile over the reference set -> votes at that percentile.
 *
 * Rank to rank rather than a regression, and that was measured: a median-per-band curve is
 * dragged toward the middle by how noisy popularity is, and it put 26 of the 73 hot titles
 * first against quantile's 49, and *Sacrifice* second rather than first.
 *
 * `null` below `minSample`, see `MIN_ESTABLISHED`.
 */
export function quantileImputer(
  reference: readonly { popularity: number; votes: number }[],
  minSample = MIN_ESTABLISHED,
): ((popularity: number) => number) | null {
  if (reference.length < minSample) return null;
  const pops = Float64Array.from(reference, (r) => r.popularity).sort();
  const votes = Float64Array.from(reference, (r) => r.votes).sort();
  const n = pops.length;
  return (popularity) => {
    // Lower bound: the share of the reference set strictly less popular than this title.
    // Strictly, so a tie at the crowded low end maps to the LOW end of its votes band.
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pops[mid] < popularity) lo = mid + 1;
      else hi = mid;
    }
    // The same index into the sorted votes: percentile in, percentile out.
    return votes[Math.min(n - 1, lo)];
  };
}

/** The earliest year a title may carry and still be imputed. Moves on 1 January. */
export function buzzFromYear(now: Date = new Date()): number {
  return now.getUTCFullYear() - BUZZ_RECENT_YEARS;
}

/** A stream from `readPopularityExport`, or a plain list in a test. */
export type PopularityRows = Iterable<PopularityRow> | AsyncIterable<PopularityRow>;

export interface BuzzStats {
  /** Titles holding a TMDB popularity at all. */
  matched: number;
  /** Established titles the mapping was measured over. */
  reference: number;
  /** Recent titles that got a `buzz_votes`. */
  imputed: number;
}

/**
 * Fill `title.buzz_votes` from the popularity rows. MUST RUN AFTER the crosswalk stage.
 *
 * The rows are parked in a KEYED temp table and joined from `title_ids`, so every lookup is a
 * primary-key seek -- the shape `loadOrigin` paid seventeen minutes to learn. The mapping itself
 * is two sorted arrays in memory: a few hundred thousand numbers.
 *
 * Only a title that would actually be LIFTED is written, so a recent film already past its
 * imputation keeps `buzz_votes = 0` and the column reads as what it is: the titles whose rank
 * the popularity is currently deciding.
 */
export async function loadBuzz(
  db: Database,
  rows: { movies: PopularityRows; series: PopularityRows },
  opts: { now?: Date; minSample?: number } = {},
): Promise<BuzzStats> {
  const now = opts.now ?? new Date();
  db.run(
    "create temporary table pop_in (series integer not null, id integer not null, popularity real not null, primary key (series, id)) without rowid",
  );
  const ins = db.prepare("insert or replace into pop_in values (?, ?, ?)");
  // A manual transaction rather than `db.transaction`, which cannot span an await -- and the
  // rows arrive as a stream so the 100 MB of decompressed text is never held at once.
  db.run("begin");
  for await (const r of rows.movies) ins.run(0, r.id, r.popularity);
  for await (const r of rows.series) ins.run(1, r.id, r.popularity);
  db.run("commit");

  const kinds = SERIES_KINDS.map((k) => `'${k}'`).join(", ");
  const matched = db
    .query(
      `select t.rowid_ rowid, t.year, t.votes, p.popularity
         from title_ids i
         join title t on t.tconst = i.tconst
         join pop_in p on p.series = (t.kind in (${kinds})) and p.id = i.tmdb
        where i.tmdb is not null`,
    )
    .all() as { rowid: number; year: number | null; votes: number; popularity: number }[];
  db.run("drop table pop_in");

  const year = now.getUTCFullYear();
  const reference = matched.filter(
    (r) => r.year !== null && r.year <= year - ESTABLISHED_AGE_YEARS && r.votes > 0,
  );
  const impute = quantileImputer(reference, opts.minSample);
  if (!impute) return { matched: matched.length, reference: reference.length, imputed: 0 };

  const from = buzzFromYear(now);
  const set = db.prepare("update title set buzz_votes = ? where rowid_ = ?");
  let imputed = 0;
  db.transaction(() => {
    for (const r of matched) {
      if (r.year === null || r.year < from) continue;
      const v = impute(r.popularity);
      if (v <= r.votes) continue;
      set.run(v, r.rowid);
      imputed++;
    }
  })();
  return { matched: matched.length, reference: reference.length, imputed };
}
