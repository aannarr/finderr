/**
 * Where a title was filmed, and every title filmed at a place.
 *
 * Wikidata's `filming location` (P915), joined to the IMDb id every title item carries (P345),
 * bought in bulk from the same QLever mirror the id crosswalks use and loaded into `titles.db`
 * at build time. NOTHING HERE TOUCHES THE NETWORK: `fetchCrosswalk` downloads the two CSVs in
 * the build job, the loader reads them off disk, and every render path reads the two tables.
 *
 * ## Measured 2026-09-13/14 against QLever and the real 1.27M-row index
 *
 * - 42,150 title-place pairs (3.4 s) and 12,873 distinct places (5-6 s), CC0.
 * - Coverage by vote rank, movie + series: 88 of the top 100 titles carry a place, 786 of the
 *   top 1,000, 5,067 of the top 10,000. It is the popular head, which is where readers are.
 * - moviescenemap.com is built on this same property. Its downloads carry no IMDb id, so it
 *   would be a second hop to the source we can read directly.
 *
 * ## Three kinds of place, and one of them is never kept
 *
 * P915 names anything from a castle to a continent, and treating them alike is what makes a
 * "filmed at" row useless: "United States" beside "Monument Valley" is a caption, not a place.
 *
 * - **site** -- a castle, a street, a studio, a national park. The thing a reader goes to look at.
 * - **area** -- a settlement or an administrative region: Almería, Los Angeles, Notting Hill.
 *   Still a real destination -- everything shot in Almería is a run of spaghetti westerns and
 *   a Bond film -- so it is kept and linked, and drawn after the sites.
 * - **caption** -- a sovereign state, a continent, an ocean, a sea, or a state that no longer
 *   exists. DROPPED at load. A page of every film shot somewhere in the United States, in
 *   Europe or on the Atlantic is not a place anybody goes to look at.
 *
 * The continent/ocean/sea/former-state half was added 2026-09-14, after the quality review
 * found Europe filed as a site and Antarctica and Yugoslavia as areas. Those four classes are
 * dropped ONLY when the item is not also a human settlement: Hamburg and Bremen are typed as
 * historical countries (the old city-states), and they are cities people film in. The UK's
 * constituent countries (Q3336843) are EXCLUDED from the caption test by name, because Wikidata
 * types England, Scotland, Wales and Northern Ireland under "country" too -- the v3 build
 * dropped all four, 87 pairs including Northern Ireland's Game of Thrones locations, while
 * this comment claimed they were kept. Found by the round-3 review, 2026-09-14.
 *
 * The classification is Wikidata's own class tree (`P31/P279*`), asked in the query rather than
 * re-derived here, with ONE correction measured against the data: Czech and German castles are
 * typed as human settlements as well as castles, so 199 castles, stations and palaces came out
 * as areas. An area is therefore a settlement or administrative entity that is NOT also an
 * architectural structure (Q811979), which leaves 21.
 *
 * Two widenings, measured against QLever 2026-09-14 over every P915 place:
 *
 * - **An island (Q23442) or a lake (Q23397) is an area.** Tahiti, Gran Canaria, Long Island,
 *   Lake Como: places a reader goes to, and ones a whole run of titles share. NOT "body of
 *   water" or "geographic region" -- the first also means waterfalls and canals, and the
 *   second matched 8,534 places, thermal baths among them.
 * - **A structure WITH A POPULATION (P1082) is still an area.** 506 places are both a
 *   settlement-or-admin-entity and a structure; the 55 with a population are towns (Ostend,
 *   Saint-Tropez, Malmö, Val-d'Isère) and the 451 without are castles, abbeys and camps. The
 *   population is the fact that separates them, where the class tree does not.
 */

import type { Database } from "bun:sqlite";
import type { CrosswalkSource } from "./crosswalk";
import { MIN_TERM_TITLES } from "./terms";

/**
 * Every place any work was filmed at, one row each, already classified.
 *
 * GROUPED so a place with two English labels, two coordinates or two countries is still one
 * row -- `SAMPLE` picks one, which is fine for a label and a map pin and would be wrong for
 * nothing we store. The class flags are `MAX` over booleans, so "is it EVER a studio" wins.
 *
 * A place with no English label is kept by the query and dropped by `parsePlacesCsv`: a chip
 * needs a name, and 282 of 12,873 had none on 2026-09-14.
 */
export const PLACE_SOURCE: CrosswalkSource = {
  file: "wikidata-places.csv",
  label: "filming places",
  query: `PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?place (SAMPLE(?l) AS ?label) (SAMPLE(?co) AS ?coord) (SAMPLE(?cc) AS ?country) (MAX(?st) AS ?studio) (MAX(?ar) AS ?area) (MAX(?cy) AS ?caption) WHERE {
  { SELECT DISTINCT ?place WHERE { ?w wdt:P915 ?place } }
  OPTIONAL { ?place rdfs:label ?l FILTER(LANG(?l) = "en") }
  OPTIONAL { ?place wdt:P625 ?co }
  OPTIONAL { ?place wdt:P17 ?c . ?c wdt:P297 ?cc }
  BIND(EXISTS { ?place wdt:P31/wdt:P279* wd:Q375336 } AS ?st)
  BIND((EXISTS { ?place wdt:P31/wdt:P279* wd:Q486972 } || EXISTS { ?place wdt:P31/wdt:P279* wd:Q56061 }
        || EXISTS { ?place wdt:P31/wdt:P279* wd:Q23442 } || EXISTS { ?place wdt:P31/wdt:P279* wd:Q23397 })
       && (!EXISTS { ?place wdt:P31/wdt:P279* wd:Q811979 } || EXISTS { ?place wdt:P1082 ?pop }) AS ?ar)
  BIND(((EXISTS { ?place wdt:P31/wdt:P279* wd:Q6256 } || EXISTS { ?place wdt:P31/wdt:P279* wd:Q3624078 })
        && !EXISTS { ?place wdt:P31/wdt:P279* wd:Q3336843 })
       || ((EXISTS { ?place wdt:P31/wdt:P279* wd:Q5107 } || EXISTS { ?place wdt:P31/wdt:P279* wd:Q9430 }
            || EXISTS { ?place wdt:P31/wdt:P279* wd:Q165 } || EXISTS { ?place wdt:P31/wdt:P279* wd:Q3024240 })
           && !EXISTS { ?place wdt:P31/wdt:P279* wd:Q486972 }) AS ?cy)
} GROUP BY ?place`,
};

/**
 * Every (IMDb title id, place) pair.
 *
 * Three ways a title reaches a place, UNIONed: its own P915, an EPISODE's P915 rolled up to
 * the series it is part of (P179), and a SEASON's rolled up the same way. The index holds
 * series, never episodes, so an episode filmed at Dubrovnik is a fact about the show.
 *
 * An episode that has its OWN IMDb id arrives through the first branch too, naming an episode
 * rather than a title we index -- and `loadPlaces` rolls THAT up through the `episode` table, so
 * both routes land on the series and `distinct` counts the place once. The query rolls up what
 * it can see (P179) and the loader rolls up what the index knows; an episode Wikidata never
 * linked to its series is still caught by the second.
 *
 * CORRECTED 2026-09-14: the first build filtered episodes with their own id OUT of the P179
 * branch on the belief that the first branch already counted them. It did not -- the loader
 * dropped those rows as unknown titles -- and the quality review measured 2,167 of 42,150
 * pairs lost across 130 series, Game of Thrones keeping 1 of its 9 places.
 *
 * Every row also carries `?w`, the item that MADE the statement, and `?via`, the branch that
 * found it. That is what lets `loadPlaces` count how many episodes stand behind a series'
 * place: one episode arrives by two routes, and only its item id says the two rows are one.
 */
export const TITLE_PLACE_SOURCE: CrosswalkSource = {
  file: "wikidata-title-places.csv",
  label: "filming locations",
  query: `PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX wd: <http://www.wikidata.org/entity/>
SELECT DISTINCT ?imdb ?place ?w ?via WHERE {
  ?w wdt:P915 ?place .
  { ?w wdt:P345 ?imdb . BIND("title" AS ?via) }
  UNION
  { ?w wdt:P31/wdt:P279* wd:Q21191270 . ?w wdt:P179 ?series . ?series wdt:P345 ?imdb . BIND("episode" AS ?via) }
  UNION
  { ?w wdt:P31/wdt:P279* wd:Q3464665 . ?w wdt:P179 ?series . ?series wdt:P345 ?imdb . BIND("season" AS ?via) }
  FILTER(STRSTARTS(?imdb, "tt"))
}`,
};

/** Both sources, in the order the build job downloads them. */
export const FILMING_LOCATION_SOURCES: readonly CrosswalkSource[] = [PLACE_SOURCE, TITLE_PLACE_SOURCE];

export const PLACES_SCHEMA = `
-- Every place at least one of OUR titles was filmed at. Keyed on the Wikidata Q number as an
-- integer, which is both the identity and the URL: /place/Q10400 is Almeria.
--
-- titles is PRECOMPUTED, for the reason browse_count exists: the title pane decides link or
-- plain text on it and the place page prints it, and a count on the render path is the one
-- query that cannot become a seek. It counts titles in THIS index, never Wikidata's.
--
-- kind is 'site' or 'area'. Captions (countries, continents, oceans) never reach this table.
-- No backticks in this string: it is a template literal.
create table place (
  id      integer primary key,
  label   text not null,
  lat     real,
  lon     real,
  country text,
  kind    text not null,
  studio  integer not null default 0,
  titles  integer not null default 0
);

-- One row per (place, title). votes is DENORMALISED from title so the place page is one
-- ordered seek on ix_place_titles that never reaches into title until the page of rows is
-- already chosen -- the same trade title_genre and title_lang make.
--
-- episodes is how many distinct EPISODES of a series carried the statement, 0 when the title
-- said it of itself. It is what separates "the series was shot here" from "one episode was".
create table title_place (
  place_id    integer not null,
  title_rowid integer not null,
  votes       integer not null default 0,
  episodes    integer not null default 0
);

-- One row per (episode, place), for an episode whose OWN IMDb id the index holds in episode.
-- title_place already rolls these up to the series; this keeps the episode itself, so the
-- episode's row on the series page can say where it was filmed. An episode Wikidata reaches
-- only through P179 has no id of ours to hang a row on, and counts toward the series alone.
create table episode_place (
  episode_rowid integer not null,
  place_id      integer not null
);
`;

/** The index DDL, built by the stage after the rows are in. `INDEXES.places` holds it. */
export const PLACE_INDEXES = [
  // The place page: one place, most-voted first, rowid as the stable tie-break. `episodes`
  // rides along so the page's subquery stays COVERING: an OFFSET walk must skip index entries,
  // not fetch a table row for every title it skips.
  "create index ix_place_titles on title_place(place_id, votes desc, title_rowid, episodes)",
  // The title pane: every place one title was filmed at.
  // `episodes` rides along so the title pane's read stays COVERING: without it the v4 bench
  // (M1 Max, 2026-09-14) showed `SEARCH tp USING INDEX`, a table row fetched per place.
  "create index ix_title_place on title_place(title_rowid, place_id, episodes)",
  // An episode row's places: `ix_ep_parent` finds the series' episodes, this finds each one's.
  "create index ix_episode_place on episode_place(episode_rowid, place_id)",
] as const;

export type PlaceKind = "site" | "area";

/** One place as the source describes it, before we know whether any title of ours is there. */
export interface PlaceSourceRow {
  id: number;
  label: string;
  lat: number | null;
  lon: number | null;
  country: string | null;
  kind: PlaceKind | "caption";
  studio: boolean;
}

/** One (title, place) pair as the source describes it. */
export interface TitlePlaceSourceRow {
  imdb: string;
  place: number;
  /** The Wikidata item that made the statement, as an integer: the film, or one episode. */
  work: number;
  /** Reached the series through an episode's P179. A season's statement is not an episode. */
  episode: boolean;
}

/**
 * One place, as the browser receives it.
 *
 * `id` is the Wikidata id WITH its `Q`, because that is the form a reader recognises and the
 * form the URL carries. The integer is a storage detail.
 */
export interface Place {
  id: string;
  label: string;
  kind: PlaceKind;
  studio: boolean;
  /** ISO 3166-1 alpha-2, or null when Wikidata names no country. */
  country: string | null;
  lat: number | null;
  lon: number | null;
  /** How many titles in THIS index were filmed here. What decides link versus plain text. */
  titles: number;
}

/**
 * A place as ONE title's list carries it.
 *
 * `episodes` is how many of that title's episodes were filmed there, and 0 when the title said
 * it of itself. It lives on the pair, never on `Place`, because the same Dubrovnik is "2
 * episodes" of Game of Thrones and a whole film of something else.
 */
export interface TitlePlace extends Place {
  episodes: number;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * One CSV record, RFC 4180 quoting included.
 *
 * Hand-rolled like every other parser in `crosswalk.ts`, but unlike them this one cannot split
 * on commas: a place label is free text, and 151 of them carried a comma on 2026-09-14
 * ("Festetics Palace, Dég"). A quoted field keeps its commas and un-doubles its quotes.
 *
 * Returns null for a record whose quotes do not balance, which is dropped rather than
 * repaired -- the same rule every crosswalk parser follows.
 */
export function parseCsvRecord(line: string): string[] | null {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      out.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  if (quoted) return null;
  out.push(field);
  return out;
}

/** `http://www.wikidata.org/entity/Q10400` -> 10400. A blank node or anything else -> null. */
export function placeIdOfIri(iri: string | undefined): number | null {
  const m = /^http:\/\/www\.wikidata\.org\/entity\/Q([1-9]\d{0,11})$/.exec(iri?.trim() ?? "");
  return m ? Number(m[1]) : null;
}

/**
 * A Wikidata id off the wire -- `Q10400` -- to the integer we store, or null.
 *
 * The route parameter's guard, and a closed pattern rather than a sanitizer: an id is a `Q`
 * and up to twelve digits (Wikidata is past Q130,000,000, so twelve is four orders of
 * headroom), and anything else is not a place we could hold. Case-insensitive on the `Q`,
 * because a hand-typed `/place/q10400` means exactly the same place.
 */
export function parsePlaceId(v: unknown): number | null {
  if (typeof v !== "string" || v.length > 13) return null;
  const m = /^[Qq]([1-9]\d{0,11})$/.exec(v);
  return m ? Number(m[1]) : null;
}

/** `POINT(-2.463889 36.841667)` -> `{ lat: 36.841667, lon: -2.463889 }`. WKT is lon first. */
function parsePoint(wkt: string | undefined): { lat: number; lon: number } | null {
  const m = /^POINT\((-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)\)$/i.exec(wkt?.trim() ?? "");
  if (!m) return null;
  const lon = Number(m[1]);
  const lat = Number(m[2]);
  // A coordinate on another globe (Wikidata puts Mars craters in P625) or a typo is not a pin.
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

const flag = (v: string | undefined) => v?.trim() === "true" || v?.trim() === "1";

/**
 * The seven-column place CSV. A row with no parseable id or no label is dropped.
 *
 * A LABEL is length-capped at 200 characters and refused past it rather than cut: the longest
 * real one is well under 100, and a label that long is not a place name.
 */
export function parsePlacesCsv(text: string): PlaceSourceRow[] {
  const out: PlaceSourceRow[] = [];
  const lines = text.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]?.replace(/\r$/, "");
    if (!line) continue;
    const cols = parseCsvRecord(line);
    if (cols?.length !== 7) continue;
    const [iri, rawLabel, coord, country, studio, area, caption] = cols;
    const id = placeIdOfIri(iri);
    const label = rawLabel?.trim() ?? "";
    if (id === null || label === "" || label.length > 200) continue;
    const point = parsePoint(coord);
    const cc = country?.trim().toUpperCase() ?? "";
    out.push({
      id,
      label,
      lat: point?.lat ?? null,
      lon: point?.lon ?? null,
      country: /^[A-Z]{2}$/.test(cc) ? cc : null,
      // The order is the whole rule: a sovereign state is also an administrative entity, and
      // must not survive as an "area" just because that flag was asked second.
      kind: flag(caption) ? "caption" : flag(area) ? "area" : "site",
      studio: flag(studio),
    });
  }
  return out;
}

const VIAS = new Set(["title", "episode", "season"]);

/**
 * The four-column pairs CSV: `tt<digits>,<place IRI>,<work IRI>,<title|episode|season>`.
 * Anything else is dropped, including the two-column shape an older download had -- the
 * query stamp re-fetches that file, and a row with no work cannot be counted honestly.
 */
export function parseTitlePlacesCsv(text: string): TitlePlaceSourceRow[] {
  const out: TitlePlaceSourceRow[] = [];
  const lines = text.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]?.replace(/\r$/, "");
    if (!line) continue;
    const parts = line.split(",");
    if (parts.length !== 4) continue;
    const [imdb, placeIri, workIri, via] = parts;
    if (!imdb || !/^tt\d+$/.test(imdb) || !via || !VIAS.has(via)) continue;
    const place = placeIdOfIri(placeIri);
    const work = placeIdOfIri(workIri);
    if (place === null || work === null) continue;
    out.push({ imdb, place, work, episode: via === "episode" });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Fill `place` and `title_place`, keeping only what one of our titles can reach.
 *
 * Both temp tables are KEYED before anything joins them -- `loadOrigin` carries the seventeen-
 * minute build that taught that. The pairs are a 42k-row scan seeking `title.tconst`'s unique
 * index, and each place lookup is a primary-key seek.
 *
 * A place survives only with at least one title of ours, because a place page listing nothing
 * is a dead end, and `titles` is computed from the pairs that actually landed.
 *
 * Returns how many places and pairs were kept.
 */
export function loadPlaces(
  db: Database,
  places: readonly PlaceSourceRow[],
  pairs: readonly TitlePlaceSourceRow[],
): { places: number; pairs: number } {
  db.run(
    `create temporary table place_in (
       id integer primary key, label text not null, lat real, lon real,
       country text, kind text not null, studio integer not null)`,
  );
  const insPlace = db.prepare("insert or ignore into place_in values (?,?,?,?,?,?,?)");
  db.run(
    `create temporary table tp_in (
       imdb text not null, place integer not null, work integer not null, episode integer not null)`,
  );
  const insPair = db.prepare("insert into tp_in values (?,?,?,?)");
  db.transaction(() => {
    for (const p of places) {
      if (p.kind === "caption") continue;
      insPlace.run(p.id, p.label, p.lat, p.lon, p.country, p.kind, p.studio ? 1 : 0);
    }
    for (const r of pairs) insPair.run(r.imdb, r.place, r.work, r.episode ? 1 : 0);
  })();

  /*
    An id that names an EPISODE is rolled up to its series here, through `episode.tconst`'s
    unique index -- a seek per pair, and a miss for every pair that already names a title.
    GROUPED so a place two episodes share is one pair rather than two.

    `episodes` counts distinct WORKS that are episodes: a row is an episode's when its IMDb id
    resolved through the episode table, or when the query reached the series through an
    episode's P179. The same episode arriving both ways has one work id, so it counts once.
    `max(t.votes)` is `t.votes` -- one title per group -- spelled as an aggregate.
  */
  db.run(`
    insert into title_place (place_id, title_rowid, votes, episodes)
    select i.place, t.rowid_, max(t.votes),
           count(distinct case when e.tconst is not null or i.episode = 1 then i.work end)
      from tp_in i
      left join episode e on e.tconst = i.imdb
      join title t on t.tconst = coalesce(e.parent, i.imdb)
      join place_in p on p.id = i.place
     group by i.place, t.rowid_
  `);
  // The episode itself, before `tp_in` goes: only ids the episode table holds, and only for a
  // series this index holds, so every row here has a `title_place` row above it.
  db.run(`
    insert into episode_place (episode_rowid, place_id)
    select distinct e.rowid_, i.place
      from tp_in i
      join episode e on e.tconst = i.imdb
      join title t on t.tconst = e.parent
      join place_in p on p.id = i.place
  `);
  db.run("drop table tp_in");

  db.run("create temporary table place_count (place_id integer primary key, n integer not null)");
  db.run("insert into place_count select place_id, count(*) from title_place group by place_id");
  db.run(`
    insert into place (id, label, lat, lon, country, kind, studio, titles)
    select p.id, p.label, p.lat, p.lon, p.country, p.kind, p.studio, c.n
      from place_in p join place_count c on c.place_id = p.id
  `);
  db.run("drop table place_count");
  db.run("drop table place_in");

  const count = (sql: string) => (db.query(sql).get() as { c: number }).c;
  return {
    places: count("select count(*) c from place"),
    pairs: count("select count(*) c from title_place"),
  };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface PlaceDbRow {
  id: number;
  label: string;
  lat: number | null;
  lon: number | null;
  country: string | null;
  kind: string;
  studio: number;
  titles: number;
}

const PLACE_COLS = "p.id, p.label, p.lat, p.lon, p.country, p.kind, p.studio, p.titles";

function toPlace(r: PlaceDbRow): Place {
  return {
    id: `Q${r.id}`,
    label: r.label,
    kind: r.kind === "area" ? "area" : "site",
    studio: r.studio === 1,
    country: r.country,
    lat: r.lat,
    lon: r.lon,
    titles: r.titles,
  };
}

/**
 * Every place one title was filmed at, in the order a reader should meet them.
 *
 * PLACES WITH A PAGE FIRST, then sites before areas, then the most-filmed, then the label as the
 * stable tie-break so the row never reshuffles between two loads of one page.
 *
 * The first key is the one the 2026-09-14 critique bought. Ordering on kind alone put every
 * one-title site ahead of every city, so the rail's fold at eight kept the dead ends on screen
 * and hid Paris, Tokyo and Tangier behind "Show all". The threshold is `MIN_TERM_TITLES`, the
 * same constant the browser's link rule reads, so "has a page" means one thing on both sides.
 *
 * The plan ends in `USE TEMP B-TREE FOR ORDER BY`, and `bench-index` flags it as a sort. It is
 * a sort of ONE title's places, found by a covering seek on `ix_title_place` -- at most 44 rows
 * on the 2026-09-14 build -- so it never grows with the corpus. Measured on that build, M1 Max:
 * `title.places` 0.01 ms p50, 0.04 ms p99, 1.6 ms cold. No index can serve this order anyway:
 * two of its keys live on `place`, not on the table the seek walks.
 */
export function placesForTitle(db: Database, tconst: string): TitlePlace[] {
  const rows = db
    .query(
      `select ${PLACE_COLS}, tp.episodes
         from title_place tp join place p on p.id = tp.place_id
        where tp.title_rowid = (select rowid_ from title where tconst = ?)
        order by p.titles >= ${MIN_TERM_TITLES} desc, case p.kind when 'site' then 0 else 1 end,
                 p.titles desc, p.label`,
    )
    .all(tconst) as (PlaceDbRow & { episodes: number })[];
  return rows.map((r) => ({ ...toPlace(r), episodes: r.episodes }));
}

/** One episode's places, at the INDEX's `(season, number)`. */
export interface EpisodePlaces {
  season: number;
  number: number;
  places: Place[];
}

/**
 * Where each episode of one series was filmed, for the episodes that say.
 *
 * `ix_ep_parent` finds the series' episodes and `ix_episode_place` each one's places, so it is
 * two seeks and a primary-key read per place. The coordinates are the INDEX's, which disagree
 * with the provider's for some shows -- the handler aligns them the way it aligns scores.
 * Sites before areas within an episode, then the label, the order the title pane uses.
 */
export function episodePlacesForSeries(db: Database, parent: string): EpisodePlaces[] {
  const rows = db
    .query(
      `select e.season, e.number, ${PLACE_COLS}
         from episode e
         join episode_place ep on ep.episode_rowid = e.rowid_
         join place p on p.id = ep.place_id
        where e.parent = ?
        order by e.season, e.number, case p.kind when 'site' then 0 else 1 end, p.label`,
    )
    .all(parent) as (PlaceDbRow & { season: number; number: number })[];
  const out: EpisodePlaces[] = [];
  for (const r of rows) {
    const last = out.at(-1);
    if (last && last.season === r.season && last.number === r.number) last.places.push(toPlace(r));
    else out.push({ season: r.season, number: r.number, places: [toPlace(r)] });
  }
  return out;
}

/** One place, or null when we hold no title filmed there. */
export function placeById(db: Database, id: number): Place | null {
  const row = db.query(`select ${PLACE_COLS} from place p where p.id = ?`).get(id) as PlaceDbRow | undefined;
  return row ? toPlace(row) : null;
}
