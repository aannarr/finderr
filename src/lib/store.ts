/**
 * Application state: the library mirror and the request log.
 *
 * Separate from the title index because the index is REBUILT wholesale every day and
 * this data must survive that. Different lifecycle, different file.
 */

import { Database } from "bun:sqlite";
import type { RadarrClient, SonarrClient } from "./arr";
import { AUTH_SCHEMA } from "./auth-store";
import type { Config } from "./config";
import { paths } from "./config";
import type { PlexItem } from "./plex";
import { encodeSeasons } from "./seasons";

/**
 * Where the mirrored server's identity lives.
 *
 * In `kv` rather than a column, because it is one fact about the SERVER and a per-row copy
 * would be a thousand copies that can only change together.
 */
const PLEX_MACHINE_KEY = "plex_machine_identifier";

export type RequestStatus =
  | "queued"
  | "sent"
  | "grabbed"
  | "downloading"
  | "available"
  | "failed"
  | "no_release";

export interface MediaRequest {
  id: number;
  tconst: string;
  title: string;
  year: number | null;
  kind: string;
  service: "radarr" | "sonarr";
  status: RequestStatus;
  arr_id: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  /** How many times we have looked for a release and found nothing. */
  search_attempts: number;
  /**
   * Which seasons the reader asked for, comma-joined ("0,1,2"), or null for "all".
   *
   * NULL is not the same as "every season listed": it means the reader never chose, so
   * the worker sends Sonarr's own `monitor: "all"` and lets it decide -- which is
   * exactly what every request did before this column existed. Only an explicit
   * choice writes a list, so an untouched request behaves identically to one made
   * yesterday. Films are always null; Radarr has no seasons to select.
   */
  seasons: string | null;
  /**
   * The user id that asked for this, or null for a request nobody is attached to.
   *
   * ADMIN-ONLY. It must never reach an ordinary user, so nothing may serialise a
   * `MediaRequest` straight into a response -- go through `visibleRequest` (`./auth.ts`),
   * which is the single owner of that rule.
   */
  requested_by: string | null;
  /**
   * Quality profile the arr should use, or null for the service default.
   *
   * ADMIN-CHOSEN, and null is the ordinary case. An ordinary user's request carries null
   * in all three of these and behaves exactly as every request did before the columns
   * existed -- `RadarrClient.add` and `SonarrClient.add` already fall back to
   * `svc.qualityProfileId` when the field is absent, so there is no second default here to
   * drift from the configured one.
   */
  quality_profile_id: number | null;
  /** Root folder the arr should file this under, or null for the service default. */
  root_folder_path: string | null;
  /**
   * Whether the arr should start searching immediately, or null for the default (yes).
   *
   * SQLite has no boolean, so this is 0/1/null and `searchOnAddOf` is the one place that
   * reads it back. Null and 1 mean the same thing to the arr; they are kept apart because
   * "nobody chose" and "somebody chose yes" are different facts about the request.
   */
  search_on_add: number | null;
}

/**
 * The three overrides an admin may attach to a request, in the API's vocabulary.
 *
 * Named because it travels through four layers -- request body, store, row, arr client --
 * and a bare inline object at each would be four places to add the fourth override.
 */
export interface RequestOverrides {
  qualityProfileId?: number | null;
  rootFolderPath?: string | null;
  searchOnAdd?: boolean | null;
}

/**
 * `search_on_add` as the arr clients want it: a boolean, or undefined for "unset".
 *
 * The one owner of the 0/1/null reading. `undefined` rather than `true` for the null case
 * so the client's own `?? true` default stays the single definition of what unset means.
 */
export function searchOnAddOf(row: Pick<MediaRequest, "search_on_add">): boolean | undefined {
  return row.search_on_add === null ? undefined : row.search_on_add !== 0;
}

/**
 * What happened when a provider was asked.
 *
 * `empty` and `failed` are both cached: without them a title with no RT entry would be
 * re-looked-up on every single view, and the UI could not tell "there is nothing here"
 * from "we are still trying".
 */
export type FacetOutcome = "ok" | "empty" | "failed";

/** One row of the facet cache. Mirrors the `facet_contribution` table exactly. */
export interface FacetContributionRow {
  entity_id: string;
  facet: string;
  plugin_id: string;
  config_version: string;
  outcome: FacetOutcome;
  /** JSON of the provider's `data`, or null unless `outcome` is `ok`. */
  data: string | null;
  freshness: string;
  resolved_at: string;
  /** null = never expires. */
  expires_at: string | null;
  /**
   * Why this contribution failed, as a fixed code -- never a raw error message.
   *
   * `null` for anything that did not fail. The vocabulary lives in `FAILURE_REASONS`
   * (`src/lib/facets.ts`) and is closed on purpose: this value reaches the browser, and an
   * error message can carry an upstream URL with a credential in its query string. The
   * message stays in the log, which is exactly where a reader seeing the code should go.
   */
  reason: string | null;
}

/** What the library mirror knows about one title. */
export interface LibraryEntry {
  imdb_id: string;
  service: "radarr" | "sonarr";
  arr_id: number;
  has_file: number;
  monitored: number;
  /** Series only: 0..1 */
  progress: number | null;
  updated_at: string;
}

/** One title that is landing soon, as one source claims it. See the `upcoming` table. */
export interface UpcomingRow {
  tconst: string;
  kind: string;
  source: UpcomingSource;
  /** YYYY-MM-DD. The soonest date this source knows for this title. */
  date: string;
  date_kind: "cinemas" | "digital" | "physical" | "airDate";
  /** Free text the shelf may show beside the date, e.g. "S2E9". Null when there is none. */
  detail: string | null;
}

/** Who claimed it. One writer each, and each replaces only its own rows. */
export type UpcomingSource = "radarr" | "sonarr" | "tmdb-movie" | "tmdb-series";

const SCHEMA = `
create table if not exists library (
  imdb_id    text not null,
  service    text not null,
  arr_id     integer not null,
  has_file   integer not null default 0,
  monitored  integer not null default 0,
  progress   real,
  updated_at text not null,
  primary key (imdb_id, service)
);
create index if not exists ix_library_service on library(service);

create table if not exists request (
  id         integer primary key autoincrement,
  tconst     text not null,
  title      text not null,
  year       integer,
  kind       text not null,
  service    text not null,
  status     text not null,
  arr_id     integer,
  error      text,
  search_attempts integer not null default 0,
  seasons    text,
  created_at text not null,
  updated_at text not null
);
create index if not exists ix_request_status on request(status);
create unique index if not exists ix_request_tconst on request(tconst);

create table if not exists kv (key text primary key, value text not null);

-- What Plex holds, keyed by OUR id.
--
-- NOTE: no backticks anywhere in this comment. SCHEMA is a template literal, so one would
-- end the string and the rest of the file becomes a parse error.
--
-- Separate from the library table rather than another service row in it, because it
-- answers a different question. library is "has the arr got this, and is it downloaded" --
-- request state. This is "the file is on the server and here is its address" -- playback
-- state. A title can be in Radarr with a file and not yet scanned into Plex, and only this
-- table knows the difference.
--
-- It exists at all because Plex cannot be asked about an IMDb id: ?guid=imdb://tt... matches
-- nothing (verified against the live server 2026-08-31), and the id is buried in Guid
-- children that arrive only with includeGuids=1 and cannot be queried on. The crosswalk has
-- to be built by walking each section, so it is a mirror or it is nothing.
create table if not exists plex_item (
  imdb_id    text primary key,
  rating_key text not null,
  updated_at text not null
);

-- What is landing soon, from every source that knows a real DATE.
--
-- The IMDb dumps carry a release YEAR and nothing finer, which is why the shelf this
-- replaces could not tell a film released in March from one arriving in December and
-- filled itself with titles that were already out. A date has to come from outside the
-- corpus, so it is mirrored here on a timer and the render path stays local SQLite.
--
-- Keyed (tconst, source) so the same title may be known to two sources without either
-- overwriting the other -- a film can sit in Radarr's calendar AND in TMDB's upcoming
-- list, and those are two different claims with two different dates.
--
-- The date column is whichever date this row is ABOUT and date_kind says which kind it
-- is, so a row explains itself rather than needing a per-source lookup at render time.
-- Sonarr's calendar is episode-shaped and this table is title-shaped, so the collapse to
-- one row per series happens at SYNC time and detail carries the episode (S2E9); doing
-- it there keeps every shelf query a plain ordered select.
create table if not exists upcoming (
  tconst    text not null,
  kind      text not null,
  source    text not null,
  date      text not null,
  date_kind text not null,
  detail    text,
  synced_at text not null,
  primary key (tconst, source)
);

create index if not exists ix_upcoming_source_date on upcoming(source, date);

-- Poster URLs, keyed by IMDb id.
--
-- The IMDb index carries no artwork, and TMDB's bulk export has no imdb_id, so
-- there is no free offline crosswalk. But Radarr and Sonarr resolve
-- imdb -> poster for ANY title (owned or not) through their own metadata proxies,
-- which we already talk to. That is the crosswalk, and it costs no API key.
--
-- A NULL url means "we looked and there genuinely is no poster" -- cached as a
-- negative result so we never look again.
--
-- studio rides along because the SAME lookup that resolves the poster also returns
-- it (studio on a Radarr movie, network on a Sonarr series). Storing it here costs
-- no extra request and keeps the badge on exactly the same cache schedule as the
-- poster. NULL means either "no logo-worthy name" or "not looked up yet" -- the url
-- column already distinguishes those two states.
create table if not exists artwork (
  imdb_id     text primary key,
  url         text,
  studio      text,
  resolved_at text not null
);

-- One plugin's answer for one facet of one title.
--
-- NAMESPACED BY PLUGIN, never pre-merged: a bad plugin can then only ever corrupt its
-- own row, and deleting a plugin removes its contributions by being absent from the
-- registry rather than by a migration. The merge into the declared facet shape happens
-- on read, in core (mergeContributions, in ./facets).
--
-- config_version is in the key so bumping a plugin's config invalidates its
-- contributions -- otherwise a corrected API key never takes effect.
--
-- outcome is what keeps "we asked and there is nothing" apart from "we asked and it
-- broke", which the UI needs in order to hide a pane quietly rather than leave a
-- skeleton spinning forever. data is JSON, and null unless outcome = 'ok'.
--
-- expires_at null means never -- the immutable facets (cast, crew, externalIds,
-- collection), which behave exactly like the artwork table above.
create table if not exists facet_contribution (
  entity_id      text not null,
  facet          text not null,
  plugin_id      text not null,
  config_version text not null,
  outcome        text not null,
  data           text,
  freshness      text not null,
  resolved_at    text not null,
  expires_at     text,
  primary key (entity_id, facet, plugin_id, config_version)
);
create index if not exists ix_facet_entity on facet_contribution(entity_id);
-- The reverse read: every row for ONE facet, whatever title it is about. A collection
-- page asks "which films name this collection?", which is the entity index backwards.
create index if not exists ix_facet_facet on facet_contribution(facet);

-- An upstream facet image URL, under the opaque key the browser is given for it.
--
-- The browser is never handed an upstream URL, so a cast headshot or a season poster
-- leaves the server as /img/f/<key> and this table is what turns that key back into
-- something to fetch. The key is a hash of the URL, so it is per-IMAGE rather than
-- per-provider: two plugins naming the same face agree on one key and share one cached
-- file, which is exactly what a provider id space could not do.
--
-- ON DISK rather than in a Map, because the client caches a title's facets: after a
-- restart an /img/f/<key> can arrive with no /api/title read in front of it to repopulate
-- anything, and an image that 404s on every restart is a broken page.
create table if not exists facet_image (
  key     text primary key,
  url     text not null,
  seen_at text not null
);
`;

/**
 * Columns added after the first release, applied to databases that already exist.
 *
 * `create table if not exists` is a no-op on a live DB, so a new column needs an
 * explicit ALTER or every deployed instance silently keeps the old shape.
 */
const ADDED_COLUMNS: { table: string; column: string; ddl: string }[] = [
  { table: "artwork", column: "studio", ddl: "alter table artwork add column studio text" },
  // When the arr first acquired the title. NOT the same as `updated_at`, which the
  // 60s mirror rewrites on every row every time -- useless for "recently added".
  { table: "library", column: "added_at", ddl: "alter table library add column added_at text" },
  // Comma-joined season numbers, null = "all". Every request written before this column
  // existed reads back as null, which is the pre-existing behaviour spelt out.
  { table: "request", column: "seasons", ddl: "alter table request add column seasons text" },
  // WHY a contribution failed, as a fixed CODE and never the raw error message.
  //
  // The message is for the log and only the log: `getJson` reports through `safeUrl`
  // precisely because an upstream URL can carry a credential, and this column travels all
  // the way to the browser. A closed vocabulary cannot leak one. The message stays in the
  // container log, which is where the code is meant to send a reader.
  {
    table: "facet_contribution",
    column: "reason",
    ddl: "alter table facet_contribution add column reason text",
  },
  /*
    WHO asked for this title. Null for every request written before there were users, and
    null for one the system made on its own behalf.

    NO foreign key, deliberately, and it is the one place in the auth work that declines
    one. `on delete cascade` would erase the request log when a user is removed, and
    `set null` would quietly destroy the attribution an admin deletes a user precisely in
    order to examine. The id is a weak reference: `deleteUser` leaves it dangling on
    purpose, and the admin view resolves what it can and shows the rest as "(removed)".

    > [!CAUTION] This column is ADMIN-ONLY on the way out
    > `visibleRequest` in `./auth.ts` strips it for anybody who is not an admin. Do not add
    > a second path that selects it straight into a response.
  */
  { table: "request", column: "requested_by", ddl: "alter table request add column requested_by text" },
  /*
    Per-request arr settings, chosen by an ADMIN and null for everybody else.

    Three columns rather than one JSON blob: each is a scalar the arr clients already take
    as a named argument, and a blob would need parsing, validating and a shape version at
    every read. Null everywhere is the pre-existing behaviour spelt out -- every request
    written before these columns reads back as "use the service default", which is what it
    did.

    `search_on_add` is integer because SQLite has no boolean. `searchOnAddOf` is the only
    thing that reads it back into one.
  */
  {
    table: "request",
    column: "quality_profile_id",
    ddl: "alter table request add column quality_profile_id integer",
  },
  {
    table: "request",
    column: "root_folder_path",
    ddl: "alter table request add column root_folder_path text",
  },
  {
    table: "request",
    column: "search_on_add",
    ddl: "alter table request add column search_on_add integer",
  },
];

export class Store {
  readonly db: Database;

  constructor(cfg: Config) {
    this.db = new Database(paths(cfg).appDb, { create: true });
    this.db.run("pragma journal_mode = wal");
    this.db.run("pragma synchronous = normal");
    /*
      SQLite enforces foreign keys only when ASKED to, per connection, and its default is
      OFF. Every `on delete cascade` in AUTH_SCHEMA is inert without this line -- deleting a
      user would leave their credentials and sessions behind, which is not a tidiness
      problem: an orphaned session row is a live cookie for an account that no longer
      exists. Nothing outside the auth tables declares a foreign key, so turning it on
      changes the behaviour of no existing statement.
    */
    this.db.run("pragma foreign_keys = on");
    this.db.run(SCHEMA);
    // Identity, declared next to the identity rules. One connection, one migration path.
    this.db.run(AUTH_SCHEMA);
    this.migrate();
  }

  /** Idempotent: adds any column this build expects that the file does not have. */
  private migrate(): void {
    for (const { table, column, ddl } of ADDED_COLUMNS) {
      const cols = this.db.query(`pragma table_info(${table})`).all() as { name: string }[];
      if (!cols.some((c) => c.name === column)) this.db.run(ddl);
    }
  }

  close(): void {
    this.db.close();
  }

  // --- kv ------------------------------------------------------------------
  getKv(key: string): string | null {
    const r = this.db.query("select value from kv where key = ?").get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }
  setKv(key: string, value: string): void {
    this.db.run(
      "insert into kv (key,value) values (?,?) on conflict(key) do update set value=excluded.value",
      [key, value],
    );
  }

  // --- library mirror ------------------------------------------------------

  /**
   * Replace the mirror for one service in a single transaction.
   *
   * Replace rather than upsert-and-diff: a title removed in Radarr must disappear
   * here too, and a full swap is the only way to notice a deletion without a
   * second round trip.
   */
  replaceLibrary(
    service: "radarr" | "sonarr",
    rows: (Omit<LibraryEntry, "service" | "updated_at"> & { added_at?: string | null })[],
  ): number {
    const now = new Date().toISOString();
    const ins = this.db.prepare(
      "insert or replace into library (imdb_id, service, arr_id, has_file, monitored, progress, updated_at, added_at) values (?,?,?,?,?,?,?,?)",
    );
    this.db.run("begin");
    try {
      this.db.run("delete from library where service = ?", [service]);
      for (const r of rows) {
        if (!r.imdb_id) continue; // no IMDb id = we can never match it to the index
        ins.run(r.imdb_id, service, r.arr_id, r.has_file, r.monitored, r.progress, now, r.added_at ?? null);
      }
      this.db.run("commit");
    } catch (err) {
      this.db.run("rollback");
      throw err;
    }
    this.setKv(`library_synced_${service}`, now);
    return (this.db.query("select count(*) c from library where service = ?").get(service) as { c: number })
      .c;
  }

  /**
   * IMDb ids of the most recently acquired titles, newest first.
   *
   * Ordered by the arr's own `added` date, not by anything finderr writes -- the
   * mirror's `updated_at` is rewritten on every row every 60 seconds and carries no
   * information about age.
   */
  recentlyAddedIds(limit = 24): string[] {
    return (
      this.db
        .query(
          "select imdb_id from library where added_at is not null and has_file = 1 order by added_at desc limit ?",
        )
        .all(limit) as { imdb_id: string }[]
    ).map((r) => r.imdb_id);
  }

  /** The whole mirror as a lookup map. Small enough to hold; ~1400 rows here. */
  libraryMap(): Map<string, LibraryEntry> {
    const rows = this.db.query("select * from library").all() as LibraryEntry[];
    return new Map(rows.map((r) => [r.imdb_id, r]));
  }

  libraryCount(): { radarr: number; sonarr: number } {
    const q = (s: string) =>
      (this.db.query("select count(*) c from library where service = ?").get(s) as { c: number }).c;
    return { radarr: q("radarr"), sonarr: q("sonarr") };
  }

  // --- plex mirror ---------------------------------------------------------

  /**
   * Replace the whole Plex mirror, and record which server it describes.
   *
   * The `machineIdentifier` is stored in `kv` beside the rows rather than on each one: it
   * is a property of the SERVER, and one copy per title would be 1100 copies of one fact
   * that can only ever change together with all of them. Storing it at all -- rather than
   * asking Plex at render time -- is what keeps the render path local.
   *
   * Full swap, for the same reason `replaceLibrary` does one: a title deleted from Plex has
   * to lose its play link, and a swap is the only way to see a deletion without a second
   * round trip. The caller is what protects a good mirror from a bad sync -- `syncPlex`
   * never reaches here when the walk threw.
   */
  replacePlexItems(machineIdentifier: string, rows: PlexItem[]): number {
    const now = new Date().toISOString();
    const ins = this.db.prepare(
      "insert or replace into plex_item (imdb_id, rating_key, updated_at) values (?,?,?)",
    );
    this.db.run("begin");
    try {
      this.db.run("delete from plex_item");
      for (const r of rows) {
        if (!r.imdb_id || !r.rating_key) continue;
        ins.run(r.imdb_id, r.rating_key, now);
      }
      this.db.run("commit");
    } catch (err) {
      this.db.run("rollback");
      throw err;
    }
    this.setKv(PLEX_MACHINE_KEY, machineIdentifier);
    this.setKv("plex_synced", now);
    return this.plexCount();
  }

  /** The server the mirror describes, or null before the first successful sync. */
  plexMachineIdentifier(): string | null {
    return this.getKv(PLEX_MACHINE_KEY);
  }

  /** The whole mirror as a lookup map. Same size class as `libraryMap` -- ~1700 rows here. */
  plexMap(): Map<string, string> {
    const rows = this.db.query("select imdb_id, rating_key from plex_item").all() as PlexItem[];
    return new Map(rows.map((r) => [r.imdb_id, r.rating_key]));
  }

  plexCount(): number {
    return (this.db.query("select count(*) c from plex_item").get() as { c: number }).c;
  }

  // --- upcoming mirror -----------------------------------------------------

  /**
   * Replace one SOURCE's rows, leaving every other source's standing.
   *
   * Scoped rather than a whole-table swap because the three writers fail independently:
   * Sonarr being unreachable must not empty the shelf TMDB filled an hour ago. Within a
   * source it is still a full swap, for `replacePlexItems`'s reason -- a film that slipped
   * out of Radarr's 90-day window has to leave the shelf, and a swap is the only way to
   * see a disappearance without a second round trip.
   *
   * The caller is what protects a good mirror from a bad sync: a walk that threw must not
   * reach here at all, or an upstream blip empties a working shelf.
   */
  replaceUpcoming(source: UpcomingSource, rows: UpcomingRow[]): number {
    const now = new Date().toISOString();
    const ins = this.db.prepare(
      "insert or replace into upcoming (tconst, kind, source, date, date_kind, detail, synced_at) " +
        "values (?,?,?,?,?,?,?)",
    );
    this.db.run("begin");
    try {
      this.db.run("delete from upcoming where source = ?", [source]);
      for (const r of rows) {
        if (!r.tconst || !r.date) continue;
        ins.run(r.tconst, r.kind, source, r.date, r.date_kind, r.detail ?? null, now);
      }
      this.db.run("commit");
    } catch (err) {
      this.db.run("rollback");
      throw err;
    }
    this.setKv(`upcoming_synced_${source}`, now);
    return this.upcomingCount(source);
  }

  /**
   * One source's rows, soonest first.
   *
   * Date ascending is the display order for every shelf built on this table: it is what
   * "coming soon" means, and it is the one ordering that works for all three sources.
   * TMDB's popularity decides which titles get FETCHED and never how they are shown.
   */
  upcomingBySource(source: UpcomingSource, limit = 30): UpcomingRow[] {
    return this.db
      .query(
        "select tconst, kind, source, date, date_kind, detail from upcoming " +
          "where source = ? order by date asc limit ?",
      )
      .all(source, limit) as UpcomingRow[];
  }

  upcomingCount(source?: UpcomingSource): number {
    const row = source
      ? this.db.query("select count(*) c from upcoming where source = ?").get(source)
      : this.db.query("select count(*) c from upcoming").get();
    return (row as { c: number }).c;
  }

  // --- requests ------------------------------------------------------------

  createRequest(r: {
    tconst: string;
    title: string;
    year: number | null;
    kind: string;
    service: "radarr" | "sonarr";
    /** Season numbers the reader chose, or null/absent for "all". Sonarr only. */
    seasons?: readonly number[] | null;
    /** Who asked. Null only for a request the system makes on nobody's behalf. */
    requestedBy?: string | null;
    /**
     * Arr settings for this one request. ADMIN-ONLY -- the route is what enforces that,
     * because "who may choose" is an authorisation question and this layer has no
     * principal. Absent for every ordinary request, which is the overwhelming majority.
     */
    overrides?: RequestOverrides;
  }): MediaRequest {
    const now = new Date().toISOString();
    const seasons = encodeSeasons(r.seasons);
    const o = r.overrides ?? {};
    const searchOnAdd = o.searchOnAdd === null || o.searchOnAdd === undefined ? null : o.searchOnAdd ? 1 : 0;
    /*
      The conflict arm rewrites `seasons` and all three overrides: re-requesting a title
      after changing the selection has to move it, or the second choice is silently
      discarded and the row keeps the first one forever. The overrides follow the same rule
      for the same reason -- an admin re-requesting with a different profile means it.

      It deliberately does NOT rewrite `requested_by`. The first asker keeps the credit: a
      second person clicking Request on a title already queued has changed nothing about who
      wanted it, and overwriting would let anybody erase the attribution by re-asking.

      The asymmetry is not an inconsistency. `requested_by` records something that ALREADY
      HAPPENED and cannot be un-happened; the others are instructions for work not yet done,
      and the newest instruction is the one to follow.
    */
    this.db.run(
      "insert into request (tconst,title,year,kind,service,status,seasons,requested_by," +
        "quality_profile_id,root_folder_path,search_on_add,created_at,updated_at) " +
        "values (?,?,?,?,?,?,?,?,?,?,?,?,?) " +
        "on conflict(tconst) do update set updated_at=excluded.updated_at, seasons=excluded.seasons, " +
        "quality_profile_id=excluded.quality_profile_id, root_folder_path=excluded.root_folder_path, " +
        "search_on_add=excluded.search_on_add",
      [
        r.tconst,
        r.title,
        r.year,
        r.kind,
        r.service,
        "queued",
        seasons,
        r.requestedBy ?? null,
        o.qualityProfileId ?? null,
        o.rootFolderPath ?? null,
        searchOnAdd,
        now,
        now,
      ],
    );
    return this.getRequest(r.tconst) as MediaRequest;
  }

  getRequest(tconst: string): MediaRequest | null {
    return (
      (this.db.query("select * from request where tconst = ?").get(tconst) as MediaRequest | undefined) ??
      null
    );
  }

  updateRequest(
    tconst: string,
    patch: Partial<Pick<MediaRequest, "status" | "arr_id" | "error" | "search_attempts">>,
  ): void {
    const sets: string[] = ["updated_at = ?"];
    const args: unknown[] = [new Date().toISOString()];
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${k} = ?`);
      args.push(v);
    }
    args.push(tconst);
    this.db.run(`update request set ${sets.join(", ")} where tconst = ?`, args as never[]);
  }

  listRequests(status?: RequestStatus, limit = 100): MediaRequest[] {
    return status
      ? (this.db
          .query("select * from request where status = ? order by updated_at desc limit ?")
          .all(status, limit) as MediaRequest[])
      : (this.db
          .query("select * from request order by updated_at desc limit ?")
          .all(limit) as MediaRequest[]);
  }

  requestMap(): Map<string, MediaRequest> {
    const rows = this.db.query("select * from request").all() as MediaRequest[];
    return new Map(rows.map((r) => [r.tconst, r]));
  }

  // --- artwork -------------------------------------------------------------

  /**
   * Returns `{url}` if we have looked this title up (url may be null, meaning
   * "looked and there is genuinely no poster"), or `undefined` if we never have.
   *
   * NOTE: bun:sqlite's `.get()` returns **null** for a missing row, not undefined.
   * Normalising here is not cosmetic -- a `!== undefined` guard upstream passes on
   * null and then dereferences it. That exact mistake made every unowned title
   * throw and silently count as "no artwork".
   */
  getArtwork(imdbId: string): { url: string | null; studio: string | null } | undefined {
    const row = this.db.query("select url, studio from artwork where imdb_id = ?").get(imdbId) as
      | { url: string | null; studio: string | null }
      | null
      | undefined;
    return row ?? undefined;
  }

  /**
   * `studio` is coalesced, never clobbered: a lookup that answers with a poster but
   * no studio (or vice versa) must not erase what an earlier one already learned.
   * The two fields come from the same call but not always from the same service.
   */
  setArtwork(imdbId: string, url: string | null, studio: string | null = null): void {
    this.db.run(
      "insert into artwork (imdb_id, url, studio, resolved_at) values (?,?,?,?) " +
        "on conflict(imdb_id) do update set url=excluded.url, " +
        "studio=coalesce(excluded.studio, artwork.studio), resolved_at=excluded.resolved_at",
      [imdbId, url, studio, new Date().toISOString()],
    );
  }

  /**
   * Bulk-seed from a library sync.
   *
   * Only fills GAPS -- an existing row is left alone, so a hand-corrected poster
   * is never clobbered by the next 60s mirror pass.
   */
  seedArtwork(rows: { imdb_id: string; url: string | null; studio?: string | null }[]): number {
    const now = new Date().toISOString();
    // `do nothing` on the row, but still fill a studio the existing row is missing --
    // the mirror is the cheapest place to learn one, and leaving it null here would
    // mean every owned title waits for an on-demand poster lookup it will never need.
    const ins = this.db.prepare(
      "insert into artwork (imdb_id, url, studio, resolved_at) values (?,?,?,?) " +
        "on conflict(imdb_id) do update set studio=coalesce(artwork.studio, excluded.studio)",
    );
    let n = 0;
    this.db.run("begin");
    try {
      for (const r of rows) {
        if (!r.imdb_id || !r.url) continue;
        ins.run(r.imdb_id, r.url, r.studio ?? null, now);
        n++;
      }
      this.db.run("commit");
    } catch (err) {
      this.db.run("rollback");
      throw err;
    }
    return n;
  }

  /**
   * Titles we have a poster for but no studio.
   *
   * Every row cached before the studio column existed is in this state, and nothing
   * else would ever revisit them -- the poster is already resolved, so no image
   * request triggers a fresh lookup. Without this backfill the badge stays missing
   * forever on exactly the titles the discovery shelves show.
   */
  artworkNeedingStudio(limit = 200): string[] {
    const rows = this.db
      .query("select imdb_id from artwork where url is not null and studio is null limit ?")
      .all(limit) as { imdb_id: string }[];
    return rows.map((r) => r.imdb_id);
  }

  artworkCount(): { resolved: number; missing: number } {
    const q = (sql: string) => (this.db.query(sql).get() as { c: number }).c;
    return {
      resolved: q("select count(*) c from artwork where url is not null"),
      missing: q("select count(*) c from artwork where url is null"),
    };
  }

  // --- facet cache ---------------------------------------------------------

  /**
   * Everything one plugin knows about one facet of one title.
   *
   * Rows for plugins that are no longer loaded are NOT filtered here -- the registry
   * owns that judgement, and the resolver applies it. Keeping the rows means a plugin
   * removed and put back is warm again immediately.
   */
  facetContributions(entityId: string, now = new Date().toISOString()): FacetContributionRow[] {
    return this.db
      .query(
        "select * from facet_contribution where entity_id = ? and (expires_at is null or expires_at > ?)",
      )
      .all(entityId, now) as FacetContributionRow[];
  }

  /**
   * Cached rows for ONE facet, read from the other end: by CONTENT rather than by title.
   *
   * `facetContributions` answers "what do we know about this film?"; this answers "which
   * films carry this fact?", which is what a collection node needs -- membership is a
   * provider's answer stored per title, so the page is the reverse of the pane.
   *
   * `contentId` narrows to rows whose facet payload has that `id`, using SQLite's own
   * JSON reader so the filter happens in the query rather than over every parsed row.
   * Omit it to get every row for the facet, which is what a name lookup needs.
   *
   * Only `ok` rows: an `empty` or `failed` contribution carries no payload to match on.
   * Plugin liveness is NOT applied here -- that is the registry's judgement, and
   * `isLiveContribution` in ./facet-resolver owns it for every caller.
   */
  facetContributionsByContentId(
    facet: string,
    contentId?: string,
    now = new Date().toISOString(),
  ): FacetContributionRow[] {
    const live = "facet = ? and outcome = 'ok' and (expires_at is null or expires_at > ?)";
    return contentId === undefined
      ? (this.db
          .query(`select * from facet_contribution where ${live}`)
          .all(facet, now) as FacetContributionRow[])
      : (this.db
          .query(`select * from facet_contribution where ${live} and json_extract(data, '$.id') = ?`)
          .all(facet, now, contentId) as FacetContributionRow[]);
  }

  /**
   * TMDB id -> our tconst, for the ids given, out of `externalIds` rows we already hold.
   *
   * The FREE half of a crosswalk that would otherwise be a fan-out. Recommendations name
   * films by TMDB id and we index by IMDb; asking upstream for each one costs eleven calls
   * per film view against somebody else's infrastructure. Every title anyone has ever
   * opened already stored its own `externalIds`, so the answer is frequently sitting in
   * this table, and coverage grows with use rather than with traffic.
   *
   * An id we have never seen simply is not in the result -- the caller drops it, which is
   * the same rule that already governs a collection member we do not index.
   *
   * `entity_id` is the tconst, so the mapping needs no join: the row's own key IS the
   * answer, and the payload only has to confirm which TMDB id it belongs to.
   */
  tconstsByTmdbId(tmdbIds: readonly number[]): Map<number, string> {
    const out = new Map<number, string>();
    if (tmdbIds.length === 0) return out;

    const wanted = new Set(tmdbIds);
    const rows = this.db
      .query(
        "select entity_id, data from facet_contribution where facet = 'externalIds' and data is not null",
      )
      .all() as { entity_id: string; data: string }[];

    for (const row of rows) {
      try {
        const ids = JSON.parse(row.data) as { tmdb?: number | null };
        if (typeof ids.tmdb === "number" && wanted.has(ids.tmdb)) out.set(ids.tmdb, row.entity_id);
      } catch {
        // A malformed contribution is one missing crosswalk, never a failed page.
      }
    }
    return out;
  }

  /** Write a provider's answer, replacing whatever that plugin said last time. */
  putFacetContribution(row: FacetContributionRow): void {
    this.db.run(
      "insert or replace into facet_contribution " +
        "(entity_id, facet, plugin_id, config_version, outcome, data, freshness, resolved_at, expires_at, reason) " +
        "values (?,?,?,?,?,?,?,?,?,?)",
      [
        row.entity_id,
        row.facet,
        row.plugin_id,
        row.config_version,
        row.outcome,
        row.data,
        row.freshness,
        row.resolved_at,
        row.expires_at,
        row.reason,
      ],
    );
  }

  facetCacheCount(): number {
    return (this.db.query("select count(*) c from facet_contribution").get() as { c: number }).c;
  }

  /**
   * Delete contributions a loaded plugin has SUPERSEDED, and return how many went.
   *
   * `config_version` sits in the primary key so a changed plugin cannot serve its old
   * answers, and `isLiveContribution` makes that true on every read. This is the other half,
   * which never existed: nothing ever deleted the rows the filter steps over. Each plugin
   * edit strands a whole generation of the working set, and `ix_facet_entity` indexes
   * `entity_id` alone, so a lookup for one title walks every dead version of it. Measured on
   * the live container 2026-08-31: 10,647 rows over seven generations of two plugins, up
   * from 5,433 twelve hours earlier, ~86% unreachable.
   *
   * `current` maps plugin id -> the version the registry is RUNNING. Take it from a built
   * registry, never from `loadPlugins` mid-flight, or a plugin that has not registered yet
   * looks like one that is gone.
   *
   * > IT PRUNES ONLY WHAT THE REGISTRY KNOWS, AND THAT ASYMMETRY IS THE POINT.
   * A plugin id absent from `current` is left completely alone, at every version. The
   * registry cannot tell "somebody deleted this plugin" from "this plugin threw on import
   * this boot" -- a broken file never gets far enough to announce its own id. Reaping on
   * absence would therefore wipe a cache that was expensive to fill on precisely the boot
   * where something is already wrong. The cost of the conservative rule is that a genuinely
   * deleted plugin's rows linger; they are invisible to every read path (`isLiveContribution`
   * already refuses them) and they stop growing the moment the plugin stops running, so it is
   * bounded litter rather than the unbounded growth this method exists to end.
   *
   * PURE DELETE. It issues no fetch and asks no provider. The obvious GC -- "for each stranded
   * row, is it still wanted?" -- answers itself by resolving, which turns a cleanup into a
   * crawl of somebody else's infrastructure. Refilling is the paced warm loop's job.
   */
  pruneFacetContributions(current: ReadonlyMap<string, string>): number {
    if (current.size === 0) return 0;

    const stmt = this.db.query("delete from facet_contribution where plugin_id = ? and config_version != ?");
    // One transaction: a half-applied sweep would leave the count in `/api/health`
    // describing a table that no longer matches it.
    return this.db.transaction(() => {
      let pruned = 0;
      for (const [pluginId, version] of current) {
        pruned += stmt.run(pluginId, version).changes;
      }
      return pruned;
    })();
  }

  // --- facet images --------------------------------------------------------

  /**
   * Record the upstream URLs behind a batch of proxy keys.
   *
   * A batch and one transaction because the caller is the render path: rewriting a
   * title's cast and crew is fifty keys, and fifty separate writes is fifty commits for
   * one page view. `insert or ignore` -- a key IS its URL's hash, so a row that exists
   * already says the same thing, and re-stamping `seen_at` would only mean fifty writes
   * on every view of a title we have already seen.
   */
  rememberFacetImages(images: readonly { key: string; url: string }[]): void {
    if (images.length === 0) return;
    const now = new Date().toISOString();
    const ins = this.db.prepare("insert or ignore into facet_image (key, url, seen_at) values (?,?,?)");
    this.db.transaction(() => {
      for (const img of images) ins.run(img.key, img.url, now);
    })();
  }

  /** The upstream URL behind a proxy key, or null for a key we never issued. */
  facetImageUrl(key: string): string | null {
    const row = this.db.query("select url from facet_image where key = ?").get(key) as
      | { url: string }
      | undefined
      | null;
    return row?.url ?? null;
  }

  facetImageCount(): number {
    return (this.db.query("select count(*) c from facet_image").get() as { c: number }).c;
  }
}

/**
 * Pull the studio or network name out of an arr lookup response.
 *
 * Radarr calls it `studio`, Sonarr calls it `network`, and a title can come back from
 * either service regardless of what IMDb thinks it is -- so read whichever is present
 * rather than branching on the expected kind.
 *
 * Known imprecision: the value reflects the metadata proxy's view, which is sometimes
 * the local DISTRIBUTOR rather than the originating network. Barry comes back
 * "Prime Video", not HBO. Acceptable for a badge; do not treat it as authoritative.
 */
export function studioFrom(found: unknown): string | null {
  if (!found || typeof found !== "object") return null;
  const f = found as { network?: unknown; studio?: unknown };
  const name = typeof f.network === "string" ? f.network : typeof f.studio === "string" ? f.studio : null;
  const trimmed = name?.trim();
  return trimmed ? trimmed : null;
}

/**
 * The arr's own "added" timestamp, which both Radarr and Sonarr expose as `added`.
 *
 * Radarr writes `0001-01-01T00:00:00Z` for a title it never actually acquired, and
 * that sorts to the top of an ascending list and the bottom of a descending one while
 * meaning nothing -- so it is treated as absent.
 */
export function addedFrom(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  const added = (item as { added?: unknown }).added;
  if (typeof added !== "string" || added.startsWith("0001-")) return null;
  return added;
}

/** Pull the poster out of an arr `images` array. */
export function posterFrom(images: unknown): string | null {
  if (!Array.isArray(images)) return null;
  for (const img of images as { coverType?: string; remoteUrl?: string; url?: string }[]) {
    if (img?.coverType === "poster" && (img.remoteUrl || img.url)) {
      return (img.remoteUrl ?? img.url) as string;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------

/**
 * Pull both libraries into the mirror.
 *
 * Failures are per-service and non-fatal: if Sonarr is down we still want an accurate
 * picture of Radarr rather than a stale picture of both.
 */
export async function syncLibrary(
  store: Store,
  clients: { radarr?: RadarrClient; sonarr?: SonarrClient },
  log: (m: string) => void = () => {},
): Promise<{ radarr?: number; sonarr?: number; errors: string[] }> {
  const errors: string[] = [];
  const out: { radarr?: number; sonarr?: number; errors: string[] } = {
    errors,
  };

  if (clients.radarr) {
    try {
      const movies = (await clients.radarr.movies()) ?? [];
      out.radarr = store.replaceLibrary(
        "radarr",
        movies.map((m) => ({
          imdb_id: m.imdbId ?? "",
          arr_id: m.id,
          has_file: m.hasFile ? 1 : 0,
          monitored: m.monitored ? 1 : 0,
          progress: m.hasFile ? 1 : 0,
          added_at: addedFrom(m),
        })),
      );
      // Every owned title already carries its artwork AND its studio in the same
      // response -- seeding here costs nothing extra and covers the whole library
      // instantly, so an owned title never waits on an on-demand lookup for either.
      const seeded = store.seedArtwork(
        movies.map((m) => ({
          imdb_id: m.imdbId ?? "",
          url: posterFrom((m as unknown as { images?: unknown }).images),
          studio: studioFrom(m),
        })),
      );
      log(`library: ${out.radarr} movies mirrored${seeded ? `, ${seeded} posters seeded` : ""}`);
    } catch (err) {
      errors.push(`radarr: ${(err as Error).message}`);
    }
  }

  if (clients.sonarr) {
    try {
      const series = (await clients.sonarr.series()) ?? [];
      out.sonarr = store.replaceLibrary(
        "sonarr",
        series.map((s) => ({
          imdb_id: s.imdbId ?? "",
          arr_id: s.id,
          has_file: (s.statistics?.episodeFileCount ?? 0) > 0 ? 1 : 0,
          monitored: s.monitored ? 1 : 0,
          progress: s.statistics ? s.statistics.percentOfEpisodes / 100 : null,
          added_at: addedFrom(s),
        })),
      );
      const seeded = store.seedArtwork(
        series.map((s) => ({
          imdb_id: s.imdbId ?? "",
          url: posterFrom((s as unknown as { images?: unknown }).images),
          studio: studioFrom(s),
        })),
      );
      log(`library: ${out.sonarr} series mirrored${seeded ? `, ${seeded} posters seeded` : ""}`);
    } catch (err) {
      errors.push(`sonarr: ${(err as Error).message}`);
    }
  }

  return out;
}
