/**
 * Application state: the library mirror and the request log.
 *
 * Separate from the title index because the index is REBUILT wholesale every day and
 * this data must survive that. Different lifecycle, different file.
 */

import { Database } from "bun:sqlite";
import type { ConversationStore, ConversationTurn } from "./agent/conversation";
import type { AiCallRow, AiCallSink } from "./ai-spend";
import type { RadarrClient, SonarrClient } from "./arr";
import { applyAuthSchema } from "./auth-store";
import type { AwardPersonClass, AwardPersonTally, Nomination } from "./awards";
import type { Config } from "./config";
import { paths } from "./config";
import type { PlexItem } from "./plex";
import type { RequestDiagnostic } from "./request-diagnostics";
import {
  type ClickRow,
  decodeFilters,
  encodeFilters,
  type SearchLogSink,
  type SearchRow,
} from "./search-log";
import { encodeSeasons } from "./seasons";
import { applyShelfPreferenceSchema } from "./shelf-preferences";
import { type AddedColumn, addMissingColumns } from "./sqlite-columns";
import type { TermPair } from "./terms";
import { applyWatchlistSchema } from "./watchlist";

/**
 * Where the mirrored server's identity lives.
 *
 * In `kv` rather than a column, because it is one fact about the SERVER and a per-row copy
 * would be a thousand copies that can only change together.
 */
const PLEX_MACHINE_KEY = "plex_machine_identifier";

/**
 * The narrow slice of `Store` that anything reaching for `kv` needs, so a caller can be
 * handed a Map in a test and the real store in production.
 *
 * Declared HERE, beside the table, because two subsystems now depend on it -- the plugin
 * registry's scratch space and the first-run latch -- and a second copy of a two-method
 * interface is a second thing to keep in step for no gain.
 */
export interface KeyValueStore {
  getKv(key: string): string | null;
  setKv(key: string, value: string): void;
}

export type RequestStatus =
  | "queued"
  | "sent"
  | "grabbed"
  | "downloading"
  | "available"
  | "failed"
  | "no_release"
  /**
   * The download finished and the arr cannot file it without a person.
   *
   * WRITTEN ONLY FROM A WEBHOOK -- see `./arr-webhook.ts`. It is the one request state
   * finderr cannot reach by polling: the arr's queue reports such an item as completed and
   * the history has nothing to say, so a poller sees a title that stopped moving and can
   * only keep calling it "searching". Seerr shows this class as Processing forever; naming
   * it is the whole reason this state exists.
   *
   * It is an in-flight state rather than a dead end -- `RequestWorker.reconcile` keeps
   * watching it, so the moment somebody sorts the import out by hand the library mirror
   * takes the row to `available` exactly as it would have anyway.
   */
  | "manual_import"
  /**
   * An admin took the media back out of the arr. TERMINAL, and the record of a decision.
   *
   * The row survives the removal instead of being deleted, so `/log` can still say what was
   * asked for and what became of it -- a deleted row would make an admin's deliberate act
   * indistinguishable from a request that was never made. `media_removal` carries who did it.
   *
   * NOTHING moves it: no move set in `./arr-webhook.ts` contains it, and `reconcile` does not
   * list it among the open statuses. The way back is a FRESH ASK -- `createRequest` revives a
   * removed row to `queued`, so the ordinary Request button works and is quota-counted, while
   * the one-click "Try again" on `/requests` is deliberately not offered (it would let anybody
   * undo an admin's removal without asking for it again).
   */
  | "removed";

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
   * 1 when this ask arrived through the requester's agent key, 0 when it came from a
   * browser. SQLite has no boolean.
   *
   * ADMIN-ONLY, and stripped by the same `visibleRequest` for the same reason:
   * `requested_by` says who, this says how, and they are one audit fact seen twice.
   */
  via_agent_key: number;
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
  /**
   * When the person who asked was shown that this arrived, or null for "not yet".
   *
   * The unread marker, and it is a COLUMN rather than a `(user, request)` table because
   * `requested_by` is single-valued: `createRequest` keeps the first asker on a re-request,
   * so exactly one person is ever owed this news about a given row. A join table would be a
   * second way to express a one-to-one fact.
   *
   * Only meaningful while `status = 'available'`. It is set for every row that was already
   * available when the column arrived (see `ADDED_COLUMNS`), so shipping it does not
   * announce a year of history as new.
   */
  available_seen_at: string | null;
}

/**
 * Will a fresh ask for this title WRITE A NEW request row, rather than amending the one
 * already there?
 *
 * True when nothing is held, and true for a `removed` row -- which `createRequest` drops
 * before inserting, so the new ask is a new row in every column that matters.
 *
 * ONE OWNER, because two places have to agree and the failure of disagreeing is silent.
 * `POST /api/requests` exempts a re-ask from the daily quota exactly when the POST writes no
 * new row; if it kept its own `getRequest(...) === null` test, an admin's removal would hand
 * every reader one free request each, forever, on that title.
 */
export function createsNewRequest(held: Pick<MediaRequest, "status"> | null): boolean {
  return held === null || held.status === "removed";
}

/**
 * The dead ends a fresh ask REVIVES IN PLACE. Both of them are "we looked and came back
 * empty-handed", which is a thing that stops being true on its own as indexers gain releases.
 */
const REVIVED_BY_A_FRESH_ASK: ReadonlySet<RequestStatus> = new Set(["failed", "no_release"]);

/**
 * Does a fresh ask for this title put the row ALREADY THERE back on the worker's queue?
 *
 * The other half of `createsNewRequest`, and deliberately its opposite for these two statuses:
 * a `removed` title was taken out by an admin and asking again is a NEW ask that writes a new
 * row and spends a quota slot, while a `failed` or `no_release` title is the SAME ask that
 * never delivered anything. Charging somebody a second time for an indexer having had nothing
 * is a quota that punishes bad luck, so a re-ask here is free and keeps its `created_at` --
 * which is also exactly what `POST /api/requests/:tconst/retry` has always done, and two
 * prices for one act decided by which button the reader found is the drift this pair exists to
 * prevent. (Werk-master ruling, 2026-09-07. If a failed re-ask should ever cost a quota row,
 * this function and `retry` move TOGETHER or the disagreement comes straight back.)
 *
 * Without it the ask is a SILENT NO-OP: `createRequest`'s conflict arm never rewrites `status`,
 * `RequestWorker.process` opens with `if (req.status !== "queued") return`, and the reader gets
 * a `202` echoing the old dead-end status back at them.
 */
export function revivesHeldRequest(held: Pick<MediaRequest, "status"> | null): boolean {
  return held !== null && REVIVED_BY_A_FRESH_ASK.has(held.status);
}

/**
 * One removal, as it happened. Mirrors the `media_removal` table exactly.
 *
 * EVERY FIELD IS A FACT AT THE MOMENT OF REMOVAL and none of them is re-derived later: the
 * arr no longer holds the title, so `bytes` and `arr_id` can never be looked up again. That
 * is what makes this an audit record rather than a cache of one.
 */
export interface MediaRemoval {
  tconst: string;
  title: string;
  service: "radarr" | "sonarr";
  /** The arr row id the item was removed under, kept because the arr no longer has it. */
  arr_id: number;
  /** 1 when the files went with it, 0 when only the arr entry did. SQLite has no boolean. */
  deleted_files: number;
  /** Bytes the arr reported holding, or null when it reported none. */
  bytes: number | null;
  /** The admin who did it, or null for the system key -- which is not a person. */
  removed_by: string | null;
  removed_at: string;
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
  /**
   * The arr's own URL segment for this title, exactly as the arr reports it.
   *
   * Mirrored and never derived -- Radarr 6.x fills `titleSlug` with the tmdbId while
   * Sonarr fills it with a word slug, so no rule computes both. Null for a row written
   * before this column existed; the next full sync fills it.
   */
  title_slug: string | null;
  updated_at: string;
}

/**
 * One library row as a MIRROR WALK offers it -- the stored shape minus what the store fills in.
 *
 * Named rather than spelled inline on `replaceLibrary` because it is now the unit a walk
 * accumulates, and it is what `syncEpisodes` reads its candidates from. That the walk's
 * intermediate list is THIS narrow, and never the arr's own ~5.5 KB record, is the whole memory
 * property of `syncLibrary` -- so the type is worth being able to point at.
 */
export type LibraryMirrorRow = Omit<LibraryEntry, "service" | "updated_at" | "title_slug"> & {
  added_at?: string | null;
  title_slug?: string | null;
};

/** What Sonarr knows about ONE episode of one series we mirror. */
export interface EpisodeEntry {
  imdb_id: string;
  season: number;
  episode: number;
  /** Sonarr's own episode id -- the only handle its monitor and search endpoints take. */
  arr_episode_id: number;
  has_file: number;
  monitored: number;
  /** YYYY-MM-DD, or null for an episode Sonarr has no date for. */
  air_date: string | null;
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
  /** The episode's own name. Series only; null everywhere else. */
  episode_title: string | null;
  /**
   * Do we hold THIS episode? 1 yes, 0 no, null the source cannot say.
   *
   * Only meaningful once the episode has aired -- a future episode is `0` because nobody
   * has it yet, not because anything is wrong. `airedAlready` on the client is what
   * decides whether to draw it, and the Sonarr window looks backwards so that there is
   * something to draw.
   */
  has_file: number | null;
}

/** Who claimed it. One writer each, and each replaces only its own rows. */
export type UpcomingSource = "radarr" | "sonarr" | "tmdb-movie" | "tmdb-series";

/** One title on this week's trending list. See the `trending` table. */
export interface TrendingRow {
  tconst: string;
  kind: string;
  /** TMDB's own rank, 0-based. The ONLY ordering this shelf has; see the table comment. */
  position: number;
}

const SCHEMA = `
-- title_slug is the arr's OWN url segment for the title, mirrored rather than derived.
-- Radarr and Sonarr both route their detail page as /movie/:titleSlug and /series/:titleSlug,
-- but the two fill that field differently -- Radarr 6.x puts the tmdbId there ("700391")
-- while Sonarr puts a word slug ("preacher"), both verified against the live servers on
-- 2026-08-31. So there is nothing to compute from an id we already hold, and a guess would
-- be right for one service and wrong for the other. It rides free on the records the
-- library sync already fetches. NULL on a row mirrored before this column existed.
create table if not exists library (
  imdb_id     text not null,
  service     text not null,
  arr_id      integer not null,
  has_file    integer not null default 0,
  monitored   integer not null default 0,
  progress    real,
  title_slug  text,
  updated_at  text not null,
  primary key (imdb_id, service)
);
create index if not exists ix_library_service on library(service);

-- Sonarr's per-EPISODE state, keyed by OUR id plus the season/episode numbers.
--
-- NOTE: no backticks anywhere in this comment either. SCHEMA is a template literal.
--
-- The episodes a reader sees come from skyhook (the episodes facet), which knows what
-- exists and nothing about what we hold. Sonarr knows what we hold and speaks its own
-- seriesId. The two agree on exactly one thing -- the (season, episode) pair -- so that is
-- the join, and this table is what makes it answerable without a network call on the
-- render path.
--
-- Separate from library for the same reason plex_item is: library is one row per TITLE
-- and this is one row per episode, and no amount of columns makes those one table.
--
-- arr_episode_id is Sonarr's own integer and is the ONLY thing that can be handed back to
-- it when monitoring or searching a single episode -- neither operation takes a season and
-- episode number.
create table if not exists episode (
  imdb_id        text not null,
  season         integer not null,
  episode        integer not null,
  arr_episode_id integer not null,
  has_file       integer not null default 0,
  monitored      integer not null default 0,
  air_date       text,
  updated_at     text not null,
  primary key (imdb_id, season, episode)
);

-- WHEN we last asked Sonarr about a series' episodes, whatever it answered.
--
-- Separate from the rows themselves because "we asked and got nothing" has to be
-- recordable. Deriving the walk time from max(episode.updated_at) reads as never-walked
-- for a series with no episodes, and a never-walked series is always due -- so one empty
-- series would be re-fetched on every single pass, forever. That is the exact hot loop
-- the batching exists to prevent, arriving through the back door.
create table if not exists episode_walk (
  imdb_id   text primary key,
  walked_at text not null
);

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

-- What we have LEARNED about an open request, so a reader can be told why it is slow.
--
-- NOTE: no backticks anywhere in this comment -- SCHEMA is a template literal.
--
-- One row per requested title, written by the reconcile timer and read on the render path
-- like every other mirror here. Separate from the request table rather than more columns on
-- it, because the two have different owners and different lifetimes: a request row is the
-- record of an ASK and every column on it was written by the person who asked, while this is
-- an observation of somebody else's machine, rewritten every thirty seconds. Dropping and
-- refilling this table costs nothing; dropping a request column loses a fact.
--
-- EVIDENCE ONLY. The verdict a reader sees is derived by verdictFor() in
-- request-diagnostics.ts and is deliberately not stored -- see the note on
-- RequestDiagnostic. Every column is nullable and null means "we do not know", which is a
-- different answer from zero and the whole reason the feature can stay honest.
create table if not exists request_diagnostic (
  tconst            text primary key,
  download_progress real,
  eta_at            text,
  grabbed_quality   text,
  indexers_searched integer,
  releases_seen     integer,
  updated_at        text not null
);

-- WHO TOOK WHAT BACK OUT OF THE LIBRARY, and when.
--
-- NOTE: no backticks anywhere in this comment -- SCHEMA is a template literal.
--
-- The one destructive act finderr can perform against somebody else's disk, so it is the one
-- act that keeps a record of itself. A deletion nobody can attribute is worse than no
-- deletion: the request row alone says the media went, and says nothing about who decided.
--
-- Its own table rather than columns on request, for the reason request_diagnostic is its own
-- table: the two have different owners and different lifetimes. A request row is rewritten by
-- the worker on every status change and is deleted outright by a withdraw; this is written
-- once, by a person, and is never rewritten. Keyed on tconst because a title can only be
-- removed once before it has to be asked for again, and the fresh ask overwrites the record
-- of the last removal exactly when it stops describing the present.
--
-- removed_by is a WEAK reference to app_user, with no foreign key, for the same reason
-- request.requested_by declines one: deleting a user must not erase the log of what they did.
-- The name is resolved at read time and shows as (removed) when the account is gone.
create table if not exists media_removal (
  tconst        text primary key,
  title         text not null,
  service       text not null,
  arr_id        integer not null,
  deleted_files integer not null,
  bytes         integer,
  removed_by    text,
  removed_at    text not null
);

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
-- has_file answers "do I have THAT episode", and it is the reason the Sonarr window looks
-- BACKWARDS as well as forwards. Sonarr puts hasFile on every calendar entry at no extra
-- cost, but for a purely future episode it is false by definition and carries no
-- information -- it only says something once the episode has aired or is airing today.
-- NULL means the source does not answer the question at all (Radarr, TMDB).
create table if not exists upcoming (
  tconst        text not null,
  kind          text not null,
  source        text not null,
  date          text not null,
  date_kind     text not null,
  detail        text,
  episode_title text,
  has_file      integer,
  synced_at     text not null,
  primary key (tconst, source)
);
-- episode_title and has_file are in ADDED_COLUMNS as well as here: this block only runs on
-- a database that has never seen the table, and finderr was already deployed with the
-- narrower shape before these two existed.

create index if not exists ix_upcoming_source_date on upcoming(source, date);

-- What is popular RIGHT NOW, mirrored from TMDB on the same timer as upcoming.
--
-- Its own table rather than a fifth upcoming source, and the difference is the whole
-- reason: every row in upcoming is ABOUT A DATE and the table is ordered by it. Trending
-- has no date at all -- it is a ranked list -- so filing it there would mean inventing a
-- date column value that means nothing and then sorting the shelf by the invention.
--
-- position IS the ranking, straight from TMDB's response order, and it is stored rather
-- than derived because nothing in our own corpus approximates it: the IMDb dumps carry
-- numVotes, which measures all-time notability and would put the same great films on a
-- shelf about this week. That is exactly the shelf this replaces.
--
-- Keyed on tconst alone, unlike upcoming: there is one trending list and one source for
-- it, so a title cannot be trending twice.
create table if not exists trending (
  tconst    text primary key,
  kind      text not null,
  position  integer not null,
  synced_at text not null
);

create index if not exists ix_trending_position on trending(position);

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

-- One person's face, under OUR id for them, pointing at a key facet_image already holds.
--
-- WHY THIS TABLE EXISTS. Every headshot finderr holds arrived on some TITLE's cast facet
-- and is keyed by a hash of its URL, so nothing could answer "what does nm0000093 look
-- like?" -- and the people row on /search drew initials for everybody, forever, including
-- for faces sitting in facet_image already. This is the missing edge and nothing more: it
-- stores no bytes and no URL, only the key the proxy route already resolves.
--
-- IT IS A MATERIALISED JOIN, written where both halves are already in hand. The title
-- route resolves a provider's credits to nconsts (personLinks) in the same breath as it
-- rewrites their images to /img/f/<key>, so the pair costs one insert there instead of a
-- scan of every cached cast blob per keystroke here. Runtime beats build time.
--
-- IN THE APP DB, NOT THE INDEX, and that is the decision worth knowing -- the same one
-- award_nomination and plex_item took. titles.db is rebuilt from the IMDb dumps and
-- swapped every night, so anything the builder cannot re-derive vanishes at 09:00; and the
-- builder cannot re-derive this, because no dump carries a headshot. Only api.radarr.video
-- does, one title at a time, which is exactly the sweep the one-click-deep rule forbids.
--
-- SO COVERAGE GROWS WITH USE and is never complete, the same bargain relatedRows takes:
-- a person whose titles nobody has opened has no row and correctly draws initials.
create table if not exists person_image (
  nconst    text primary key,
  image_key text not null,
  seen_at   text not null
);

-- One award nomination, mirrored from a published dataset on its own timer.
--
-- NOTE: no backticks anywhere in this comment. SCHEMA is a template literal.
--
-- IN THE APP DB rather than in the index, and that is the decision worth knowing. The
-- index is rebuilt from the IMDb dumps and swapped in place every night, so anything
-- stored there has to be re-derived by the builder or it disappears at 09:00. Nominations
-- are mirrored external state on a yearly clock, exactly like upcoming and plex_item, so
-- they live where the other mirrors live and survive every rebuild.
--
-- THE KEY IS (award, ceremony, seq), not the (award, ceremony, category, id) the card
-- proposed. Measured against the real file: 528 rows carry neither a FilmId nor a
-- NomineeId -- honorary and special awards, several per ceremony -- so an id cannot be
-- part of a total key. seq is the row's position within its ceremony in SOURCE order,
-- which also gives the category listing a stable tiebreak that is not alphabetical.
--
-- films/film_ids and nominees/nconsts are pipe-joined PARALLEL strings, mirroring how the
-- source carries them. A pair rather than a join table because the printed name is wanted
-- whether or not there is an id behind it: about 1,281 of 12,137 rows carry no FilmId at
-- all and render as plain text. The two lookup tables below are the indexed reverse edge.
create table if not exists award_nomination (
  award        text not null,
  ceremony     integer not null,
  seq          integer not null,
  year         text not null,
  class        text not null,
  category     text not null,
  raw_category text not null,
  films        text not null,
  film_ids     text not null,
  nominees     text not null,
  nconsts      text not null,
  won          integer not null default 0,
  detail       text,
  note         text,
  primary key (award, ceremony, seq)
);
create index if not exists ix_award_ceremony on award_nomination(award, ceremony);
create index if not exists ix_award_category on award_nomination(award, category);

-- The reverse edges: which nominations name this title, and which name this person.
--
-- Separate tables rather than a LIKE over the joined strings, because both are read on a
-- render path -- the title pane and the person page -- and a LIKE '%tt0068646%' is a scan
-- of every nomination we hold. They also handle the multi-id rows honestly: 18 nominations
-- name two or three films at once (one 1928 acting nomination covers three), and a joined
-- string cannot be indexed on either of them.
--
-- Only ids we can actually use land here. The source mixes COMPANY ids (co0007143) into
-- NomineeIds beside the people, and a company is not a person page -- see isPersonId.
create table if not exists award_film (
  award    text not null,
  ceremony integer not null,
  seq      integer not null,
  tconst   text not null,
  primary key (award, ceremony, seq, tconst)
);
create index if not exists ix_award_film_tconst on award_film(tconst);

create table if not exists award_nominee (
  award    text not null,
  ceremony integer not null,
  seq      integer not null,
  nconst   text not null,
  primary key (award, ceremony, seq, nconst)
);
create index if not exists ix_award_nominee_nconst on award_nominee(nconst);

-- What somebody searched for, and what somebody opened. The evidence the scorer is retuned
-- against -- see src/lib/search-log.ts for the whole reasoning, including why the tier is
-- absent from search_log and recovered by replay instead.
--
-- > [!CAUTION] NEITHER TABLE MAY EVER GAIN A COLUMN THAT NAMES A PERSON
-- > No session, no user id, no address. That is the D4 ruling on the tuning card, and it is
-- > the reason these two are safe to keep at all. A row here is about a QUERY.
--
-- The filters column is a fact about the QUERY and is therefore allowed: the four scalars
-- a facet chip applied, as JSON, null when none were. See encodeFilters in
-- src/lib/search-log.ts, which is the only thing that writes this shape.
--
-- No primary key on either, deliberately: two people searching the same thing in the same
-- second are two facts and collapsing them would understate exactly the query that matters
-- most. Both are pruned to a row ceiling rather than to an age -- see pruneSearchLog.
create table if not exists search_log (
  query   text not null,
  at      integer not null,
  results integer not null,
  filters text
);
create index if not exists ix_search_log_at on search_log(at);

-- rank is ZERO-BASED, matching the grid position the browser reported. A click at rank 4 is
-- the ranking failure this table exists to make countable.
create table if not exists search_click (
  query  text not null,
  tconst text not null,
  rank   integer not null,
  tier   text not null,
  at     integer not null
);
create index if not exists ix_search_click_at on search_click(at);

-- THE SINGLE OWNER OF MONEY. What every model call cost, and which day's budget it came out
-- of. The rule that reads it is in src/lib/ai-spend.ts; the daily cap counts THIS TABLE and
-- never a running total of its own -- the same shape per-user-request-quota already landed
-- with, for the same reason: a counter is a second owner of a fact the log already holds.
--
-- NOTE: no backticks anywhere in this comment. SCHEMA is a template literal.
--
-- EVERY OUTCOME WRITES A ROW, including error, max_turns, max_tool_calls and refused. A run
-- that timed out on turn six still spent five turns of tokens, and a cap that ignores
-- failures leaks. A refused row carries usd 0 and exists so "how often are people hitting
-- the wall" is answerable rather than merely guessable.
--
-- > [!IMPORTANT] day IS STORED, NOT DERIVED AT QUERY TIME
-- > It is YYYY-MM-DD in the CONTAINER'S timezone -- a day is a day where the users are, not
-- > in UTC. Deriving it would make every quota check do timezone arithmetic over every row,
-- > and a container whose TZ changed would silently re-bucket its whole history into
-- > different days. Stamping it at write time makes the row say which day it belonged to,
-- > which is a fact about the past and cannot be revised by a later config change.
--
-- No user_id foreign key, matching request.requested_by: deleting a user must not erase the
-- spend they caused, and set null would destroy the attribution an admin is deleting them in
-- order to examine.
create table if not exists ai_call (
  id integer primary key,
  user_id     text not null,
  conv_id     text not null,
  at          text not null,
  day         text not null,
  model       text not null,
  tok_in      integer not null,
  tok_out     integer not null,
  tok_cached  integer not null default 0,
  usd         real    not null,
  ms          integer not null,
  outcome     text not null
);
create index if not exists ix_ai_call_day on ai_call(user_id, day);

-- What the assistant REMEMBERS. One row per completed exchange.
--
-- Separate from ai_call, which is the MONEY. That table answers "what did this cost" and is
-- append-only forever; this one answers "what were we talking about" and is deleted when a
-- reader clears the thread. Same conversation id joins them, and they are still two tables:
-- clearing a chat must not erase the spend it caused, or the daily cap becomes a thing a
-- user can reset by pressing a button.
--
-- ONLY question and answer are kept -- never the tool traffic that produced them. One
-- list_episodes result is kilobytes of JSON and replaying it on every later turn is a
-- six-figure token count in front of a model that can simply ask again. See
-- src/lib/agent/conversation.ts for the whole reasoning.
--
-- NOTE: no backticks in this comment. SCHEMA is a template literal.
create table if not exists ai_message (
  id integer primary key,
  user_id  text not null,
  conv_id  text not null,
  question text not null,
  answer   text not null,
  at       text not null
);
-- Scoped by USER as well as conversation: the id is a UUID the CLIENT sends, so it is not a
-- secret. Without the user in the key, a guessed id would replay somebody else's chat.
create index if not exists ix_ai_message_conv on ai_message(user_id, conv_id, id);
`;

/**
 * Columns added to THIS file's tables after the first release. The auth tables keep their
 * own list beside their own schema (`AUTH_ADDED_COLUMNS`), and both are applied by
 * `addMissingColumns`.
 */
const ADDED_COLUMNS: AddedColumn[] = [
  { table: "artwork", column: "studio", ddl: "alter table artwork add column studio text" },
  // The episode's own name ("And the Toy Phone"), and whether we HOLD that episode.
  // Both ride free on Sonarr's calendar entry. A row written before these existed reads
  // back null, which renders as a card with a date and no episode line -- the previous
  // behaviour, and the next sync fills it in within a minute either way.
  {
    table: "upcoming",
    column: "episode_title",
    ddl: "alter table upcoming add column episode_title text",
  },
  { table: "upcoming", column: "has_file", ddl: "alter table upcoming add column has_file integer" },
  // When the arr first acquired the title. NOT the same as `updated_at`, which the
  // 60s mirror rewrites on every row every time -- useless for "recently added".
  { table: "library", column: "added_at", ddl: "alter table library add column added_at text" },
  // The arr's own URL segment for the title. Null on every row mirrored before this
  // existed, which costs an admin the "Open in ..." link on that title for up to one
  // library refresh -- the next full sync writes it.
  {
    table: "library",
    column: "title_slug",
    ddl: "alter table library add column title_slug text",
  },
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
  /*
    WHEN THE ASKER WAS TOLD IT ARRIVED. Null means they have not been.

    THE BACKFILL IS THE WHOLE POINT OF THE COLUMN LANDING QUIETLY. Every request this
    instance has ever completed is already `available`, and without the update below all of
    them would read as unseen the moment this build starts -- a badge counting a year of
    history, on an instance where nothing has changed. `updated_at` is the closest honest
    stamp for "this was already old news".
  */
  {
    table: "request",
    column: "available_seen_at",
    ddl: "alter table request add column available_seen_at text",
    backfill: "update request set available_seen_at = updated_at where status = 'available'",
  },
  /*
    DID THIS ASK ARRIVE THROUGH AN AGENT KEY? Integer, because SQLite has no boolean.

    No backfill and none possible: every request written before agent keys existed came from
    a browser, and the default of 0 says exactly that. It is a fact about the MECHANISM and
    not a second requester -- `requested_by` still names the person, because an agent key
    carries one person's authority and nobody else's.

    > [!CAUTION] Admin-only on the way out, with `requested_by`
    > `visibleRequest` in `./auth.ts` strips both for anybody who is not an admin. They are
    > one audit fact seen from two angles, and splitting the audiences would be a second
    > privacy rule with a second owner.
  */
  {
    table: "request",
    column: "via_agent_key",
    ddl: "alter table request add column via_agent_key integer not null default 0",
  },
  /*
    WHICH FACET CHIPS WERE NARROWING A SEARCH. JSON of the four declared scalars, or null.

    NO BACKFILL, AND NONE IS POSSIBLE. A row written before this column genuinely does not
    know whether a chip was applied, and null is the honest answer -- defaulting it to "no
    filters" would invent evidence for the one question the column exists to answer.

    > [!CAUTION] The four DECLARED scalars, never a spread of the request
    > `genre`, `decade`, `year`, `kind` and nothing else. It is a fact about the query, which
    > is what D4 permits; the next field somebody wants here is another ruling.
  */
  { table: "search_log", column: "filters", ddl: "alter table search_log add column filters text" },
];

export class Store implements SearchLogSink, AiCallSink, ConversationStore {
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
    // Identity, declared next to the identity rules -- and migrated by the same call the
    // tests use, so the ALTERs are not a path that first runs against the live file.
    applyAuthSchema(this.db);
    // AFTER the auth schema, never before: `watchlist` cascades off `app_user`, and SQLite
    // resolves a foreign key at INSERT time -- so the wrong order here fails on somebody's
    // first save rather than here. See `WATCHLIST_SCHEMA`.
    applyWatchlistSchema(this.db);
    // Same rule, same reason: `shelf_pref` cascades off `app_user`. See
    // `SHELF_PREFERENCE_SCHEMA`.
    applyShelfPreferenceSchema(this.db);
    addMissingColumns(this.db, ADDED_COLUMNS);
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
  replaceLibrary(service: "radarr" | "sonarr", rows: readonly LibraryMirrorRow[]): number {
    const now = new Date().toISOString();
    const ins = this.db.prepare(
      "insert or replace into library (imdb_id, service, arr_id, has_file, monitored, progress, updated_at, added_at, title_slug) values (?,?,?,?,?,?,?,?,?)",
    );
    this.db.run("begin");
    try {
      this.db.run("delete from library where service = ?", [service]);
      for (const r of rows) {
        if (!r.imdb_id) continue; // no IMDb id = we can never match it to the index
        ins.run(
          r.imdb_id,
          service,
          r.arr_id,
          r.has_file,
          r.monitored,
          r.progress,
          now,
          r.added_at ?? null,
          r.title_slug ?? null,
        );
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

  /**
   * Drop ONE title from the mirror, because the arr has just stopped holding it.
   *
   * The mirror is otherwise swapped wholesale by `replaceLibrary` on a 60-second timer, and
   * waiting for that timer after a removal would leave every card, every shelf and the
   * "already in your library" refusal claiming a file that has been deleted -- for a minute,
   * on a page the person who deleted it is looking at. This is not a second owner of the
   * mirror: the next full sync still decides, and it will agree.
   */
  forgetLibraryEntry(imdbId: string): void {
    this.db.run("delete from library where imdb_id = ?", [imdbId]);
  }

  /** The whole mirror as a lookup map. Small enough to hold; ~1400 rows here. */
  libraryMap(): Map<string, LibraryEntry> {
    const rows = this.db.query("select * from library").all() as LibraryEntry[];
    return new Map(rows.map((r) => [r.imdb_id, r]));
  }

  libraryCount(): { radarr: number; sonarr: number; episodes: number } {
    const q = (s: string) =>
      (this.db.query("select count(*) c from library where service = ?").get(s) as { c: number }).c;
    return { radarr: q("radarr"), sonarr: q("sonarr"), episodes: this.episodeCount() };
  }

  // --- episode mirror ------------------------------------------------------

  /**
   * Replace the episode mirror for ONE series.
   *
   * Per series rather than wholesale, because the walk is per series: Sonarr answers
   * `/episode?seriesId=` and nothing asks it for every episode it holds. So a series whose
   * fetch failed keeps the rows it had instead of being emptied by somebody else's success
   * -- the same rule the Plex mirror follows, applied one series at a time.
   *
   * A full swap WITHIN the series is still right: an episode Sonarr no longer lists (a
   * renumbered special, a removed entry) must stop claiming we hold it.
   */
  replaceEpisodes(imdbId: string, rows: Omit<EpisodeEntry, "imdb_id" | "updated_at">[]): number {
    const now = new Date().toISOString();
    const ins = this.db.prepare(
      "insert or replace into episode (imdb_id, season, episode, arr_episode_id, has_file, monitored, air_date, updated_at) values (?,?,?,?,?,?,?,?)",
    );
    this.db.run("begin");
    try {
      this.db.run("delete from episode where imdb_id = ?", [imdbId]);
      for (const r of rows) {
        ins.run(imdbId, r.season, r.episode, r.arr_episode_id, r.has_file, r.monitored, r.air_date, now);
      }
      // Inside the same transaction as the rows it describes: a walk that half-wrote and
      // rolled back must not be able to claim it happened.
      this.db.run("insert or replace into episode_walk (imdb_id, walked_at) values (?,?)", [imdbId, now]);
      this.db.run("commit");
    } catch (err) {
      this.db.run("rollback");
      throw err;
    }
    return (this.db.query("select count(*) c from episode where imdb_id = ?").get(imdbId) as { c: number }).c;
  }

  /** Every episode we mirror for one series, keyed `"<season>:<episode>"`. */
  episodeMap(imdbId: string): Map<string, EpisodeEntry> {
    const rows = this.db.query("select * from episode where imdb_id = ?").all(imdbId) as EpisodeEntry[];
    return new Map(rows.map((r) => [`${r.season}:${r.episode}`, r]));
  }

  /**
   * The episodes we mirror for SEVERAL series at once, keyed by imdb id.
   *
   * ONE query for a whole page of request rows, rather than `episodeMap` per row. The
   * request list is served on a route the shell polls every eight seconds, so a per-row
   * query there is 200 statements every eight seconds for as long as anybody has a tab open
   * -- the same reason `requestDiagnosticMap` and `plexMap` exist beside their single-row
   * twins. `imdb_id` leads the primary key, so the `in` is an index scan per id and not a
   * table walk.
   *
   * Series with nothing mirrored are simply absent from the map: a caller asking about a
   * film gets no entry, which is the honest answer and not an empty list pretending to be one.
   */
  episodesForSeries(imdbIds: readonly string[]): Map<string, EpisodeEntry[]> {
    const byId = new Map<string, EpisodeEntry[]>();
    if (imdbIds.length === 0) return byId;

    const rows = this.db
      .query(`select * from episode where imdb_id in (${imdbIds.map(() => "?").join(",")})`)
      .all(...imdbIds) as EpisodeEntry[];
    for (const row of rows) {
      const existing = byId.get(row.imdb_id);
      if (existing) existing.push(row);
      else byId.set(row.imdb_id, [row]);
    }
    return byId;
  }

  /** One episode, or null when Sonarr has never listed it for us. */
  getEpisode(imdbId: string, season: number, episode: number): EpisodeEntry | null {
    return (
      (this.db
        .query("select * from episode where imdb_id = ? and season = ? and episode = ?")
        .get(imdbId, season, episode) as EpisodeEntry | undefined) ?? null
    );
  }

  /**
   * Which mirrored series are due an episode walk, neediest first.
   *
   * > [!IMPORTANT] This exists because the episode mirror costs ONE CALL PER SERIES
   * > Sonarr's `/episode` takes a `seriesId`, so there is no "everything" form. Walking
   * > every series on the 60-second library timer is one request per series per minute --
   * > roughly 600 a minute on a real library, forever, for a fact that changes when a file
   * > lands. So the walk is a SLICE of the stale ones rather than the whole library, and
   * > this query is what picks the slice.
   *
   * Never-walked first (`updated_at is null` sorts first), then oldest. That ordering is
   * the useful half: a series added a minute ago, or a first boot with an empty mirror,
   * fills in on the next tick or two instead of waiting out a full cycle.
   */
  seriesNeedingEpisodeRefresh(limit: number, staleBefore: string): string[] {
    return (
      this.db
        .query(
          `select l.imdb_id as imdb_id, w.walked_at as walked_at
             from library l
             left join episode_walk w on w.imdb_id = l.imdb_id
            where l.service = 'sonarr'
              and (w.walked_at is null or w.walked_at < ?)
            order by w.walked_at is not null, w.walked_at
            limit ?`,
        )
        .all(staleBefore, limit) as { imdb_id: string }[]
    ).map((r) => r.imdb_id);
  }

  /**
   * Mark episodes monitored in the mirror, right after Sonarr accepted the same change.
   *
   * OPTIMISTIC, and it is what makes the slow walk above acceptable: the row a reader is
   * looking at stops offering a button they already pressed, immediately, instead of
   * waiting hours for its series to come round again. Not a second source of truth -- the
   * next walk overwrites it with whatever Sonarr says.
   */
  markEpisodesMonitored(imdbId: string, arrEpisodeIds: readonly number[]): number {
    if (arrEpisodeIds.length === 0) return 0;
    const placeholders = arrEpisodeIds.map(() => "?").join(",");
    this.db.run(
      `update episode set monitored = 1, updated_at = ? where imdb_id = ? and arr_episode_id in (${placeholders})`,
      [new Date().toISOString(), imdbId, ...arrEpisodeIds],
    );
    return arrEpisodeIds.length;
  }

  episodeCount(): number {
    return (this.db.query("select count(*) c from episode").get() as { c: number }).c;
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
      "insert or replace into upcoming " +
        "(tconst, kind, source, date, date_kind, detail, episode_title, has_file, synced_at) " +
        "values (?,?,?,?,?,?,?,?,?)",
    );
    this.db.run("begin");
    try {
      this.db.run("delete from upcoming where source = ?", [source]);
      for (const r of rows) {
        if (!r.tconst || !r.date) continue;
        ins.run(
          r.tconst,
          r.kind,
          source,
          r.date,
          r.date_kind,
          r.detail ?? null,
          r.episode_title ?? null,
          r.has_file ?? null,
          now,
        );
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
        "select tconst, kind, source, date, date_kind, detail, episode_title, has_file " +
          "from upcoming where source = ? order by date asc limit ?",
      )
      .all(source, limit) as UpcomingRow[];
  }

  upcomingCount(source?: UpcomingSource): number {
    const row = source
      ? this.db.query("select count(*) c from upcoming where source = ?").get(source)
      : this.db.query("select count(*) c from upcoming").get();
    return (row as { c: number }).c;
  }

  // --- trending mirror -----------------------------------------------------

  /**
   * Swap the whole trending list.
   *
   * A FULL swap, unlike `replaceUpcoming`'s per-source one, because there is exactly one
   * writer and one list: "what is popular this week" is a single answer, and a title that
   * has fallen off it has to leave the shelf. Same protection as every other mirror here
   * -- a sync that THREW must not reach this method, or an upstream blip empties a shelf
   * that was working a minute ago.
   *
   * An empty `rows` is therefore a deliberate, successful "nothing matched", and it does
   * clear the table. That is the legacy-agent shape `syncPlex` documents: the caller is
   * what tells a real emptiness from a failed walk.
   */
  replaceTrending(rows: TrendingRow[]): number {
    const now = new Date().toISOString();
    const ins = this.db.prepare(
      "insert or replace into trending (tconst, kind, position, synced_at) values (?,?,?,?)",
    );
    this.db.run("begin");
    try {
      this.db.run("delete from trending");
      for (const r of rows) {
        if (!r.tconst) continue;
        ins.run(r.tconst, r.kind, r.position, now);
      }
      this.db.run("commit");
    } catch (err) {
      this.db.run("rollback");
      throw err;
    }
    this.setKv("trending_synced", now);
    return this.trendingCount();
  }

  /** The list in TMDB's own order, which is the only order it has. */
  trending(limit = 30): TrendingRow[] {
    return this.db
      .query("select tconst, kind, position from trending order by position asc limit ?")
      .all(limit) as TrendingRow[];
  }

  trendingCount(): number {
    return (this.db.query("select count(*) c from trending").get() as { c: number }).c;
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
     * Did this arrive through the asker's AGENT KEY rather than from a browser?
     *
     * Audit metadata beside `requested_by`, never a second requester: the row still records
     * a PERSON, because an agent key carries one person's authority and nobody else's. It is
     * stripped for non-admins by `visibleRequest` for exactly that reason.
     */
    viaAgentKey?: boolean;
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

      `via_agent_key` is on the first side of that line, with `requested_by`: it records how
      the ask arrived, and re-asking from a browser did not change how it arrived the first
      time.
    */
    /*
      A REMOVED TITLE IS ASKED FOR AFRESH, so its old row goes rather than being amended.

      This is what makes an admin's removal reversible at all. `RequestWorker.process` refuses
      to run for anything that is not `queued`, so an upsert onto a `removed` row would enqueue
      a job that is silently dropped -- the reader presses Request and nothing ever happens.
      And amending it in place would leave a row that is half the old ask: a stale `arr_id`
      pointing at a library row the arr no longer has, a `search_attempts` count that sends the
      reconcile pass straight to `no_release`, and somebody else's name on a request they did
      not make this time.

      The AUDIT of the removal is not in this row and does not go with it -- `media_removal`
      keeps who removed what, and is written once and never by this method.

      No other terminal state is dropped here, because every other one already has the "Try
      again" control on `/requests` reaching `POST /api/requests/:tconst/retry`. `removed` is
      deliberately the one that does not: undoing an admin's decision should cost a real,
      quota-counted request rather than one click. See `RequestStatus.removed`.

      The other two dead ends are REVIVED rather than dropped, below the upsert -- see
      `revivesHeldRequest` for why the treatment differs.
    */
    const held = this.getRequest(r.tconst);
    if (held && createsNewRequest(held)) this.deleteRequest(r.tconst);
    this.db.run(
      "insert into request (tconst,title,year,kind,service,status,seasons,requested_by,via_agent_key," +
        "quality_profile_id,root_folder_path,search_on_add,created_at,updated_at) " +
        "values (?,?,?,?,?,?,?,?,?,?,?,?,?,?) " +
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
        r.viaAgentKey ? 1 : 0,
        o.qualityProfileId ?? null,
        o.rootFolderPath ?? null,
        searchOnAdd,
        now,
        now,
      ],
    );
    // AFTER the upsert, because the conflict arm deliberately leaves `status` alone -- see
    // the comment on it. This is the one status a second ask is allowed to move, and moving
    // it is what stops the ask being a silent no-op.
    if (revivesHeldRequest(held)) this.requeueRequest(r.tconst);
    return this.getRequest(r.tconst) as MediaRequest;
  }

  /**
   * Put a request that already exists back on the worker's queue for another attempt.
   *
   * ONE OWNER of what a second attempt resets, because there are two doors into it -- a fresh
   * ask on a `failed`/`no_release` row (`createRequest` above) and the "Try again" button
   * (`POST /api/requests/:tconst/retry`) -- and they must not be able to disagree about it.
   *
   * `search_attempts` goes back to zero, and that is the half a caller would forget. The
   * counter is how many times we have looked for a release for the attempt IN PROGRESS, and
   * `RequestWorker.reconcile` gives up once it passes nine on a row older than a day. Leaving
   * a revived row on the old count means the very next reconcile pass -- about thirty seconds
   * later -- takes it straight back to `no_release`, so the re-queue would be true for half a
   * minute and then undone, which is the same silent nothing from the reader's side.
   *
   * `created_at` and `requested_by` are untouched: this is the SAME ask trying again, so it
   * keeps its place in `/log` and the name of whoever made it.
   */
  requeueRequest(tconst: string): void {
    this.updateRequest(tconst, { status: "queued", error: null, search_attempts: 0 });
  }

  getRequest(tconst: string): MediaRequest | null {
    return (
      (this.db.query("select * from request where tconst = ?").get(tconst) as MediaRequest | undefined) ??
      null
    );
  }

  /**
   * The request an arr's own row id belongs to, for a caller that has no `tconst`.
   *
   * The webhook fallback (`../server/arr-webhook.ts`): a Radarr movie or a Sonarr series may
   * hold no IMDb id at all, and then the arr's id is the only handle in the payload. Scoped
   * by SERVICE because the two arrs number their rows independently -- Radarr movie 42 and
   * Sonarr series 42 are unrelated, and a lookup on the id alone would occasionally file an
   * event against somebody else's request.
   *
   * Newest activity first, for the same reason `arr_id` is not unique: a title deleted from
   * an arr and re-added keeps its old request row until it is re-requested.
   */
  requestByArrId(service: MediaRequest["service"], arrId: number): MediaRequest | null {
    return (
      (this.db
        .query("select * from request where service = ? and arr_id = ? order by updated_at desc limit 1")
        .get(service, arrId) as MediaRequest | undefined) ?? null
    );
  }

  updateRequest(
    tconst: string,
    patch: Partial<
      Pick<MediaRequest, "status" | "arr_id" | "error" | "search_attempts" | "available_seen_at">
    >,
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

  /**
   * Forget one request entirely -- the ask and everything observed about it. A title with no
   * row is already in the desired state, so this is a no-op rather than an error.
   *
   * > [!IMPORTANT] The DIAGNOSTIC goes in the same transaction, because it is keyed on the
   * > same title and nothing else would ever collect it
   * > `request_diagnostic` has no foreign key -- nothing in this schema outside the auth
   * > tables does -- and every writer of it is the reconcile pass, which only ever walks
   * > OPEN REQUEST ROWS. So a diagnostic left behind by a deleted request is written by
   * > nobody, read by nobody and freed by nobody: it would sit there claiming a download
   * > was 40% done until the same title was requested again and the row was overwritten.
   *
   * This is the ONE place a `request` row is destroyed. Everything else in this file writes
   * or amends one, which is why the quota can be derived from the log -- see
   * `countRequestsSince`, whose count this deletion is what frees.
   */
  deleteRequest(tconst: string): void {
    this.db.run("begin");
    try {
      this.db.run("delete from request where tconst = ?", [tconst]);
      this.db.run("delete from request_diagnostic where tconst = ?", [tconst]);
      this.db.run("commit");
    } catch (err) {
      this.db.run("rollback");
      throw err;
    }
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

  // --- what one person asked for, and what they have not been told about yet ----------
  //
  // The three below are the whole of the unread-marker feature's storage. They are the only
  // queries in this file that filter on `requested_by`, other than the quota's count, and
  // they exist because the ANSWER differs per reader: `listRequests` is the log, and "is
  // mine ready" is a question about one person.

  /** One person's own requests, newest activity first. */
  listRequestsFor(userId: string, limit = 200): MediaRequest[] {
    return this.db
      .query("select * from request where requested_by = ? order by updated_at desc limit ?")
      .all(userId, limit) as MediaRequest[];
  }

  /**
   * How many of this person's requests have arrived without them being shown.
   *
   * BATCHED PER REQUEST, WHICH IS FREE HERE AND IS THE RULE THAT MATTERS. A `request` row is
   * one title however many seasons or episodes it turns into, so a season pack finishing
   * counts once. Counting files would count twenty times, which is the failure mode a
   * notification feature has to be designed away from rather than filtered after.
   */
  countUnseenAvailable(userId: string): number {
    const row = this.db
      .query(
        "select count(*) c from request where requested_by = ? and status = 'available' and available_seen_at is null",
      )
      .get(userId) as { c: number };
    return row.c;
  }

  /**
   * Where one person stands, in three numbers, from ONE pass over their rows.
   *
   * `/account` leads with these -- how much have I asked for, how much is still coming, how
   * much is waiting for me -- and before this the page could not say any of it. The figures
   * existed only on `/api/admin/users/:id`, so a reader had to ask an administrator to learn
   * something about themselves.
   *
   * > [!IMPORTANT] ONE QUERY, GROUPED, rather than three counts or a `listRequestsFor` in memory
   * > `listRequestsFor` caps at 200 by default, so counting its result would silently under-
   * > report the moment somebody passed that -- a stat that is wrong only for your heaviest
   * > users is worse than no stat. Three separate `count(*)`s would be three scans of the same
   * > rows for one answer.
   * >
   * > No index, for the reason `countRequestsSince` states at length: this table holds one row
   * > per title ANYBODY has ever asked for, which is thousands at the very most, and
   * > `requested_by` arrives through `ADDED_COLUMNS` where no index can be declared.
   *
   * `inFlight` is every state that is still moving, taken from `RequestStatus` rather than
   * from a list typed out here -- `failed` and `no_release` have stopped, `available` has
   * arrived, and everything else is on its way. A status added later is in flight by default,
   * which is the safe direction: a new state showing up as "still coming" is a stat that is
   * briefly vague, and one showing up nowhere is a stat that silently loses rows.
   */
  ownActivity(userId: string): { requested: number; inFlight: number; ready: number } {
    const row = this.db
      .query(
        `select
           count(*) as requested,
           sum(case when status not in ('available','failed','no_release') then 1 else 0 end) as inFlight,
           sum(case when status = 'available' and available_seen_at is null then 1 else 0 end) as ready
         from request where requested_by = ?`,
      )
      .get(userId) as { requested: number; inFlight: number | null; ready: number | null };
    // `sum()` over no rows is NULL rather than 0, which would render as an empty cell.
    return { requested: row.requested, inFlight: row.inFlight ?? 0, ready: row.ready ?? 0 };
  }

  /**
   * Mark every arrival this person has not been shown, and say how many that was.
   *
   * All of them at once rather than one at a time: the reader is looking at the list, so
   * everything on it has been seen. A per-row acknowledgement would need the client to
   * report what was on screen, which is a claim the server cannot check.
   */
  markAvailableSeen(userId: string): number {
    const now = new Date().toISOString();
    // `run` reports its own row count, which is the honest number for "how many were
    // still unread when you opened the list" -- a count taken before the update would be a
    // second read that another reconcile pass could change in between.
    const { changes } = this.db.run(
      "update request set available_seen_at = ? where requested_by = ? and status = 'available' and available_seen_at is null",
      [now, userId],
    );
    return Number(changes);
  }

  /**
   * How many titles this user has asked for since `sinceIso`. The daily quota reads this.
   *
   * > [!IMPORTANT] The quota is DERIVED from the request log, and has no counter of its own
   * > `request` already records who asked (`requested_by`) and when (`created_at`), and the
   * > table is uniquely keyed on `tconst`. So counting rows answers "how many titles has
   * > this person asked for today" exactly -- and a
   * > `request_quota` table or a daily-count column on `user` would be a second copy of a
   * > fact that already has an owner, free to drift from the log an admin actually reads,
   * > and needing a nightly sweep nothing else in this schema has.
   * >
   * > It also makes the quota rule true by construction rather than by arithmetic: a series
   * > requested with three seasons is ONE row, and re-requesting something already queued
   * > upserts rather than inserting, so neither spends a second unit.
   * >
   * > **Being derived is also what makes WITHDRAWING refund the day's allowance**, with no
   * > code here to do it: `deleteRequest` removes the row and this count drops by one on the
   * > next read. A stored counter would have needed a decrement, in a second place, that
   * > somebody had to remember to write.
   *
   * `created_at` is the FIRST ask and the conflict arm of `createRequest` deliberately does
   * not move it, so re-requesting a title first asked yesterday costs nothing today. That is
   * the behaviour worth having: the title is already queued, and nothing new is being asked
   * of the arrs.
   *
   * No index on `(requested_by, created_at)`: this table holds one row per title anybody has
   * ever asked for -- thousands at the very most -- and every index in this schema is
   * declared in `SCHEMA`, while `requested_by` arrives through `ADDED_COLUMNS` and does not
   * exist yet when `SCHEMA` runs. One here would need a second place indexes are declared.
   */
  countRequestsSince(userId: string, sinceIso: string): number {
    const row = this.db
      .query("select count(*) c from request where requested_by = ? and created_at >= ?")
      .get(userId, sinceIso) as { c: number };
    return row.c;
  }

  // --- what was taken back out ---------------------------------------------
  //
  // The audit half of `../server/remove-media.ts`. Written once per removal, by a person,
  // and never rewritten -- see the `media_removal` comment in SCHEMA for why it is its own
  // table rather than columns on `request`.

  /**
   * Record that an admin removed one title's media.
   *
   * An UPSERT rather than an insert, because the key is the title and a title can be removed,
   * asked for again and removed again. Only the latest removal is kept: the earlier one
   * describes media that was replaced by a request anybody can see in the log, and an
   * append-only history here would be a second, unbounded log of an event that already has one.
   */
  recordMediaRemoval(r: Omit<MediaRemoval, "removed_at"> & { removed_at?: string }): void {
    this.db.run(
      "insert into media_removal (tconst,title,service,arr_id,deleted_files,bytes,removed_by,removed_at) " +
        "values (?,?,?,?,?,?,?,?) on conflict(tconst) do update set title=excluded.title, " +
        "service=excluded.service, arr_id=excluded.arr_id, deleted_files=excluded.deleted_files, " +
        "bytes=excluded.bytes, removed_by=excluded.removed_by, removed_at=excluded.removed_at",
      [
        r.tconst,
        r.title,
        r.service,
        r.arr_id,
        r.deleted_files,
        r.bytes,
        r.removed_by,
        r.removed_at ?? new Date().toISOString(),
      ],
    );
  }

  getMediaRemoval(tconst: string): MediaRemoval | null {
    return (
      (this.db.query("select * from media_removal where tconst = ?").get(tconst) as
        | MediaRemoval
        | undefined) ?? null
    );
  }

  /**
   * Every removal as a lookup map, for a whole page of request rows at once.
   *
   * The same shape and the same reason as `requestDiagnosticMap`: `/api/requests` serves up
   * to 200 rows on a route the shell polls, so a per-row read would be 200 statements every
   * eight seconds. The table holds one row per title ever removed, which is far smaller than
   * the request log it annotates.
   */
  removalMap(): Map<string, MediaRemoval> {
    const rows = this.db.query("select * from media_removal").all() as MediaRemoval[];
    return new Map(rows.map((r) => [r.tconst, r]));
  }

  // --- the AI ledger -------------------------------------------------------

  /**
   * Append one model call. `Store` IS the `AiCallSink`, as it is the `SearchLogSink`.
   *
   * Append-only and never updated: a row is what one call cost, which is a fact about the
   * past. Nothing amends it, so there is no version of this table in which the day's total
   * can disagree with the calls that made it.
   */
  recordAiCall(r: AiCallRow): void {
    this.db.run(
      `insert into ai_call (user_id, conv_id, at, day, model, tok_in, tok_out, tok_cached, usd, ms, outcome)
       values (?,?,?,?,?,?,?,?,?,?,?)`,
      [r.userId, r.convId, r.at, r.day, r.model, r.tokIn, r.tokOut, r.tokCached, r.usd, r.ms, r.outcome],
    );
  }

  /**
   * What this person has spent on the given local day. The quota's only input.
   *
   * `sum()` over an empty set is SQL NULL rather than 0, so the coalesce is the difference
   * between "spent nothing today" and a NaN that compares false against every limit and
   * silently opens the gate. `day` is matched as a stored string -- see the `ai_call`
   * comment in SCHEMA for why it is not derived here.
   */
  // --- what the assistant remembers -------------------------------------

  /**
   * The last `limit` exchanges of one conversation, OLDEST FIRST.
   *
   * The subquery takes the newest rows and the outer select puts them back in order, because
   * a model reads a conversation forwards and `order by id desc limit ?` would hand it the
   * thread backwards -- which reads as coherent English and is completely wrong.
   */
  conversationTurns(userId: string, convId: string, limit: number): ConversationTurn[] {
    return this.db
      .query(
        `select question, answer, at from (
           select id, question, answer, at from ai_message
           where user_id = ? and conv_id = ? order by id desc limit ?
         ) order by id asc`,
      )
      .all(userId, convId, Math.max(1, limit)) as ConversationTurn[];
  }

  appendConversationTurn(userId: string, convId: string, turn: ConversationTurn): void {
    this.db.run("insert into ai_message (user_id, conv_id, question, answer, at) values (?,?,?,?,?)", [
      userId,
      convId,
      turn.question,
      turn.answer,
      turn.at,
    ]);
  }

  /**
   * Forget one conversation.
   *
   * The client's "clear" has to reach HERE and not only localStorage: wiping the browser's
   * copy while the server still replays the thread would give a reader a blank panel and a
   * model that remembers everything they just cleared -- the exact opposite of what the
   * button says it does.
   */
  clearConversation(userId: string, convId: string): void {
    this.db.run("delete from ai_message where user_id = ? and conv_id = ?", [userId, convId]);
  }

  aiSpendUsd(userId: string, day: string): number {
    const row = this.db
      .query("select coalesce(sum(usd), 0) s from ai_call where user_id = ? and day = ?")
      .get(userId, day) as { s: number };
    return row.s;
  }

  /**
   * IMDb ids of the most recently requested titles, newest first.
   *
   * Ordered by `created_at` -- when it was ASKED FOR -- and never by `updated_at`, which the
   * worker rewrites on every status change: a request retrying its way through a stalled
   * download would otherwise keep jumping back to the head of the shelf and read as newer
   * than requests made after it. `id` breaks the tie, because ISO timestamps collide for two
   * requests made in the same millisecond and a shelf whose order reshuffles between loads is
   * worse than one that is merely imperfect.
   *
   * EVERY status is included, deliberately. `failed` and `no_release` are exactly the
   * requests worth surfacing again -- a title with no copy last week may have one now -- and
   * they appear nowhere else on the front page.
   *
   * Not filtered by `requested_by` either: this answers "what has been asked for", which is
   * what the front page shows, and `listRequestsFor` above is the per-person question.
   */
  recentlyRequestedIds(limit = 24): string[] {
    return (
      this.db.query("select tconst from request order by created_at desc, id desc limit ?").all(limit) as {
        tconst: string;
      }[]
    ).map((r) => r.tconst);
  }

  requestMap(): Map<string, MediaRequest> {
    const rows = this.db.query("select * from request").all() as MediaRequest[];
    return new Map(rows.map((r) => [r.tconst, r]));
  }

  // --- request diagnostics ---------------------------------------------------

  /**
   * Record what the reconcile pass learned about one request.
   *
   * A WHOLE-ROW replace rather than a patch of the fields that changed, because the
   * observation is whole: a title that has left the arr's queue must lose its progress and
   * its ETA in the same write that notices, or the page keeps drawing a bar for a download
   * that stopped. Every caller passes everything it knows, and "we no longer know" is
   * written as null.
   */
  upsertRequestDiagnostic(d: Omit<RequestDiagnostic, "updated_at">): void {
    this.db.run(
      "insert into request_diagnostic (tconst,download_progress,eta_at,grabbed_quality," +
        "indexers_searched,releases_seen,updated_at) values (?,?,?,?,?,?,?) " +
        "on conflict(tconst) do update set download_progress=excluded.download_progress, " +
        "eta_at=excluded.eta_at, grabbed_quality=excluded.grabbed_quality, " +
        "indexers_searched=excluded.indexers_searched, releases_seen=excluded.releases_seen, " +
        "updated_at=excluded.updated_at",
      [
        d.tconst,
        d.download_progress,
        d.eta_at,
        d.grabbed_quality,
        d.indexers_searched,
        d.releases_seen,
        new Date().toISOString(),
      ],
    );
  }

  getRequestDiagnostic(tconst: string): RequestDiagnostic | null {
    return (
      (this.db.query("select * from request_diagnostic where tconst = ?").get(tconst) as
        | RequestDiagnostic
        | undefined) ?? null
    );
  }

  /**
   * Every diagnostic, keyed by tconst -- the render-path read.
   *
   * Whole-table like `requestMap`, and bounded the same way: at most one row per title
   * anybody has ever asked for. `decorate()` needs an arbitrary subset of the titles on a
   * page, and a query per card would be the network call this whole architecture exists to
   * avoid, in SQLite.
   */
  requestDiagnosticMap(): Map<string, RequestDiagnostic> {
    const rows = this.db.query("select * from request_diagnostic").all() as RequestDiagnostic[];
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
   * Every (title, keyword) pair we hold -- the keyword index read from the term end.
   *
   * THE REVERSE INDEX, and it is a QUERY rather than a table. `json_each` walks the cached
   * `Keyword[]` payload inside SQLite, so a keyword browse costs one indexed scan of the
   * `keywords` rows and no JSON parsing in JS. A `keyword_title` table would be a second
   * copy of this same knowledge, and the only way to fill it for titles nobody has viewed
   * is a sweep of the providers -- which is forbidden. See `src/lib/terms.ts`.
   *
   * `tconst` narrows to one title, which is what the chip gate on a title page asks first;
   * omit it for the whole corpus, which is what a term page needs. The unnarrowed read is
   * the same shape and cost as the collection-name lookup `/api/collections` already makes
   * on every keystroke.
   *
   * `pluginIds` is the installed registry. A row whose PLUGIN is gone must not appear on a
   * page -- the same rule `isUsableContribution` applies to a rendered facet, spelled here
   * as an `in (...)` because the alternative is reading every row back to filter it.
   */
  keywordPairs(pluginIds: readonly string[], tconst?: string, now = new Date().toISOString()): TermPair[] {
    return this.facetTermPairs(
      "keywords",
      "json_extract(k.value, '$.name')",
      "json_each(f.data) k",
      [],
      pluginIds,
      tconst,
      now,
    );
  }

  /**
   * Every (title, streaming service) pair we hold IN ONE COUNTRY.
   *
   * The country is not optional and cannot be: the facet carries ~112 of them and a German
   * subscription is not an answer to a question asked from Bangkok -- the same rule
   * `pickWatchProviders` applies to the pane, moved into the query because here it is also
   * what keeps the row count down to roughly three per cached title.
   *
   * `flatrate` only, matching `watchServices`: `rent` and `buy` are every storefront on
   * earth, so browsing them would be browsing nothing. The names come back UNFOLDED --
   * `serviceKey` needs a 42-spelling table SQLite cannot express, so the fold happens in
   * `terms.ts` over these pairs.
   */
  watchServicePairs(
    country: string,
    pluginIds: readonly string[],
    tconst?: string,
    now = new Date().toISOString(),
  ): TermPair[] {
    return this.facetTermPairs(
      "watchProviders",
      "s.value",
      "json_each(f.data) c, json_each(c.value, '$.flatrate') s",
      [{ sql: "upper(json_extract(c.value, '$.country')) = ?", arg: country.toUpperCase() }],
      pluginIds,
      tconst,
      now,
    );
  }

  /**
   * Every (title, studio or network) pair we hold.
   *
   * Not a facet at all: the studio arrives on the SAME artwork lookup that resolves the
   * poster and is stored beside it, so this reverse read is one indexed scan of a table
   * that is already there. That is why studio browse needed no new provider, no new
   * artwork and no schema change -- the badge was rendering from this column already, it
   * simply had nowhere to go.
   */
  studioPairs(tconst?: string): TermPair[] {
    const where = ["studio is not null", "trim(studio) != ''"];
    const args: string[] = [];
    if (tconst !== undefined) {
      where.push("imdb_id = ?");
      args.push(tconst);
    }
    return this.db
      .query(`select imdb_id tconst, studio term from artwork where ${where.join(" and ")}`)
      .all(...(args as never[])) as TermPair[];
  }

  /**
   * The shared body of the two facet-backed reverse reads.
   *
   * `termSql` and `from` differ because the payloads differ -- `keywords` is a flat list of
   * objects, `watchProviders` is a list of countries each holding a list of names -- and
   * everything else about the two queries is identical: the same liveness window, the same
   * plugin filter, the same optional narrowing to one title. One owner for that half, so a
   * third facet-backed dimension is a call rather than a third hand-copied WHERE clause.
   *
   * The fragments are literals from the two callers above and never reach this from a
   * request, which is what keeps the interpolation honest; every VALUE is bound.
   */
  private facetTermPairs(
    facet: string,
    termSql: string,
    from: string,
    extra: readonly { sql: string; arg: string }[],
    pluginIds: readonly string[],
    tconst: string | undefined,
    now: string,
  ): TermPair[] {
    // No plugin installed means no row may be drawn, and `in ()` is not valid SQL.
    if (pluginIds.length === 0) return [];

    const where = [
      "f.facet = ?",
      "f.outcome = 'ok'",
      "(f.expires_at is null or f.expires_at > ?)",
      `f.plugin_id in (${pluginIds.map(() => "?").join(",")})`,
    ];
    const args: string[] = [facet, now, ...pluginIds];
    for (const clause of extra) {
      where.push(clause.sql);
      args.push(clause.arg);
    }
    if (tconst !== undefined) {
      where.push("f.entity_id = ?");
      args.push(tconst);
    }

    return this.db
      .query(
        `select f.entity_id tconst, ${termSql} term
         from facet_contribution f, ${from}
         where ${where.join(" and ")}`,
      )
      .all(...(args as never[])) as TermPair[];
  }

  /**
   * TMDB id -> every one of our tconsts carrying it, out of `externalIds` rows we hold.
   *
   * The FREE half of a crosswalk that would otherwise be a fan-out. Recommendations name
   * films by TMDB id and we index by IMDb; asking upstream for each one costs eleven calls
   * per film view against somebody else's infrastructure. Every title anyone has ever
   * opened already stored its own `externalIds`, so the answer is frequently sitting in
   * this table, and coverage grows with use rather than with traffic.
   *
   * CANDIDATES, PLURAL, AND THAT IS THE WHOLE POINT OF THE NAME. TMDB's movie ids and TV
   * ids are two independent sequences that both start at 1 and collide freely, and both are
   * written into the one `tmdb` key -- `radarr.ts` puts a movie id there, `skyhook.ts` a TV
   * id. So a bare number can name two of our titles at once, and this table has no column
   * saying which space either row is in. Returning ONE of them was a silent mis-link: a
   * film's "more like this" drew Game of Thrones because TV 1399 was the row the unordered
   * scan happened to visit last.
   *
   * The kind that separates them lives in the INDEX, which is a different database, so it
   * cannot be joined here. The caller holds both and picks: see `relatedTconsts` in
   * `src/server/related-crosswalk.ts`.
   *
   * An id we have never seen simply is not in the result -- the caller drops it, which is
   * the same rule that already governs a collection member we do not index.
   *
   * `entity_id` is the tconst, so the mapping needs no join: the row's own key IS the
   * answer, and the payload only has to confirm which TMDB id it belongs to.
   */
  tconstCandidatesByTmdbId(tmdbIds: readonly number[]): Map<number, string[]> {
    const out = new Map<number, string[]>();
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
        if (typeof ids.tmdb !== "number" || !wanted.has(ids.tmdb)) continue;
        const seen = out.get(ids.tmdb);
        // One title can hold rows from several plugins, all naming the same id.
        if (!seen) out.set(ids.tmdb, [row.entity_id]);
        else if (!seen.includes(row.entity_id)) seen.push(row.entity_id);
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

    /*
      ONLY ONCE REPLACED. The `exists` clause is what makes a superseded row a fallback
      rather than litter.

      This used to delete every row at a superseded version the moment the plugin's source
      hash moved, which was correct while a superseded row was unreadable anyway. It is not
      any more: `isUsableContribution` renders one until its provider answers again, so
      deleting it here would reintroduce exactly the burst this is meant to end -- the
      cache emptying at a restart and the warm loop re-buying it from third parties. Only
      a row that has ALREADY been replaced at the current version is dead, and that one is
      genuinely unreachable.

      What is left behind is bounded by the working set: a superseded row survives until
      its title is next viewed or warmed, and the front page is warmed every six hours. A
      title nobody ever opens keeps one old row, which is the row that will be served if
      somebody finally does.
    */
    const stmt = this.db.query(
      "delete from facet_contribution as old where old.plugin_id = ? and old.config_version != ? " +
        "and exists (select 1 from facet_contribution cur where cur.entity_id = old.entity_id " +
        "and cur.facet = old.facet and cur.plugin_id = old.plugin_id and cur.config_version = ?)",
    );
    // One transaction: a half-applied sweep would leave the count in `/api/health`
    // describing a table that no longer matches it.
    return this.db.transaction(() => {
      let pruned = 0;
      for (const [pluginId, version] of current) {
        pruned += stmt.run(pluginId, version, version).changes;
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

  /**
   * Remember which proxy key is a given person's face.
   *
   * One transaction for the whole title, like `rememberFacetImages` beside it and for the
   * same reason: a cast and crew list is fifty people and this rides the render path.
   *
   * **Upsert rather than `insert or ignore`, and only when the key actually moved.** The
   * key is a hash of the upstream URL, so a provider swapping a headshot yields a NEW key
   * and an ignoring insert would pin the first face we ever saw for as long as the row
   * lived. The `where` clause is what keeps that from costing a write per person per view:
   * the common case is the same key arriving again, and SQLite skips it.
   */
  rememberPersonImages(faces: readonly { nconst: string; imageKey: string }[]): void {
    if (faces.length === 0) return;
    const now = new Date().toISOString();
    const ins = this.db.prepare(
      "insert into person_image (nconst, image_key, seen_at) values (?,?,?) " +
        "on conflict(nconst) do update set image_key = excluded.image_key, seen_at = excluded.seen_at " +
        "where person_image.image_key <> excluded.image_key",
    );
    this.db.transaction(() => {
      for (const f of faces) ins.run(f.nconst, f.imageKey, now);
    })();
  }

  /**
   * The proxy keys for a batch of people, absent where we hold no face.
   *
   * A batch because the caller is a row of eight search hits, and eight prepared-statement
   * round trips to answer one question is the shape that turns a sub-millisecond lookup
   * into a visible one. Same reasoning as `nconstsByTmdbPersonId`.
   */
  personImageKeys(nconsts: readonly string[]): Map<string, string> {
    const out = new Map<string, string>();
    if (nconsts.length === 0) return out;
    const rows = this.db
      .query(
        `select nconst, image_key from person_image where nconst in (${nconsts.map(() => "?").join(",")})`,
      )
      .all(...(nconsts as never[])) as { nconst: string; image_key: string }[];
    for (const r of rows) out.set(r.nconst, r.image_key);
    return out;
  }

  personImageCount(): number {
    return (this.db.query("select count(*) c from person_image").get() as { c: number }).c;
  }

  /**
   * Every title we hold a cast or crew answer for -- the titles that have faces in them.
   *
   * Exists for the BACKFILL and only for it. `person_image` is written when a title page
   * renders, so without this the edge would only ever know about titles opened AFTER it
   * shipped, and every face already sitting in the cache would stay unreachable. It reads
   * `ix_facet_facet` (the reverse index) rather than scanning.
   *
   * `outcome = 'ok'` because the other outcomes carry no data to harvest: `empty` is a
   * provider saying there is nobody, and `failed` is one saying nothing at all.
   */
  tconstsWithCredits(): string[] {
    const rows = this.db
      .query(
        "select distinct entity_id from facet_contribution " +
          "where facet in ('cast','crew') and outcome = 'ok' order by entity_id",
      )
      .all() as { entity_id: string }[];
    return rows.map((r) => r.entity_id);
  }

  // --- search log ----------------------------------------------------------
  //
  // `Store` IS the `SearchLogSink`, so nothing between the buffer and SQLite has to know
  // about both. See `../lib/search-log.ts` for what may and may not be in a row.

  /** One transaction per batch: a flush of forty rows costs one fsync, not forty. */
  writeSearches(rows: readonly SearchRow[]): void {
    const ins = this.db.prepare("insert into search_log (query, at, results, filters) values (?,?,?,?)");
    this.db.transaction(() => {
      for (const r of rows) ins.run(r.query, r.at, r.results, encodeFilters(r.filters));
    })();
  }

  writeClicks(rows: readonly ClickRow[]): void {
    const ins = this.db.prepare(
      "insert into search_click (query, tconst, rank, tier, at) values (?,?,?,?,?)",
    );
    this.db.transaction(() => {
      for (const r of rows) ins.run(r.query, r.tconst, r.rank, r.tier, r.at);
    })();
  }

  /**
   * Keep the newest `keep` rows of each table and delete the rest. Returns rows removed.
   *
   * A ROW CEILING RATHER THAN AN AGE, and the difference matters for what this data is for.
   * An age limit on a household instance that goes quiet for a month deletes the only
   * evidence there was; a ceiling keeps the last N queries however long they took to
   * arrive, which is what a retune wants to read. It is a disk bound, not a retention
   * policy -- there is no identity here to expire.
   */
  pruneSearchLog(keep: number): number {
    let removed = 0;
    for (const table of ["search_log", "search_click"]) {
      // The cutoff is read first rather than folded into the DELETE: a correlated subquery
      // over `at` is evaluated per candidate row, and this one runs on a 30s timer.
      const edge = this.db.query(`select at from ${table} order by at desc limit 1 offset ?`).get(keep) as
        | { at: number }
        | undefined;
      if (!edge) continue;
      removed += this.db.run(`delete from ${table} where at <= ?`, [edge.at]).changes;
    }
    return removed;
  }

  /**
   * Every logged query, newest first. The report job's whole input.
   *
   * `filters` is decoded here rather than handed on as the stored text, so a reader of a
   * `SearchRow` never has to know the column is JSON -- `decodeFilters` is the one place
   * that does, and it treats an older row's null and a junk value the same way.
   */
  searchLogRows(limit: number): SearchRow[] {
    const rows = this.db
      .query("select query, at, results, filters from search_log order by at desc limit ?")
      .all(limit) as (Omit<SearchRow, "filters"> & { filters: string | null })[];
    return rows.map(({ filters, ...row }) => {
      const picked = decodeFilters(filters);
      return picked ? { ...row, filters: picked } : row;
    });
  }

  searchClickRows(limit: number): ClickRow[] {
    return this.db
      .query("select query, tconst, rank, tier, at from search_click order by at desc limit ?")
      .all(limit) as ClickRow[];
  }

  searchLogCounts(): { searches: number; clicks: number } {
    return {
      searches: (this.db.query("select count(*) c from search_log").get() as { c: number }).c,
      clicks: (this.db.query("select count(*) c from search_click").get() as { c: number }).c,
    };
  }

  // --- awards --------------------------------------------------------------

  /**
   * Replace every nomination for one award, in a single transaction.
   *
   * A full swap for the same reason `replaceLibrary` is one: `oscar_data` CORRECTS old
   * ceremonies as well as adding new ones, so a row that upstream deleted or re-keyed has
   * to disappear here too, and an upsert can only ever add. The swap is atomic, so a
   * reader during an import sees the old set or the new one and never half of either.
   *
   * The two edge tables are rebuilt from the same rows rather than being written by their
   * own caller: they are an INDEX of this data, and one writer is what stops them drifting
   * from the nominations they point at.
   */
  replaceAwards(award: string, rows: readonly Nomination[]): number {
    const ins = this.db.prepare(
      "insert or replace into award_nomination " +
        "(award, ceremony, seq, year, class, category, raw_category, films, film_ids, nominees, nconsts, won, detail, note) " +
        "values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    const insFilm = this.db.prepare(
      "insert or replace into award_film (award, ceremony, seq, tconst) values (?,?,?,?)",
    );
    const insNominee = this.db.prepare(
      "insert or replace into award_nominee (award, ceremony, seq, nconst) values (?,?,?,?)",
    );

    return this.db.transaction(() => {
      this.db.run("delete from award_nomination where award = ?", [award]);
      this.db.run("delete from award_film where award = ?", [award]);
      this.db.run("delete from award_nominee where award = ?", [award]);
      for (const r of rows) {
        ins.run(
          award,
          r.ceremony,
          r.seq,
          r.year,
          r.className,
          r.category,
          r.rawCategory,
          r.films.join("|"),
          // The nulls survive as EMPTY entries so the two lists stay positionally aligned
          // on the way back out. Dropping them here would slide every later id onto the
          // wrong title, which is the one failure this shape exists to prevent.
          r.filmIds.map((id) => id ?? "").join("|"),
          r.nominees.join("|"),
          r.nconsts.map((id) => id ?? "").join("|"),
          r.won ? 1 : 0,
          r.detail,
          r.note,
        );
        // A Set because one nomination can legitimately name the same id twice; the
        // primary key would refuse the second write, and `insert or replace` would make
        // it silent rather than correct.
        for (const t of new Set(r.filmIds.filter((id): id is string => id !== null))) {
          insFilm.run(award, r.ceremony, r.seq, t);
        }
        for (const n of new Set(r.nconsts.filter((id): id is string => id !== null))) {
          insNominee.run(award, r.ceremony, r.seq, n);
        }
      }
      return rows.length;
    })();
  }

  /** Every nomination of one ceremony, in source order. The ceremony page groups them. */
  awardCeremonyRows(award: string, ceremony: number): Nomination[] {
    return (
      this.db
        .query("select * from award_nomination where award = ? and ceremony = ? order by seq")
        .all(award, ceremony) as AwardRow[]
    ).map(toNomination);
  }

  /** Every nomination naming this title, newest ceremony first. */
  awardRowsForTitle(award: string, tconst: string): Nomination[] {
    return (
      this.db
        .query(
          "select n.* from award_film f join award_nomination n " +
            "on n.award = f.award and n.ceremony = f.ceremony and n.seq = f.seq " +
            "where f.award = ? and f.tconst = ? order by n.ceremony desc, n.seq",
        )
        .all(award, tconst) as AwardRow[]
    ).map(toNomination);
  }

  /** Every nomination naming this person, newest ceremony first. */
  awardRowsForPerson(award: string, nconst: string): Nomination[] {
    return (
      this.db
        .query(
          "select n.* from award_nominee p join award_nomination n " +
            "on n.award = p.award and n.ceremony = p.ceremony and n.seq = p.seq " +
            "where p.award = ? and p.nconst = ? order by n.ceremony desc, n.seq",
        )
        .all(award, nconst) as AwardRow[]
    ).map(toNomination);
  }

  /**
   * Per-ceremony counts, plus how many of that year's films we hold.
   *
   * ONE query for the whole timeline rather than 98 -- the page draws every ceremony, so a
   * per-row query is 98 round trips for a screen that is one `select` wide. The ownership
   * count joins the library mirror in SQL for the same reason: it is the same database, so
   * pulling every film id into JS to count them would be the join done worse.
   *
   * `distinct` on the film id, because a film nominated in nine categories is one film.
   */
  awardCeremonyCounts(award: string): {
    ceremony: number;
    year: string;
    nominations: number;
    wins: number;
    categories: number;
    films: number;
    filmsOwned: number;
  }[] {
    const counts = this.db
      .query(
        "select ceremony, max(year) as year, count(*) as nominations, " +
          "sum(won) as wins, count(distinct category) as categories " +
          "from award_nomination where award = ? group by ceremony order by ceremony desc",
      )
      .all(award) as {
      ceremony: number;
      year: string;
      nominations: number;
      wins: number;
      categories: number;
    }[];

    const films = new Map<number, { films: number; filmsOwned: number }>();
    for (const r of this.db
      .query(
        "select f.ceremony as ceremony, count(distinct f.tconst) as films, " +
          "count(distinct case when l.imdb_id is not null then f.tconst end) as owned " +
          "from award_film f left join library l on l.imdb_id = f.tconst " +
          "where f.award = ? group by f.ceremony",
      )
      .all(award) as { ceremony: number; films: number; owned: number }[]) {
      films.set(r.ceremony, { films: r.films, filmsOwned: r.owned });
    }

    return counts.map((c) => ({
      ...c,
      // `sum` over an empty group is null in SQLite, and a ceremony with no wins recorded
      // is a real state for the current year before the awards are given.
      wins: c.wins ?? 0,
      films: films.get(c.ceremony)?.films ?? 0,
      filmsOwned: films.get(c.ceremony)?.filmsOwned ?? 0,
    }));
  }

  /**
   * The winning rows of an award, newest edition first, optionally within one category.
   *
   * Takes the category NAME rather than hardcoding Best Picture: the anchor is a render
   * decision and belongs to the caller, and `UNIQUE AND ARTISTIC PICTURE` exists as a
   * second top prize at the first ceremony, so "the" top category is not a fact this
   * table can assert on its own.
   *
   * `null` means every win, whatever its category. That is not a convenience: a winner-only
   * award has one prize per edition and no category to narrow by, so the filter would be
   * matching a name we invented in order to have one.
   */
  awardWinners(award: string, category: string | null): Nomination[] {
    const where = category === null ? "" : "and category = ? ";
    const params = category === null ? [award] : [award, category];
    return (
      this.db
        .query(
          `select * from award_nomination where award = ? ${where}and won = 1 order by ceremony desc, seq`,
        )
        .all(...params) as AwardRow[]
    ).map(toNomination);
  }

  /** Every nomination a given ceremony's given film took, for the "also won" line. */
  awardRowsForFilmAtCeremony(award: string, ceremony: number, tconst: string): Nomination[] {
    return (
      this.db
        .query(
          "select n.* from award_film f join award_nomination n " +
            "on n.award = f.award and n.ceremony = f.ceremony and n.seq = f.seq " +
            "where f.award = ? and f.ceremony = ? and f.tconst = ? order by n.seq",
        )
        .all(award, ceremony, tconst) as AwardRow[]
    ).map(toNomination);
  }

  /**
   * How many of a set of tconsts the library holds. One query, whatever the size.
   *
   * The completion counts are the one thing Seerr structurally cannot answer, and they are
   * answerable here only because the nominations and the library mirror are in the same
   * file. Chunked because SQLite caps a statement at 32,766 bound parameters by default and
   * a full-award count is 5,264 distinct films -- under the cap today, and this is what
   * stops that being a fact anybody has to remember.
   */
  ownedCount(tconsts: readonly string[]): number {
    let owned = 0;
    for (let i = 0; i < tconsts.length; i += 500) {
      const chunk = tconsts.slice(i, i + 500);
      const q = this.db.query(
        `select count(distinct imdb_id) c from library where imdb_id in (${chunk.map(() => "?").join(",")})`,
      );
      owned += (q.get(...(chunk as never[])) as { c: number }).c;
    }
    return owned;
  }

  awardCount(award: string): number {
    return (
      this.db.query("select count(*) c from award_nomination where award = ?").get(award) as { c: number }
    ).c;
  }

  /**
   * Does this award name anybody at all? False for a winner-only source.
   *
   * EXISTENCE rather than a count, and the difference is measurable: `count(distinct nconst)`
   * is a temp b-tree over every person edge -- 5.3 ms on the real table -- while this stops at
   * the first row. It rides on the TIMELINE payload, which is the page that decides whether to
   * offer a leaderboard link at all, so it is paid for on a screen that has no other use for
   * the number a count would give.
   */
  awardHasPeople(award: string): boolean {
    return this.db.query("select 1 from award_nominee where award = ? limit 1").get(award) !== null;
  }

  /**
   * The source's own coarse classes, and how many PEOPLE each of them names.
   *
   * What the leaderboard's chips are built from, so a class with nobody in it is never
   * offered -- the same rule the completion counts follow, measured rather than assumed.
   * A winner-only award names no people at all and yields `[]`, which the page draws as
   * "there is nobody here" rather than as an empty row of chips.
   */
  awardPersonClasses(award: string): AwardPersonClass[] {
    return this.db
      .query(
        "select n.class as className, count(distinct p.nconst) as people " +
          "from award_nominee p join award_nomination n " +
          "on n.award = p.award and n.ceremony = p.ceremony and n.seq = p.seq " +
          "where p.award = ? group by n.class",
      )
      .all(award) as AwardPersonClass[];
  }

  /**
   * How often one award's nominations name each PERSON, with the name to print beside it.
   *
   * The reverse of everything else in this section: the tables answer "who was nominated for
   * this" everywhere, and this asks "what is this person's record". `award_nominee` already
   * holds only ids that are PEOPLE -- the source mixes company ids into the same column and
   * `isPersonId` dropped them at import -- so a leaderboard built on this cannot rank a
   * production company alongside an actor.
   *
   * > [!IMPORTANT] The NAME comes from their most recent nomination, and `max(ceremony)`
   * > is what selects it rather than being decoration on the count
   * > SQLite guarantees that bare columns in a `min`/`max` aggregate come from the row that
   * > produced the extreme, so `nominees`/`nconsts` here are that row's -- and the id lists
   * > are positional, so the name is read at the id's own index. LATEST rather than earliest
   * > because a person's name can genuinely change and the current one is the right one to
   * > print; taking the first would deadname anybody who has transitioned.
   *
   * The source's own capitalisation survives untouched, including the 108 names it shouts
   * (`DOUGLAS G. SHEARER`). That is what the ceremony page prints for the same row, and a
   * case fold clever enough for `MCDONALD` and `O'BRIEN` is a fold that will eventually
   * invent a spelling -- a faithful quote beats a plausible guess.
   *
   * MEASURED against the real table (12,137 nominations, 16,777 person edges): 8,403 groups
   * in ~16 ms warm, every one of them resolving to a name. An index on `(award, nconst)` was
   * tried and made it SLOWER -- 22 ms -- because it trades the covering scan the group-by
   * already gets for a random probe per row, so there is no index here and that is measured
   * rather than overlooked. The page it feeds is cached per session for ten minutes and is
   * not on the keystroke path.
   */
  awardPersonTallies(award: string, className: string | null): AwardPersonTally[] {
    const where = className === null ? "" : "and n.class = ? ";
    const params = className === null ? [award] : [award, className];
    const rows = this.db
      .query(
        "select p.nconst as nconst, count(*) as nominations, sum(n.won) as wins, " +
          "max(n.ceremony) as latest, n.nominees as nominees, n.nconsts as nconsts " +
          "from award_nominee p join award_nomination n " +
          "on n.award = p.award and n.ceremony = p.ceremony and n.seq = p.seq " +
          `where p.award = ? ${where}group by p.nconst`,
      )
      .all(...params) as {
      nconst: string;
      nominations: number;
      wins: number;
      nominees: string;
      nconsts: string;
    }[];

    return rows.map((r) => ({
      nconst: r.nconst,
      // The id list cannot miss an id the edge table was built from, so the fallback is
      // unreachable in practice -- it is here so a hand-edited row prints something a
      // reader can look up rather than crashing the page.
      name: nomineeNameAt(r.nominees, r.nconsts, r.nconst) ?? r.nconst,
      nominations: r.nominations,
      wins: r.wins,
    }));
  }
}

/**
 * The printed name sitting at an id's own position in a stored nomination.
 *
 * The two lists are parallel by construction -- `replaceAwards` keeps the holes so they stay
 * aligned -- so the name is found by INDEX and never by searching the name list. `null` when
 * the id is not in the row at all, which the caller decides what to do about.
 */
function nomineeNameAt(nominees: string, nconsts: string, nconst: string): string | null {
  const at = nconsts.split("|").indexOf(nconst);
  return at === -1 ? null : (nominees.split("|")[at] ?? null);
}

/** The stored shape, which is the domain shape with the two id lists joined. */
interface AwardRow {
  award: string;
  ceremony: number;
  seq: number;
  year: string;
  class: string;
  category: string;
  raw_category: string;
  films: string;
  film_ids: string;
  nominees: string;
  nconsts: string;
  won: number;
  detail: string | null;
  note: string | null;
}

/**
 * Split a stored parallel id list back into positions.
 *
 * An empty entry means "no id at this position", which is the ordinary case, so `""` maps
 * to `null` rather than being filtered out -- filtering would misalign every later entry
 * with its name.
 */
function splitIds(raw: string): (string | null)[] {
  return raw === "" ? [] : raw.split("|").map((id) => (id === "" ? null : id));
}

function toNomination(r: AwardRow): Nomination {
  return {
    award: r.award,
    ceremony: r.ceremony,
    seq: r.seq,
    year: r.year,
    className: r.class,
    category: r.category,
    rawCategory: r.raw_category,
    films: r.films === "" ? [] : r.films.split("|"),
    filmIds: splitIds(r.film_ids),
    nominees: r.nominees === "" ? [] : r.nominees.split("|"),
    nconsts: splitIds(r.nconsts),
    won: r.won === 1,
    detail: r.detail,
    note: r.note,
  };
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

/** What `seedArtwork` takes for one title, lifted off the library record that carried it. */
interface ArtworkSeed {
  imdb_id: string;
  url: string | null;
  studio: string | null;
}

/**
 * The poster and studio an arr's library record carries for free.
 *
 * Both services put them in the same two places, so this is one projection rather than a copy
 * per service -- and it is where the `images` cast lives, once, instead of at each call site.
 */
function artworkSeed(record: { imdbId?: string; images?: unknown }): ArtworkSeed {
  return {
    imdb_id: record.imdbId ?? "",
    url: posterFrom(record.images),
    studio: studioFrom(record),
  };
}

/**
 * Drain a library walk into the two narrow lists the mirror actually stores.
 *
 * > [!IMPORTANT] What this function does NOT do is the reason it exists
 * > It never builds an array of the arr's own records. A Radarr movie is ~5.5 KB of JSON --
 * > `images`, `alternateTitles`, `ratings`, a full `movieFile` -- and the mirror keeps seven
 * > fields of it plus a poster URL. Projecting inside the loop lets each fat record be
 * > collected as soon as the next one is parsed, so the peak is set by the projection ratio
 * > rather than by the library's size. Seerr's #3307 is what the other shape costs at 16k
 * > items: a +335 MB heap step and ~450 MB never given back.
 *
 * The narrow lists ARE accumulated in full, on purpose: `replaceLibrary` and `seedArtwork` are
 * swaps, and streaming rows straight into them would let a walk that failed halfway leave the
 * mirror holding half a library. Collecting first means a throw anywhere in the walk reaches
 * the caller before the store is touched at all.
 */
async function collectLibraryWalk<T extends { imdbId?: string; images?: unknown }>(
  records: AsyncIterable<T>,
  toRow: (record: T) => LibraryMirrorRow,
): Promise<{ rows: LibraryMirrorRow[]; artwork: ArtworkSeed[] }> {
  const rows: LibraryMirrorRow[] = [];
  const artwork: ArtworkSeed[] = [];
  for await (const record of records) {
    rows.push(toRow(record));
    artwork.push(artworkSeed(record));
  }
  return { rows, artwork };
}

/**
 * Pull both libraries into the mirror.
 *
 * Failures are per-service and non-fatal: if Sonarr is down we still want an accurate
 * picture of Radarr rather than a stale picture of both.
 *
 * Both walks STREAM -- see `collectLibraryWalk` for what that buys and what it deliberately
 * still buffers.
 */
export async function syncLibrary(
  store: Store,
  clients: { radarr?: RadarrClient; sonarr?: SonarrClient },
  episodePolicy: EpisodeRefreshPolicy,
  log: (m: string) => void = () => {},
): Promise<{ radarr?: number; sonarr?: number; episodes?: number; errors: string[] }> {
  const errors: string[] = [];
  const out: { radarr?: number; sonarr?: number; episodes?: number; errors: string[] } = {
    errors,
  };

  if (clients.radarr) {
    try {
      const walk = await collectLibraryWalk(clients.radarr.movies(), (m) => ({
        imdb_id: m.imdbId ?? "",
        arr_id: m.id,
        has_file: m.hasFile ? 1 : 0,
        monitored: m.monitored ? 1 : 0,
        progress: m.hasFile ? 1 : 0,
        added_at: addedFrom(m),
        title_slug: m.titleSlug ?? null,
      }));
      out.radarr = store.replaceLibrary("radarr", walk.rows);
      // Every owned title already carries its artwork AND its studio in the same
      // response -- seeding here costs nothing extra and covers the whole library
      // instantly, so an owned title never waits on an on-demand lookup for either.
      const seeded = store.seedArtwork(walk.artwork);
      log(`library: ${out.radarr} movies mirrored${seeded ? `, ${seeded} posters seeded` : ""}`);
    } catch (err) {
      errors.push(`radarr: ${(err as Error).message}`);
    }
  }

  if (clients.sonarr) {
    try {
      const walk = await collectLibraryWalk(clients.sonarr.series(), (s) => ({
        imdb_id: s.imdbId ?? "",
        arr_id: s.id,
        has_file: (s.statistics?.episodeFileCount ?? 0) > 0 ? 1 : 0,
        monitored: s.monitored ? 1 : 0,
        progress: s.statistics ? s.statistics.percentOfEpisodes / 100 : null,
        added_at: addedFrom(s),
        title_slug: s.titleSlug ?? null,
      }));
      out.sonarr = store.replaceLibrary("sonarr", walk.rows);
      const seeded = store.seedArtwork(walk.artwork);
      log(`library: ${out.sonarr} series mirrored${seeded ? `, ${seeded} posters seeded` : ""}`);

      // A SLICE of the stale series, never all of them -- see `syncEpisodes`. It reads the
      // MIRROR ROWS rather than Sonarr's records, which is all it ever needed: `arr_id` is the
      // series id its endpoint takes, and `imdb_id` is how the slice is chosen.
      const eps = await syncEpisodes(store, clients.sonarr, walk.rows, episodePolicy, log);
      out.episodes = eps.episodes;
      errors.push(...eps.errors);
    } catch (err) {
      errors.push(`sonarr: ${(err as Error).message}`);
    }
  }

  return out;
}

/** How hard the episode walk is allowed to push, per library refresh. */
export interface EpisodeRefreshPolicy {
  /** How many series may be walked on this pass. */
  batch: number;
  /** How stale a series' rows must be before it is a candidate, in seconds. */
  staleSeconds: number;
}

/**
 * Mirror Sonarr's per-EPISODE state for a SLICE of the series we hold.
 *
 * > [!CAUTION] One call PER SERIES -- walking the whole library every minute is ~600 rpm
 * > Sonarr has no "every episode you hold" endpoint (`/episode` requires a `seriesId`), so
 * > the cost of this mirror is linear in the library and NOT in the number of passes. The
 * > first version of this function walked every series on the 60-second library timer,
 * > which on a 596-series library is around six hundred requests a minute, indefinitely,
 * > for a fact that changes when a file is imported. That it is the operator's own Sonarr
 * > on the LAN makes it rude rather than forbidden; it is still the wrong thing to do.
 *
 * So each pass takes `batch` series whose rows are older than `staleSeconds`, neediest
 * first (`Store.seriesNeedingEpisodeRefresh`). At the defaults -- 25 per minute, six-hour
 * staleness -- a first boot fills a 600-series library inside half an hour and the steady
 * state is under two calls a minute. A reader's own request does not wait for its turn:
 * `markEpisodesMonitored` writes that through as soon as Sonarr accepts it.
 *
 * Serial rather than parallel, deliberately. There is no deadline on a background mirror,
 * and a burst of concurrent requests is how a mirror becomes the reason Sonarr is slow.
 *
 * A series whose fetch fails is SKIPPED and keeps the rows it already had. The failure is
 * collected rather than thrown, for the same reason `syncLibrary` splits Radarr from
 * Sonarr: one bad series must not cost us the other four hundred.
 */
export async function syncEpisodes(
  store: Store,
  sonarr: SonarrClient,
  /**
   * The series to consider, as the MIRROR holds them -- `imdb_id` picks the slice, `arr_id` is
   * the series id Sonarr's endpoint takes. Narrowed from `SonarrSeries[]` to the two fields
   * this actually reads, so a caller may hand over the rows it already built instead of
   * keeping the arr's own records alive for a second reader.
   */
  series: readonly Pick<LibraryMirrorRow, "imdb_id" | "arr_id">[],
  policy: EpisodeRefreshPolicy,
  log: (m: string) => void = () => {},
): Promise<{ episodes: number; series: number; errors: string[] }> {
  const errors: string[] = [];
  let episodes = 0;
  let walked = 0;

  if (policy.batch <= 0) return { episodes, series: walked, errors };

  const staleBefore = new Date(Date.now() - policy.staleSeconds * 1000).toISOString();
  const due = new Set(store.seriesNeedingEpisodeRefresh(policy.batch, staleBefore));
  if (due.size === 0) return { episodes, series: walked, errors };

  for (const s of series) {
    // The slice is chosen from the MIRROR rather than from this list, so a series Sonarr
    // just dropped cannot be walked and one with no IMDb id was never a candidate.
    if (!s.imdb_id || !due.has(s.imdb_id)) continue;
    try {
      // Streamed and projected in the loop, for the reason `collectLibraryWalk` gives: one
      // series is bounded, but a long-running show is thousands of episodes and there is no
      // reason for the fat records to coexist with the narrow ones.
      const rows: Omit<EpisodeEntry, "imdb_id" | "updated_at">[] = [];
      for await (const e of sonarr.episodes(s.arr_id)) {
        rows.push({
          season: e.seasonNumber,
          episode: e.episodeNumber,
          arr_episode_id: e.id,
          has_file: e.hasFile ? 1 : 0,
          monitored: e.monitored ? 1 : 0,
          air_date: e.airDate ?? null,
        });
      }
      episodes += store.replaceEpisodes(s.imdb_id, rows);
      walked += 1;
    } catch (err) {
      errors.push(`sonarr episodes ${s.imdb_id}: ${(err as Error).message}`);
    }
  }

  log(`library: ${episodes} episodes mirrored across ${walked} series`);
  return { episodes, series: walked, errors };
}
