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
import { existsSync, readFileSync, statSync } from "node:fs";

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

/**
 * Every title's ORIGINAL LANGUAGE, as an ISO 639-1 code.
 *
 * P364 resolved to a code rather than kept as a Q-id: the codes are what a config, a
 * query parameter and `navigator.languages` all already speak, and a Q-id would need a
 * second lookup table nobody else in this tree wants.
 *
 * ## Why there are three ways to reach a code, and not one
 *
 * P218 alone was the whole rule until 2026-09-06, and it UNDERCOUNTED whole cinemas by an
 * order of magnitude -- because Wikidata files a film's P364 under whatever item its editors
 * think in, and most of those items carry no ISO 639-1 code of their own. Chinese-language
 * cinema is filed under `Cantonese`, `Mandarin`, `Standard Chinese`, `Putonghua` and
 * `Standard Taiwanese Mandarin`; Greek cinema under `Greek` (the code `el` lives on `Modern
 * Greek`, a different item). None of those has a P218, so none of them produced a row.
 *
 * The two extra alternatives are FALLBACKS, reached only when the item has no P218 of its
 * own, and each one is answering a different way the data goes missing:
 *
 * 1. **The nearest coded ancestor** (`P279+`, stopping at the first one). A variety folds
 *    onto the language it is a variety OF -- Cantonese and Mandarin onto Chinese, Brazilian
 *    Portuguese onto Portuguese, Swiss German onto German. "Nearest" is what the inner
 *    `NOT EXISTS` buys and it is not decoration: an unbounded `P279+` climbs PAST the first
 *    coded ancestor, and measured against the live endpoint that filed 61 Flemish and
 *    Belgian Dutch titles as German as well as Dutch.
 * 2. **The Wikimedia language code** (P424), which is how `Greek` reaches `el` -- there is no
 *    coded ancestor to climb to, because `Modern Greek` is a child of `Greek` rather than a
 *    parent. Constrained to codes that are some item's real P218, because P424 also carries
 *    codes ISO never assigned: unconstrained it filed 47 Tunisian Arabic titles under `tu`,
 *    which is not an ISO 639-1 code at all.
 *
 * **The codes are NOT length-checked here.** `parseOriginCsv` owns that rule for both origin
 * sources and drops what this query cannot avoid emitting -- `zh-yue`, `pt-br`, `arz`. One
 * owner; a `FILTER(STRLEN(?code) = 2)` here would be a second copy of it to keep in step.
 *
 * **P364 IS MULTI-VALUED and the extra rows are the point.** `Sardar Udham` is `hi/en/pa`
 * and `Captain Phillips` is `so/en`; a title matches a language preference if ANY of its
 * languages match, because "is there a version of this I can watch" is the question a
 * reader is really asking. Picking one primary language would be picking it arbitrarily --
 * the property carries no order. The fallbacks above ride on that: a title filed under an
 * item with two equally-near coded ancestors gets a row for each, which is the same shape as
 * a genuinely bilingual film.
 *
 * Measured against the live endpoint 2026-09-06, before -> after, distinct titles per code:
 * `zh` 833 -> 5,468, `el` 8 -> 1,361, `tl` 421 -> 1,067, `en` 163,068 -> 163,645, `pt`
 * 3,822 -> 4,307, `ar` 2,493 -> 2,971, `de` 26,389 -> 26,670. 353,143 rows -> 362,992, 3.3s.
 */
export const LANGUAGE_CROSSWALK: CrosswalkSource = {
  file: "wikidata-lang.csv",
  label: "original languages",
  query: `PREFIX wdt: <http://www.wikidata.org/prop/direct/>
SELECT ?imdb ?code WHERE {
  ?s wdt:P345 ?imdb .
  ?s wdt:P364 ?lang .
  FILTER(STRSTARTS(?imdb, "tt"))
  {
    ?lang wdt:P218 ?code .
  } UNION {
    FILTER NOT EXISTS { ?lang wdt:P218 ?anyCode }
    {
      ?lang wdt:P279+ ?ancestor .
      ?ancestor wdt:P218 ?code .
      FILTER NOT EXISTS {
        ?lang wdt:P279+ ?nearer .
        ?nearer wdt:P218 ?nearerCode .
        ?nearer wdt:P279+ ?ancestor .
      }
    } UNION {
      ?lang wdt:P424 ?code .
      ?isoLang wdt:P218 ?code .
    }
  }
}`,
};

/**
 * Every title's COUNTRY OF ORIGIN, as an ISO 3166-1 alpha-2 code.
 *
 * Its own source rather than a third column on the language query, because the two have
 * genuinely different coverage and either can be present without the other: measured on the
 * real index, country reaches 93.9% at the browse floor against language's 84.1%, and 99.6%
 * against 97.9% at 25,000 votes.
 *
 * **It is carried for DISPLAY and never used to filter**, which is a decision the experiments
 * made rather than a gap -- see `.claude/docs/2026-09-05-rank-experiments.md`. Country's extra
 * coverage is all in the low-vote tail, and a title with no language there is already admitted
 * by the fail-open rule, so filtering on it as a fallback would buy nothing and would need a
 * country-to-language table that gets India wrong for every Tamil film.
 *
 * Measured 2026-09-05: 467,796 rows, 6.2 MB, 2.8s.
 */
export const COUNTRY_CROSSWALK: CrosswalkSource = {
  file: "wikidata-country.csv",
  label: "countries of origin",
  query: `PREFIX wdt: <http://www.wikidata.org/prop/direct/>
SELECT ?imdb ?code WHERE {
  ?s wdt:P345 ?imdb .
  ?s wdt:P495 ?c .
  ?c wdt:P297 ?code .
  FILTER(STRSTARTS(?imdb, "tt"))
}`,
};

/** Every crosswalk the build job downloads, in the order it downloads them. */
export const CROSSWALK_SOURCES: readonly CrosswalkSource[] = [
  TITLE_CROSSWALK,
  PERSON_CROSSWALK,
  LANGUAGE_CROSSWALK,
  COUNTRY_CROSSWALK,
];

/**
 * How long a downloaded crosswalk is reused before being fetched again.
 *
 * A week rather than the daily cadence the IMDb dumps run on, because an id is a fact that
 * does not move: the only thing a refresh buys is coverage of titles and people that got a
 * Wikidata entry since, and those cost one `/find` call each -- or one unlinked name -- in
 * the meantime.
 */
export const CROSSWALK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Where the query that produced a crosswalk is recorded, beside the crosswalk.
 *
 * **AGE IS NOT THE ONLY REASON A CACHED FILE IS WRONG, and this is the half that was
 * missing.** The file on disk answers the query that was current when it was fetched, so
 * editing a `CrosswalkSource.query` leaves up to a week of builds silently loading the OLD
 * answer -- and the edit that prompted this one widened the language crosswalk by 9,849 rows,
 * so a week of "the fix shipped and nothing changed" was the alternative.
 *
 * A sidecar rather than a hash in the filename: the name is the identity a human looks for in
 * the dump directory, and a hashed name leaves every superseded copy behind forever.
 */
export const crosswalkQueryStampPath = (csvPath: string): string => `${csvPath}.query`;

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
 * **A CACHED FILE IS REUSED ONLY IF IT ANSWERS THE QUERY WE ASK TODAY** -- see
 * `crosswalkQueryStampPath`. An edited query invalidates the copy on disk immediately rather
 * than in a week's time, and a deployment upgrading into a query change re-downloads once.
 * The retry is automatic on the failure path too: the stamp still disagrees, so the next
 * build tries again instead of settling for an answer to the old question.
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

  const stampPath = crosswalkQueryStampPath(path);
  const cached = existsSync(path) ? statSync(path) : null;
  const answersThisQuery = existsSync(stampPath) && readFileSync(stampPath, "utf8") === source.query;
  if (cached && answersThisQuery && now() - cached.mtimeMs < maxAge) {
    log(`crosswalk ${source.label}: reusing ${(cached.size / 1e6).toFixed(1)} MB already on disk`);
    return true;
  }
  if (cached && !answersThisQuery) {
    log(`crosswalk ${source.label}: the copy on disk answers an older query -- refetching`);
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
    // The stamp goes down AFTER the CSV, for the same reason: a stamp beside a half-written
    // or unwritten file would claim the answer to a query nobody had received yet.
    await Bun.write(stampPath, source.query);
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

// ---------------------------------------------------------------------------
// Origin -- what language a title is in, and where it came from
// ---------------------------------------------------------------------------

/**
 * The code a title carries when nothing upstream knows its language.
 *
 * An EXPLICIT code rather than an absent row, and this one choice is what keeps the whole
 * filter to a single semi-join. Every title gets at least one `title_lang` row, so
 * "unknown" is a value the `in (...)` list either contains or does not -- which makes the
 * fail-open policy a member of the caller's language set rather than a second predicate,
 * a second index and a `not exists` nobody would remember to keep in step.
 *
 * It cannot collide with a real code: ISO 639-1 is exactly two letters.
 */
export const UNKNOWN_LANG = "";

/**
 * English, spelled once, because two rules in this product are stated relative to it.
 *
 * A NAMED LANGUAGE LIST is "in this language and not also in English" -- see
 * `computedLists`. That rule needs the code as a value rather than as a literal typed into
 * a WHERE clause and again into a catalogue comment, which is how the two would come to
 * disagree about what "foreign" means.
 *
 * It is not a policy in itself: which languages get a list is editorial and lives in
 * `LIST_LANGUAGES`. This is only the code those lists are foreign TO.
 */
export const ENGLISH_LANG = "en";

export const ORIGIN_SCHEMA = `
-- One row per (title, original language). EXPLODED rather than a comma column on title,
-- for the same reason title_genre is: a language preference is a set membership test, and
-- a set membership test wants an index seek rather than a LIKE over a joined string.
--
-- KEYED ON THE ROWID, not the tconst, so the filter is a semi-join against the same
-- integer title_genre already carries -- which is what lets a genre browse apply a
-- language filter without joining title and losing its covering count.
--
-- Every title has at least one row here. A title with no known language gets the empty
-- string; see UNKNOWN_LANG for why that is a value rather than an absence.
--
-- kind, rank and non_english are DENORMALISED from title for the same reason title_genre
-- carries kind, rank and votes: a LANGUAGE LIST is "the 250 highest-ranked films in this
-- language and not also in English", and with those three here that is one covering seek
-- into ix_lang_rank. Reaching through to title instead makes it a walk DOWN the whole rank
-- order until 250 films of the language have accumulated -- so the languages with the
-- THINNEST catalogues cost the most, which is the wrong way round and is what kept the
-- shipped list to twelve. See LIST_LANGUAGES and INDEXES.origin for the measurements.
--
-- year and votes are the fourth and fifth denormalised columns, added 2026-09-07 for the
-- reason title_genre gained its own year and votes: a browse that CROSSES a language with a
-- year or a decade, or that sorts by votes, had to name title.year or title.votes -- which
-- put title back in the query and took the covering count away, and for the votes sort left
-- no column here that could serve the ORDER at all. Measured on a copy of the real index,
-- ?lang=en&kind=movie&decade=2010&sort=rank 280.9 ms -> 3.2 and ?lang=fr&kind=movie&sort=votes
-- 18.8 -> 0.2. See INDEXES.origin for the index each one needs and langIndexServesAlone for
-- what they let English do.
--
-- Each copies its source's nullability rather than picking its own: title.year is nullable
-- because an unreleased title has no year, and title.votes is NOT NULL default 0 because
-- nobody having voted IS a count and it is zero. A copy that disagreed with its source about
-- what an absent value means is a filter that disagrees about which titles are in the list.
--
-- non_english is a property of the TITLE copied onto each of its rows, not of the row:
-- every row of a title carrying an en row is 0, including that en row itself. It defaults
-- to 1 so the backfill below -- titles no source has a language for -- is correct without
-- a second pass, and loadOrigin() sets 0 for the English ones.
-- (No backticks in this string: it is a template literal.)
create table title_lang (
  title_rowid integer not null,
  lang        text not null,
  kind        text not null default '',
  rank        real,
  non_english integer not null default 1,
  year        integer,
  votes       integer not null default 0
);
`;

/** One `(imdb id, code)` pair, as both origin queries return them. */
export interface OriginRow {
  imdb: string;
  code: string;
}

/**
 * Parse the two-column CSV both origin queries return.
 *
 * Dropped rather than repaired on anything unexpected, the same rule the id crosswalks
 * follow. The codes are length-checked because that is the whole validation available: an
 * ISO 639-1 language code is two letters and an ISO 3166-1 alpha-2 country code is two
 * letters, so anything else is not a value this index can file a title under.
 *
 * **THIS IS THE ONLY OWNER OF THE TWO-LETTER RULE, and `LANGUAGE_CROSSWALK` leans on it.**
 * That query's P424 fallback deliberately emits candidates that may not be two letters --
 * `zh-yue` for Cantonese, `pt-br` for Brazilian Portuguese -- because filtering them there
 * as well would be a second copy of this rule, in another language, to keep in step. A
 * three-letter code arriving here is that query working as designed, not a defect upstream.
 */
export function parseOriginCsv(text: string): OriginRow[] {
  const out: OriginRow[] = [];
  const lines = text.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const parts = line.split(",");
    if (parts.length !== 2) continue;
    const [imdb, code] = parts;
    if (!imdb || !/^tt\d+$/.test(imdb)) continue;
    const c = code?.trim().toLowerCase();
    if (!c || !/^[a-z]{2}$/.test(c)) continue;
    out.push({ imdb, code: c });
  }
  return out;
}

/**
 * Fill `title_lang` and `title.country` from the two origin sources.
 *
 * ONE function for both, because they are one stage with one invariant to maintain: every
 * title ends up with a `title_lang` row. Loading them separately would let a build with a
 * language file and no country file leave half the rule applied.
 *
 * **The `UNKNOWN_LANG` backfill is the last statement and it is not optional.** Coverage is
 * 84.1% at the browse floor and 18.5% over the whole corpus (measured 2026-09-05), so most
 * rows in this table are the backfill -- and without it a language filter would silently
 * delete every title Wikidata has never heard of, which is the exact "our own threshold
 * emptied the result" failure the house rule exists to prevent.
 *
 * Country is a COMMA-JOINED COLUMN on `title` rather than a second exploded table, because
 * nothing filters on it -- it is carried to be displayed. Sorted so two builds of the same
 * data produce the same string.
 */
export function loadOrigin(
  db: Database,
  langs: OriginRow[],
  countries: OriginRow[],
): {
  langRows: number;
  withLang: number;
  withCountry: number;
} {
  /*
    EVERY CORRELATED SUBQUERY BELOW SEEKS AN INDEX, and the first draft of this function did
    not. That is the one bug this stage has actually had, and it is written down because
    nothing in the code makes it visible.

    Measured 2026-09-05 by running it: with unkeyed temp tables the build sat at 98.8% CPU
    for seventeen minutes and had to be killed, against a whole-build cost of about two and
    a half. `where exists (select 1 from country_in i where i.imdb = title.tconst)` over an
    unindexed 467,796-row table, once per 1,276,508 titles, is ~600 billion row comparisons;
    the backfill's `not exists` against an unindexed `title_lang` is the same shape again.
    Neither is wrong, both are unrunnable. `loadCrosswalk` above had it right all along --
    its temp table is keyed `imdb text primary key`.
  */
  db.run("create temporary table lang_in (imdb text not null, code text not null)");
  const insLang = db.prepare("insert into lang_in values (?,?)");
  db.transaction(() => {
    for (const r of langs) insLang.run(r.imdb, r.code);
  })();

  // Scans `lang_in` and seeks `title.tconst`'s unique index, which is the right way round:
  // the source is a quarter the size of the title table.
  //
  // `kind`, `rank`, `year` and `votes` are copied here rather than by a later UPDATE, for the
  // reason `EXPLODE_GENRES` copies them at insert time: the row is already in hand, and a
  // second pass over 1.29M rows to fill columns the insert could have written is pure build
  // time. THIS RUNS AFTER `applyRank` -- see `originStage`'s position in the build -- so every
  // rank read here is the final one rather than a NULL.
  db.run(`
    insert into title_lang (title_rowid, lang, kind, rank, year, votes)
    select distinct t.rowid_, i.code, t.kind, t.rank, t.year, t.votes
      from title t join lang_in i on i.imdb = t.tconst
  `);
  const withLang = (db.query("select count(distinct title_rowid) c from title_lang").get() as { c: number })
    .c;

  /*
    THE SAME LANGUAGES AGAIN, comma-joined onto `title.lang` for the row payload.

    Language is stored twice on purpose and `SCHEMA` argues why at the column: the exploded
    table is what the FILTER seeks, this is what a CARD draws. Both are written here, from
    `lang_in`, so the two forms cannot disagree about what a title is in.

    Aggregated into a KEYED table first and only then joined -- the country block below
    does the identical dance for the identical reason, and this function's opening comment
    is the seventeen-minute build that reason was bought with. Sorted inside the subquery so
    `group_concat` emits a stable string: two builds of the same data must produce the same
    column, or everything looks changed to anything diffing.

    Titles with no language are simply not visited, so they keep the column's NULL. That is
    NOT the same decision as the backfill further down, which gives every one of them an
    `UNKNOWN_LANG` row in `title_lang` -- there, "unknown" has to be a member of the
    filter's in-list; here it is an absent fact and a card must draw nothing for it.
  */
  db.run("create temporary table lang_agg (imdb text primary key, codes text not null)");
  db.run(`
    insert into lang_agg (imdb, codes)
    select imdb, group_concat(code) from (select distinct imdb, code from lang_in order by imdb, code)
     group by imdb
  `);
  db.run(`
    update title set lang = (select a.codes from lang_agg a where a.imdb = title.tconst)
     where exists (select 1 from lang_agg a where a.imdb = title.tconst)
  `);
  db.run("drop table lang_agg");
  db.run("drop table lang_in");

  /*
    WHICH TITLES ARE ALSO IN ENGLISH, resolved ONCE into a keyed table and then applied.

    The obvious form -- a correlated `exists` over `title_lang` itself, once per row -- is
    the shape this whole function's opening comment exists to warn about: at 1.29M rows
    against an index that does not exist yet, it is the seventeen-minute build again.

    Only English titles are touched, so the UPDATE writes a quarter of the table rather than
    all of it, and the `default 1` on the column is what makes that sufficient: a title with
    no `en` row -- including every title the backfill below invents -- is foreign, and stays
    so without being visited.
  */
  db.run("create temporary table en_titles (title_rowid integer primary key)");
  db.run(`insert into en_titles select distinct title_rowid from title_lang where lang = '${ENGLISH_LANG}'`);
  db.run("update title_lang set non_english = 0 where title_rowid in (select title_rowid from en_titles)");
  db.run("drop table en_titles");

  /*
    Country is AGGREGATED FIRST, into a keyed table, and only then joined.

    One row per title with its codes already joined makes the update's two subqueries
    primary-key seeks. Running the `group_concat` inside a correlated subquery -- which is
    what this was -- re-derives the same string per title and scans the whole source to do it.
  */
  db.run("create temporary table country_in (imdb text not null, code text not null)");
  const insCountry = db.prepare("insert into country_in values (?,?)");
  db.transaction(() => {
    for (const r of countries) insCountry.run(r.imdb, r.code.toUpperCase());
  })();
  db.run("create temporary table country_agg (imdb text primary key, codes text not null)");
  // Sorted inside the subquery so `group_concat` emits a stable string: two builds of the
  // same data must produce the same column, or everything looks changed to anything diffing.
  db.run(`
    insert into country_agg (imdb, codes)
    select imdb, group_concat(code) from (select distinct imdb, code from country_in order by imdb, code)
     group by imdb
  `);
  db.run("drop table country_in");
  db.run(`
    update title set country = (select a.codes from country_agg a where a.imdb = title.tconst)
     where exists (select 1 from country_agg a where a.imdb = title.tconst)
  `);
  const withCountry = (
    db.query("select count(*) c from title where country is not null").get() as { c: number }
  ).c;
  db.run("drop table country_agg");

  /*
    THE BACKFILL. Every title carries a language row after this, so the filter is one
    `in (...)` and "unknown" is a code the caller either admits or does not.

    The index is TEMPORARY because the real one does not exist yet: `ix_lang` is built by
    `INDEXES.origin` after this function returns, and the statement below needs a rowid
    lookup right now. Building the real index here instead would put its DDL in two places,
    which is the drift `INDEXES` exists to prevent.
  */
  db.run("create index ix_lang_backfill on title_lang(title_rowid)");
  db.run(`
    insert into title_lang (title_rowid, lang, kind, rank, year, votes)
    select t.rowid_, '', t.kind, t.rank, t.year, t.votes from title t
     where not exists (select 1 from title_lang l where l.title_rowid = t.rowid_)
  `);
  db.run("drop index ix_lang_backfill");

  const langRows = (db.query("select count(*) c from title_lang").get() as { c: number }).c;
  return { langRows, withLang, withCountry };
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
