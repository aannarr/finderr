/**
 * The id crosswalk: `tconst -> TMDB id, TheTVDB id`, bought in bulk instead of one call
 * at a time.
 *
 * WHY THIS EXISTS, measured 2026-09-01 against a cold data directory. A first view of a
 * title is not slow because any upstream is slow -- every call runs 270-450 ms -- it is
 * slow because the calls are CHAINED, and the first link in two of the three chains is a
 * pure id lookup:
 *
 *   tmdb, film     `/find/tt…`      -> `/movie/{id}/watch/providers`
 *   tmdb, series   `/find/tt…`      -> `/tv/{id}/keywords` -> `…/watch/providers`
 *   skyhook        `/search/en?term` -> `/shows/en/{tvdbId}`
 *
 * `api.themoviedb.org/3/find/*` was the single most expensive endpoint in the whole
 * measurement, and it answers a question a 12 MB download already knows. Removing it takes
 * a round trip off every cold film and, with the pacer's 250 ms gap between two calls to
 * one host, rather more than one off a cold series.
 *
 * WIKIDATA, THROUGH QLEVER, AND WHY NOT THE OBVIOUS ALTERNATIVES:
 *
 *   - **Wikidata's own query service** cannot answer this. It caps at 60 seconds and
 *     refuses a result set this size; its own documentation says to use a dump instead.
 *     QLever is a Wikidata mirror built for exactly that (Freiburg, Apache-2.0) and it
 *     returns the whole crosswalk in about five seconds.
 *   - **A full Wikidata dump** is the same data at ~100 GB. Not on a Synology.
 *   - **MovieLens `links.csv`** maps imdb -> tmdb for films and is the answer everyone
 *     online gives. `files.grouplens.org` serves a broken certificate chain, and its ~87k
 *     films are the popular ones Wikidata already has. Rejected on both counts.
 *   - **TVmaze's paged show index** is a second free source for series (89,412 shows).
 *     Measured: it lifts series tvdb coverage from 90.2% to 94.5% at the browse vote
 *     floor, and 97.1% to 98.2% above ten thousand votes. Rejected FOR NOW -- it is a
 *     358-request walk of somebody else's API for four points on a fallback that already
 *     works, and one bulk source is one thing to keep honest. The numbers are here so the
 *     decision can be re-taken rather than re-derived.
 *
 * COVERAGE IS PARTIAL AND THAT IS FINE, because the API call is still there. Measured
 * against the real 1.27M-row index on 2026-09-01:
 *
 *   films,  votes >= 1000: tmdb 95.0%   votes >= 10000: 99.7%
 *   series, votes >= 1000: tmdb 91.8%, tvdb 90.2%   >= 10000: 98.2% / 97.1%
 *
 * The tail is obscure titles, which is the right way round: what the crosswalk misses,
 * a provider looks up exactly as it did before and parks in its own `kv`.
 */

import type { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";

/**
 * A Wikidata mirror that can answer a query over the whole graph.
 *
 * Not `query.wikidata.org`: that endpoint times out at 60 seconds and this query returns
 * over half a million rows.
 */
export const CROSSWALK_ENDPOINT = "https://qlever.dev/api/wikidata";

/**
 * Every item carrying an IMDb id, with whichever of the three other ids it has.
 *
 * `OPTIONAL` on each rather than a join per id space, so one query returns a row for a
 * title that has only a TVDB id as well as one that has all three. The `tt` filter drops
 * `nm`/`co`/`ev` -- P345 is the id space for people and companies too.
 */
export const CROSSWALK_QUERY = `PREFIX wdt: <http://www.wikidata.org/prop/direct/>
SELECT ?imdb ?tmdbMovie ?tmdbTv ?tvdb WHERE {
  ?s wdt:P345 ?imdb .
  OPTIONAL { ?s wdt:P4947 ?tmdbMovie }
  OPTIONAL { ?s wdt:P4983 ?tmdbTv }
  OPTIONAL { ?s wdt:P4835 ?tvdb }
  FILTER(STRSTARTS(?imdb, "tt"))
}`;

/** Where the downloaded crosswalk lives, under the dump directory beside the IMDb ones. */
export const CROSSWALK_FILE = "wikidata-ids.csv";

/**
 * How long a downloaded crosswalk is reused before being fetched again.
 *
 * A week rather than the daily cadence the IMDb dumps run on, because an id is a fact that
 * does not move: the only thing a refresh buys is coverage of titles that got a Wikidata
 * entry since, and those cost one `/find` call each in the meantime.
 */
export const CROSSWALK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** One title's ids, as the index holds them. Absent rather than null when unknown. */
export interface TitleIds {
  tmdb?: number;
  tvdb?: number;
}

export const CROSSWALK_SCHEMA = `
-- Bulk-loaded ids, so the render path never buys a /find or a /search.
--
-- ONE tmdb column, not two: a title in this index is either a film or a series, so the
-- kind decides which of Wikidata's two TMDB properties applies and storing both would be
-- a column that is null for every row it is not about.
create table title_ids (
  tconst text primary key,
  tmdb   integer,
  tvdb   integer
);
`;

export interface CrosswalkRow {
  imdb: string;
  tmdbMovie: number | null;
  tmdbTv: number | null;
  tvdb: number | null;
}

/**
 * Parse the CSV QLever returns.
 *
 * Hand-parsed rather than through a CSV library because the shape is known and narrow:
 * four columns, every value either an id or empty. A field containing a comma or a quote
 * would be a malformed id, so the row is DROPPED rather than repaired -- a crosswalk is
 * only useful if every entry in it is right, and a half-parsed id sends a provider to
 * somebody else's film.
 */
export function parseCrosswalkCsv(text: string): CrosswalkRow[] {
  const out: CrosswalkRow[] = [];
  const lines = text.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const parts = line.split(",");
    if (parts.length !== 4) continue;
    const [imdb, tmdbMovie, tmdbTv, tvdb] = parts;
    if (!imdb || !/^tt\d+$/.test(imdb)) continue;
    out.push({
      imdb,
      tmdbMovie: idOrNull(tmdbMovie),
      tmdbTv: idOrNull(tmdbTv),
      tvdb: idOrNull(tvdb),
    });
  }
  return out;
}

/** A positive integer, or null. Anything else is a value we will not act on. */
function idOrNull(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Download the crosswalk to `path`, unless what is there is recent enough.
 *
 * CALLED BY THE BUILD JOB, never by `buildIndex`, the same division the IMDb dumps follow:
 * the job fetches, the builder reads whatever is on disk. A build stage that fetched would
 * put the network on the path of every test that builds an index.
 *
 * A FAILED DOWNLOAD LEAVES THE OLD FILE ALONE and reports false; the builder then loads
 * the stale copy, which is a fine answer because an id does not move. The only cost of
 * staleness is that a title added to Wikidata this week pays a `/find` call, exactly as it
 * did before any of this existed.
 *
 * Returns whether a usable file is on disk afterwards.
 */
export async function fetchCrosswalk(
  path: string,
  opts: {
    now?: () => number;
    maxAgeMs?: number;
    fetchImpl?: typeof fetch;
    log?: (m: string) => void;
  } = {},
): Promise<boolean> {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const maxAge = opts.maxAgeMs ?? CROSSWALK_MAX_AGE_MS;
  const doFetch = opts.fetchImpl ?? fetch;

  const cached = existsSync(path) ? statSync(path) : null;
  if (cached && now() - cached.mtimeMs < maxAge) {
    log(`crosswalk: reusing ${(cached.size / 1e6).toFixed(1)} MB already on disk`);
    return true;
  }

  try {
    const url = `${CROSSWALK_ENDPOINT}?query=${encodeURIComponent(CROSSWALK_QUERY)}`;
    const res = await doFetch(url, {
      headers: { Accept: "text/csv", "User-Agent": "finderr (self-hosted media request UI)" },
    });
    if (!res.ok) throw new Error(`answered ${res.status}`);
    const text = await res.text();
    // Written only after the whole body has arrived: a half-written CSV would parse into a
    // crosswalk that is missing its tail, which is worse than not having one.
    await Bun.write(path, text);
    log(`crosswalk: downloaded ${(text.length / 1e6).toFixed(1)} MB`);
    return true;
  } catch (err) {
    const why = (err as Error).message;
    log(
      cached
        ? `crosswalk: download failed (${why}) -- keeping the copy on disk`
        : `crosswalk: download failed (${why}) -- providers will resolve their own ids`,
    );
    return cached !== null;
  }
}

/**
 * Write the parsed rows into `title_ids`, keeping only titles this index actually holds.
 *
 * Restricted to our own titles because the crosswalk covers every IMDb id Wikidata knows,
 * including people and the ten title types we do not index. Two thirds of it is about
 * something this product will never render.
 *
 * THE KIND DECIDES WHICH TMDB ID APPLIES. Wikidata has separate properties for a film and
 * a series, and picking the wrong one is worse than picking neither: a provider handed a
 * film id for a series asks `/tv/{filmId}` and gets somebody else's show, or a 404 that
 * looks like "TMDB has never heard of this". The join below reads `title.kind`, which is
 * the same source `entityKindFor` collapses, so the two cannot disagree.
 *
 * Returns how many rows were kept.
 */
export function loadCrosswalk(db: Database, rows: CrosswalkRow[]): number {
  db.run(
    "create temporary table cw_in (imdb text primary key, tmdb_movie integer, tmdb_tv integer, tvdb integer)",
  );
  const insert = db.prepare("insert or replace into cw_in values (?,?,?,?)");
  db.transaction(() => {
    for (const r of rows) insert.run(r.imdb, r.tmdbMovie, r.tmdbTv, r.tvdb);
  })();

  db.run(`
    insert into title_ids (tconst, tmdb, tvdb)
    select t.tconst,
           case when t.kind in ('tvSeries', 'tvMiniSeries') then c.tmdb_tv else c.tmdb_movie end,
           c.tvdb
      from title t join cw_in c on c.imdb = t.tconst
  `);
  // A row with neither id is a row that answers no question, and it would still cost a
  // page in the primary key on every lookup that misses.
  db.run("delete from title_ids where tmdb is null and tvdb is null");
  db.run("drop table cw_in");

  return (db.query("select count(*) c from title_ids").get() as { c: number }).c;
}

/** Read one title's ids. Absent keys rather than nulls -- see `TitleIds`. */
export function titleIds(db: Database, tconst: string): TitleIds {
  const row = db.query("select tmdb, tvdb from title_ids where tconst = ?").get(tconst) as
    | { tmdb: number | null; tvdb: number | null }
    | undefined;
  if (!row) return {};
  const out: TitleIds = {};
  if (row.tmdb !== null) out.tmdb = row.tmdb;
  if (row.tvdb !== null) out.tvdb = row.tvdb;
  return out;
}
