/**
 * The id crosswalks: `tconst -> TMDB id, TheTVDB id` and `TMDB person id -> nconst`, both
 * bought in bulk instead of one call at a time.
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
 *
 * THE PERSON CROSSWALK IS THE SAME TRICK ON THE OTHER AXIS, and it exists for a different
 * reason: not to save a call, but because there was no call worth making. A cast list
 * identifies people by TMDB id and the index speaks IMDb nconsts, so before this the only
 * way to link a cast name to a person page was to MATCH THE NAME -- which is wrong 1.7% of
 * the time and cannot be made right, because IMDb genuinely holds two Peter Mileses and no
 * string can separate them. `person_external` resolves identity from an id or not at all.
 */

import type { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";

/**
 * A Wikidata mirror that can answer a query over the whole graph.
 *
 * Not `query.wikidata.org`: that endpoint times out at 60 seconds and these queries return
 * hundreds of thousands of rows.
 */
export const CROSSWALK_ENDPOINT = "https://qlever.dev/api/wikidata";

/**
 * One bulk crosswalk: what to ask Wikidata for, and where the answer is kept.
 *
 * A record rather than a pair of constants per crosswalk, so `fetchCrosswalk` and the build
 * job iterate instead of growing a branch each -- a third crosswalk is one entry in
 * `CROSSWALK_SOURCES` and no new code anywhere.
 */
export interface CrosswalkSource {
  /** Filename under the dump directory, beside the IMDb dumps. */
  file: string;
  /** The SPARQL that produces it. */
  query: string;
  /** What it is, for the one log line a download writes. */
  label: string;
}

/**
 * Every title carrying an IMDb id, with whichever of the three other ids it has.
 *
 * `OPTIONAL` on each rather than a join per id space, so one query returns a row for a
 * title that has only a TVDB id as well as one that has all three. The `tt` filter drops
 * `nm`/`co`/`ev` -- P345 is the id space for people and companies too.
 */
export const TITLE_CROSSWALK: CrosswalkSource = {
  file: "wikidata-ids.csv",
  label: "title ids",
  query: `PREFIX wdt: <http://www.wikidata.org/prop/direct/>
SELECT ?imdb ?tmdbMovie ?tmdbTv ?tvdb WHERE {
  ?s wdt:P345 ?imdb .
  OPTIONAL { ?s wdt:P4947 ?tmdbMovie }
  OPTIONAL { ?s wdt:P4983 ?tmdbTv }
  OPTIONAL { ?s wdt:P4835 ?tvdb }
  FILTER(STRSTARTS(?imdb, "tt"))
}`,
};

/**
 * Every PERSON carrying both an IMDb id (P345) and a TMDb person id (P4985).
 *
 * No `OPTIONAL` here, unlike the title query: a row with only one of the two answers no
 * question, and the whole point of this file is the pairing. The `nm` filter is the same
 * P345-is-shared guard the title query's `tt` filter is.
 *
 * Measured 2026-09-03: 346,293 pairs, 6.1 MB, 3.3s. It is CC0, so we may redistribute it --
 * nobody else publishes a clean TMDB-to-IMDb person mapping as a file.
 */
export const PERSON_CROSSWALK: CrosswalkSource = {
  file: "wikidata-people.csv",
  label: "person ids",
  query: `PREFIX wdt: <http://www.wikidata.org/prop/direct/>
SELECT ?imdb ?tmdb WHERE {
  ?s wdt:P345 ?imdb .
  ?s wdt:P4985 ?tmdb .
  FILTER(STRSTARTS(?imdb, "nm"))
}`,
};

/** Every crosswalk the build job downloads, in the order it downloads them. */
export const CROSSWALK_SOURCES: readonly CrosswalkSource[] = [TITLE_CROSSWALK, PERSON_CROSSWALK];

/**
 * How long a downloaded crosswalk is reused before being fetched again.
 *
 * A week rather than the daily cadence the IMDb dumps run on, because an id is a fact that
 * does not move: the only thing a refresh buys is coverage of titles and people that got a
 * Wikidata entry since, and those cost one `/find` call each -- or one unlinked name -- in
 * the meantime.
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
 * Download one crosswalk into `dumpDir`, unless what is there is recent enough.
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
  source: CrosswalkSource,
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
  const maxAge = opts.maxAgeMs ?? CROSSWALK_MAX_AGE_MS;
  const doFetch = opts.fetchImpl ?? fetch;
  const path = `${dumpDir}/${source.file}`;

  const cached = existsSync(path) ? statSync(path) : null;
  if (cached && now() - cached.mtimeMs < maxAge) {
    log(`crosswalk ${source.label}: reusing ${(cached.size / 1e6).toFixed(1)} MB already on disk`);
    return true;
  }

  try {
    const url = `${CROSSWALK_ENDPOINT}?query=${encodeURIComponent(source.query)}`;
    const res = await doFetch(url, {
      headers: { Accept: "text/csv", "User-Agent": "finderr (self-hosted media request UI)" },
    });
    if (!res.ok) throw new Error(`answered ${res.status}`);
    const text = await res.text();
    // Written only after the whole body has arrived: a half-written CSV would parse into a
    // crosswalk that is missing its tail, which is worse than not having one.
    await Bun.write(path, text);
    log(`crosswalk ${source.label}: downloaded ${(text.length / 1e6).toFixed(1)} MB`);
    return true;
  } catch (err) {
    const why = (err as Error).message;
    log(
      cached
        ? `crosswalk ${source.label}: download failed (${why}) -- keeping the copy on disk`
        : `crosswalk ${source.label}: download failed (${why}) -- links fall back to what we had`,
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

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export const PERSON_CROSSWALK_SCHEMA = `
-- TMDB person id -> our nconst, so a cast tile links to a person rather than to a name
-- that happens to match one.
--
-- KEYED ON THE TMDB ID because that is the direction every reader asks in: a cast list
-- arrives holding TMDB ids and wants ours. The reverse edge has no caller, so there is no
-- index for it -- adding one would cost every build a sort of a third of a million rows to
-- answer a question nobody has.
create table person_external (
  tmdb_id integer primary key,
  nconst  text not null
);
`;

/** One `(nconst, tmdb person id)` pair, as Wikidata publishes it. */
export interface PersonCrosswalkRow {
  nconst: string;
  tmdb: number;
}

/**
 * Parse the two-column CSV the person query returns.
 *
 * Hand-parsed for the same reason `parseCrosswalkCsv` is, and DROPPING rather than
 * repairing for the same reason too: a half-parsed id sends a reader to a stranger's
 * filmography, which is the exact failure this whole table exists to end.
 */
export function parsePersonCrosswalkCsv(text: string): PersonCrosswalkRow[] {
  const out: PersonCrosswalkRow[] = [];
  const lines = text.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const parts = line.split(",");
    if (parts.length !== 2) continue;
    const [nconst, tmdb] = parts;
    if (!nconst || !/^nm\d+$/.test(nconst)) continue;
    const id = idOrNull(tmdb);
    if (id === null) continue;
    out.push({ nconst, tmdb: id });
  }
  return out;
}

/**
 * Write the pairs into `person_external`, keeping only the ones we can act on.
 *
 * TWO FILTERS, and the order between them is the whole correctness argument.
 *
 * **AMBIGUITY IS DROPPED, NEVER RESOLVED.** Wikidata's merge artefacts leave 1,222 TMDB ids
 * pointing at two or more nconsts and 394 nconsts pointing at two or more TMDB ids
 * (measured 2026-09-03 over 346,293 pairs). Neither direction can be picked between, so
 * both sides are thrown away -- the same poison rule `nconstsByNameForTitle` applies to a
 * name shared by two people on one title, and for the identical reason: sending a reader to
 * the wrong person is worse than leaving the name as plain text.
 *
 * The ambiguity check runs over the WHOLE source and only then is the result restricted to
 * people we hold. Restricting first would hide a collision whose other half is simply below
 * our vote floor, and the surviving half would look unambiguous while being a coin toss.
 *
 * **Restricted to people in `person`** for the reason the dead-end rule gives: a crosswalk
 * entry for somebody with no credits in our index resolves an nconst perfectly and still has
 * no filmography to render. Plain text is the correct answer there, so the row is not kept.
 * This is also what makes the table a fifth of the source rather than all of it.
 *
 * Returns how many pairs were kept.
 */
export function loadPersonCrosswalk(db: Database, rows: PersonCrosswalkRow[]): number {
  db.run("create temporary table pcw_in (nconst text not null, tmdb integer not null)");
  const insert = db.prepare("insert into pcw_in values (?,?)");
  db.transaction(() => {
    for (const r of rows) insert.run(r.nconst, r.tmdb);
  })();

  // `count(distinct ...)` rather than `count(*)`, and `select distinct` rather than
  // `insert or ignore`: the same pair listed twice is a duplicate row, not a disagreement.
  // Counting rows would discard a good mapping, and inserting them twice would trip the
  // primary key on a source that never actually contradicted itself.
  db.run(`
    insert into person_external (tmdb_id, nconst)
    select distinct i.tmdb, i.nconst
      from pcw_in i
      join person p on p.nconst = i.nconst
     where i.tmdb   in (select tmdb   from pcw_in group by tmdb   having count(distinct nconst) = 1)
       and i.nconst in (select nconst from pcw_in group by nconst having count(distinct tmdb)   = 1)
  `);
  db.run("drop table pcw_in");

  return (db.query("select count(*) c from person_external").get() as { c: number }).c;
}

/**
 * Our nconsts for a set of TMDB person ids, in one query.
 *
 * A batch rather than one call per credit because a title page asks about thirty people at
 * once, and thirty prepared-statement round trips to answer one question is the shape that
 * turns a 1ms lookup into a visible one. Ids we do not hold are simply absent from the map.
 */
export function nconstsByTmdbPersonId(db: Database, tmdbIds: readonly number[]): Map<number, string> {
  const out = new Map<number, string>();
  if (tmdbIds.length === 0) return out;
  const rows = db
    .query(
      `select tmdb_id, nconst from person_external where tmdb_id in (${tmdbIds.map(() => "?").join(",")})`,
    )
    .all(...(tmdbIds as never[])) as { tmdb_id: number; nconst: string }[];
  for (const r of rows) out.set(r.tmdb_id, r.nconst);
  return out;
}
