/**
 * Builds the searchable title index from the IMDb dumps.
 *
 * Design decision: REBUILD, never patch. Incremental diffing would be more code, more
 * failure modes, and no faster -- see BUILD COST below for why "no faster" is a
 * measurement rather than an opinion.
 *
 * The build always targets `titles.new.db` and is only promoted to the live path
 * after every gate passes, so a bad build is a no-op rather than an outage.
 *
 * ## BUILD COST, MEASURED
 *
 * **This block is the ONE owner of these numbers.** Everything else that needs to argue
 * about build cost -- `castRefreshDays` in `./config.ts`, `buildRankLayer` and
 * `carryCastForward` below, `../server/index-build.ts`, the healthcheck `start_period` in
 * `docker-compose.yml` -- cites it instead of restating a figure. Six independent copies
 * of "376s" is how five of them end up stale and nobody can tell which one was re-measured.
 *
 * Measured 2026-09-03 on the Synology (Celeron J4125, no AVX2), both runs from the same
 * on-disk dumps in an isolated data directory, canary 42/42 on each:
 *
 * | build | wall | result |
 * |---|---|---|
 * | cast refresh -- full `title.principals` scan | **389.7s** | 1,275,906 titles, 717.5 MB |
 * | carry-forward -- cast tables copied from the previous index | **155.7s** | same 1,275,906 titles, volume gate 100.0% |
 *
 * The Mac does the refresh build in 102.7s (measured 2026-08-31, not re-run here).
 *
 * So the cast scan is ~234s, about 60% of a refresh build. That figure is a DELTA between
 * two runs and carries run-to-run noise: the rank stage alone moved 43.4s -> 25.3s between
 * these two, on an otherwise idle box.
 *
 * **Almost all of the scan is streaming and parsing, not inserting.** The vote floor keeps
 * barely 1% of `title.principals` (the row counts are on `castMinVotes` in `./config.ts`),
 * so an incremental cast build saves nothing -- it still reads the whole dump to discover
 * what changed. NOT reading it is the only thing that helps, which is what
 * `castRefreshDays` buys.
 *
 * **Carry-forward does not bring the build under two minutes.** 155.7s against a stated
 * ~120s budget is a 1.3x breach, down from 3.2x. The remaining cost is the title stages,
 * which cannot be carried forward the same way because titles DO change daily: 12.76M rows
 * of `title.basics` parsed, then rank, then FTS and the spellfix vocabulary. Anything that
 * closes the last 36s has to come from there, not from cast.
 *
 * ## The episode stage, measured 2026-09-05 on the Mac -- AND IT IS NOT CHEAP
 *
 * An A/B over one set of on-disk dumps in an isolated data directory, `--no-fetch
 * --dry-run`, no previous index so both runs rescan the cast, and spellfix1 unavailable so
 * the vocabulary stage was skipped in both. The ONLY difference is whether
 * `title.episode.tsv.gz` was on disk, which is exactly the switch `episodeStage` reads. The
 * rank stage came out 8.4s and 8.5s across the pair, so run-to-run noise was small:
 *
 * | build | wall | index | peak RSS |
 * |---|---|---|---|
 * | without the episode dump -- the stage skips | **83.2s** | 690.4 MB | 2,083 MB |
 * | with it, 1,127,680 episodes kept | **110.4s** | 815.8 MB | 1,978 MB |
 *
 * **So the stage is +27.2s and +125 MB of index, a third again on top of this build.** Peak
 * RSS did not move -- the work is SQLite's, not the JS heap's, which is the property the
 * ordering in `buildIndex` was chosen for.
 *
 * Of the 27.2s, four components were isolated separately against the same data: streaming
 * `title.episode` and inserting the rows, 4.7s; the `title`/`year` probes during the basics
 * pass, ~2s; building the episode index, 2.0s; `pruneOrphanEpisodes`, 2.4s. The remaining
 * ~16s is not attributed to a named step and is most likely the extra 125 MB of pages this
 * build now writes. **Do not quote the components as if they summed to the total.**
 *
 * > **THE PAIR ABOVE IS ALREADY A FLOOR, AND KNOWING WHY MATTERS MORE THAN THE NUMBER.** It
 * > was measured against ONE narrow `episode(parent, season, number)` index. The stage now
 * > builds TWO covering indexes carrying every payload column, on the standing rule that
 * > index size and build time are the cheap axis and render latency is not -- so the real
 * > wall time and the real 125 MB are both higher than what is written here. The 2.0s
 * > component above is the narrow index and no longer describes what is built. **Re-run the
 * > A/B before quoting any of this**; the recipe is in the paragraph above it.
 *
 * **NOT RE-MEASURED ON THE SYNOLOGY EITHER.** Scaled by the ~3.8x this Mac differs from it
 * on the refresh build, +27.2s here implies roughly +100s there -- which would put the
 * carry-forward NAS build near 260s against the ~120s condition that was already open at
 * 155.7s. That is an ESTIMATE off an under-measurement, and the two rows above are neither;
 * it wants a real run before anybody plans on it.
 *
 * **The dial, if that cost has to come down, is `index.episodeSeriesMinVotes`**, because
 * the stage's cost is dominated by the number of rows it keeps. The shipped floor's census
 * is on that setting in `./config.ts`, which owns it; what belongs here is what raising it
 * would BUY, measured over the same dump on the same day:
 *
 * | floor | episodes kept | series covered |
 * |---|---|---|
 * | 2,500 | 680,147 | 7,550 |
 * | 5,000 | 411,336 | 4,726 |
 * | 10,000 | 209,790 | 2,832 |
 * | 25,000 | 92,154 | 1,334 |
 *
 * Every one of those is bought by making finderr unable to answer about smaller shows, so
 * it is a product decision rather than a tuning one.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { type Config, paths } from "./config";
import {
  CROSSWALK_SCHEMA,
  loadCrosswalk,
  loadPersonCrosswalk,
  PERSON_CROSSWALK,
  PERSON_CROSSWALK_SCHEMA,
  parseCrosswalkCsv,
  parsePersonCrosswalkCsv,
  TITLE_CROSSWALK,
} from "./crosswalk";
import { intOrNull, nullable, streamTsv } from "./dumps";
import { INDEX_STAGES, stampStages } from "./index-stages";
import { despace, normalizeStripped } from "./normalize";
import { buildPersonSearchIndex } from "./people";
import { POPULAR_TITLE_INDEX } from "./search-stopwords";
import { loadSpellfix, prepareSqlite, SPELLFIX_MAP_TABLE, SPELLFIX_TABLE } from "./spellfix";

export interface BuildStats {
  scanned: number;
  kept: number;
  rated: number;
  genreRows: number;
  /** Credit rows kept. 0 when the cast stage was skipped or the dumps are absent. */
  creditRows: number;
  /** Distinct people named by those credits. */
  people: number;
  /** Episode rows kept. 0 when `title.episode.tsv.gz` is not on disk. */
  episodeRows: number;
  /** Titles carrying a bulk-loaded TMDB or TVDB id. 0 when the crosswalk was unavailable. */
  idRows: number;
  /** People carrying a bulk-loaded TMDB person id. 0 when that crosswalk was unavailable. */
  personIdRows: number;
  bytes: number;
  ms: number;
}

/**
 * The index schema, exported so a test can stand up a handful of rows in a temp file
 * that is shaped exactly like the real index rather than like somebody's memory of it.
 */
/**
 * The browse-count table, split out so the benchmark harness can add it to an older file.
 *
 * Interpolated into `SCHEMA` rather than living only inside it: `bun run bench --reindex`
 * brings a CLONE up to this checkout's shape without a full rebuild, and a clone of an index
 * built before this stage has no such table. One owner, two callers.
 */
export const BROWSE_COUNT_SCHEMA = `
-- EVERY BROWSE COUNT THE PRODUCT CAN ASK FOR, ANSWERED AT BUILD TIME.
--
-- browseIndex returns a total beside its rows, and once the row queries became seeks the
-- COUNT was the whole remaining cost of a browse. Measured on the real 2.18 GB index after
-- the rank indexes landed: a genre+decade count was 137.48 ms while its rows were 0.32 ms,
-- an unfiltered ranked count 11.16 ms, a genre+kind ranked count 10.69 ms. A count cannot
-- be turned into a seek the way an ordered read can, because it has to visit every matching
-- row -- so the only way to stop paying it at render time is to have paid it already.
--
-- This is the grain every filter combination reduces to: one row per (kind, genre, year),
-- carrying the three populations the UI can ask about. 9,102 rows, 0.30 MB, 6.75 s to build.
-- Every count in the product becomes a sum over at most a few hundred rows; the 137 ms one
-- becomes 0.34 ms.
--
-- THE ONE THING TO GET RIGHT: genre = '' is the ANY-GENRE row, NOT "titles with no genre".
-- A title with three genres has three title_genre rows, so summing across genres
-- double-counts it and an unfiltered total would come out larger than the corpus. The build
-- writes a SECOND set of rows, grouped by (kind, year) over title alone, under the sentinel
-- genre ''. A genre-filtered count sums the real genre rows; an unfiltered one sums only the
-- '' rows; the two are never mixed. browse-count.test.ts pins this by asserting the stored
-- count EQUALS the live count over a matrix of filters, rather than by asserting any
-- particular number -- a total is printed to the reader as a fact, so close is not a trade.
--
-- without rowid because the primary key IS the row's identity and the table is read by
-- prefix: it halves the size and makes every lookup a single b-tree descent.
create table browse_count (
  kind   text    not null,
  genre  text    not null,
  year   integer not null,
  -- Every title at this grain, no floor. What ?year=1901 counts.
  n        integer not null,
  -- Those clearing BROWSE_VOTE_FLOOR. What a broad grid counts.
  n_floor  integer not null,
  -- Those carrying a rank. What every computed top list counts.
  n_ranked integer not null,
  primary key (kind, genre, year)
) without rowid;
`;

export const SCHEMA = `
create table title (
  rowid_    integer primary key,
  tconst    text not null unique,
  kind      text not null,
  title     text not null,
  orig      text,
  year      integer,
  end_year  integer,
  runtime   integer,
  genres    text not null default '',
  votes     integer not null default 0,
  rating    real not null default 0,
  -- The weighted rank every computed top list is ordered by. See applyRank().
  -- NULL for a title nobody has rated, which is most of the corpus: SQLite sorts NULL
  -- last under DESC, so an unrated title falls off the end of a list rather than
  -- landing mid-pack on a score that is purely the prior.
  --
  -- NO BACKTICKS IN THIS STRING. It is a template literal, so one backtick in a comment
  -- ends the schema mid-table and the parse errors it produces point at the lines AFTER
  -- it, naming neither the string nor the character.
  rank      real,
  -- normalized forms, precomputed once so every query is a lookup not a transform
  ntitle    text not null default '',
  norig     text not null default '',
  dtitle    text not null default ''
);
-- kind, rank and votes are DENORMALISED from title on purpose: with them here,
-- "top 250 sci-fi films" is one seek into ix_tg_rank and no sort at all. Reaching
-- through to the title table for either would make every per-genre list a scan plus
-- a sort, which is the 13ms-vs-0.4ms difference this whole layer exists for.
--
-- votes arrived last, on 2026-09-02, and the reason is worth keeping: rank was
-- denormalised and votes was not, but VOTES IS THE DEFAULT BROWSE ORDER -- so the
-- ordinary case took the slow path the exceptional one had been fixed for. Measured on
-- the live NAS index, /api/browse?genre=Comedy cost 3.66s: SQLite seeks ix_tg_rank for
-- the genre, then does a primary-key lookup into title for EVERY matching row just to
-- read votes, then sorts the lot in a temp b-tree -- twice, because the count runs the
-- same join. (No backticks in here: this block is inside a template literal.)
create table title_genre (
  title_rowid integer not null,
  genre       text not null,
  kind        text not null default '',
  rank        real,
  votes       integer not null default 0
);
create table meta (key text primary key, value text not null);

${BROWSE_COUNT_SCHEMA}

-- People, and the credits that connect them to titles.
--
-- Integer rowids rather than the text ids: at 1.4M credit rows they are what keep the
-- reverse lookup an index seek instead of a string comparison, and this table is
-- roughly the size of the title table itself.
create table person (
  rowid_     integer primary key,
  nconst     text not null unique,
  name       text not null,
  birth_year integer,
  death_year integer,
  -- How well known this person is, denormalised for the same reason title.rank is: the
  -- people search has to visit every name that matches a prefix to find the best eight,
  -- and deriving these per query means joining each of them back through title_principal.
  -- Measured on the real index, the query for "tom" went 1.5ms with these and 29ms without.
  --
  -- Filled by buildPersonSearchIndex() in ./people.ts, which owns them together with the
  -- FTS index that reads them, and which runs on EVERY build -- top_votes is about titles,
  -- and titles move on a night when the carried-forward cast does not.
  top_votes  integer not null default 0,
  credits    integer not null default 0
);
create table title_principal (
  title_rowid  integer not null,
  person_rowid integer not null,
  -- IMDb's own vocabulary, whichever of it castCategories admits. Kept verbatim
  -- rather than folded to "cast"/"crew", because a person page groups by it.
  category     text not null,
  -- Ordering within the title. Billing order for cast, and the only signal we have
  -- for who is the lead.
  ordering     integer not null,
  -- The role as IMDb records it, already unwrapped from its JSON array form.
  characters   text
);

-- Episodes, with their own ratings, so "every Star Trek episode over 8.0" is a query
-- against local SQLite rather than a walk of somebody else's API.
--
-- ITS OWN TABLE AND NEVER MORE ROWS IN title. An episode is not a browsable title: it must
-- not appear in search, in a browse grid, on a shelf or in a facet count. Adding tvEpisode
-- to index.titleTypes would put the whole of title.episode in front of every query in the
-- product in order to serve one pane -- an order of magnitude more rows than the index
-- holds today, and every vote-ordered list filling with individual episodes of popular
-- shows. The census is on episodeSeriesMinVotes in ./config.ts, which owns it.
--
-- parent is the SERIES tconst as TEXT rather than a title_rowid, and that is a departure
-- from title_principal above worth stating. Rowids are assigned by insertion order while
-- streaming title.basics, which is why the cast carry-forward has to remap them through
-- tconst -- but this table is rebuilt from the dump on every build and is never carried,
-- so there is no remapping hazard to design against. What the text key buys is that the
-- one query this table exists for arrives holding a series tconst and is answered without
-- a join at all.
--
-- rating IS NULLABLE, and that is the column's whole point. Fewer than half the episodes
-- this build keeps carry a ratings row at all -- a brand-new episode has none for weeks,
-- and the census is on episodeSeriesMinVotes in ./config.ts. Writing 0.0 for those would
-- mean "rated terribly" where the truth is "not rated yet": a filter for "over 8.0" has to
-- exclude both, but a pane has to be able to say "no score yet" for the second and "1.9"
-- for the first. votes stays NOT NULL because nobody having voted IS a count, and it is
-- zero.
--
-- (No backticks anywhere in here: this block is inside a template literal.)
create table episode (
  rowid_  integer primary key,
  tconst  text not null unique,
  parent  text not null,
  season  integer not null,
  number  integer not null,
  -- From title.basics under the EPISODE's own tconst. Null when the two dumps disagree,
  -- the same way a credit can outrun name.basics.
  title   text,
  rating  real,
  votes   integer not null default 0,
  year    integer
);
${CROSSWALK_SCHEMA}${PERSON_CROSSWALK_SCHEMA}`;

/**
 * The FTS index every title query runs through, over the normalized columns.
 *
 * `content=` makes it an external-content table: the text is not duplicated, FTS just
 * indexes what `title` already holds.
 *
 * A named function beside the schema for the reason `EXPLODE_GENRES` is exported -- a
 * fixture that builds this by hand can disagree with what the real builder writes, and then
 * a query passes its test and fails in production. It is also what lets a test assert that
 * a change somewhere else left the title answers alone.
 */
export function buildTitleSearchIndex(db: Database): void {
  db.run(
    "create virtual table tfts using fts5(ntitle, norig, dtitle, content='title', content_rowid='rowid_', " +
      "tokenize='unicode61 remove_diacritics 2')",
  );
  db.run("insert into tfts(rowid, ntitle, norig, dtitle) select rowid_, ntitle, norig, dtitle from title");
}

/**
 * Derive `title_genre` from the comma-separated `title.genres` column.
 *
 * Exported beside the schema for the same reason: a fixture that fills the join table
 * by hand can disagree with how the real index fills it, and then a query passes its
 * test and fails in production.
 *
 * **Run this AFTER `applyRank`, never before.** It copies `kind` and `rank` across, so
 * exploding first would write a table of NULL ranks and every per-genre list would come
 * back empty-ish and in the wrong order -- with no error anywhere to say why. `buildRankLayer`
 * is the one caller that gets the order right, and it exists so nobody has to remember this.
 */
export const EXPLODE_GENRES = `
insert into title_genre (title_rowid, genre, kind, rank, votes)
with split(id, one, rest) as (
  select rowid_, '', genres || ',' from title where genres != ''
  union all
  select id, substr(rest, 1, instr(rest, ',') - 1), substr(rest, instr(rest, ',') + 1)
  from split where rest != ''
)
select s.id, s.one, t.kind, t.rank, t.votes from split s join title t on t.rowid_ = s.id where s.one != ''
`;

/**
 * Every index the read path depends on, in ONE place, grouped by the stage that builds it.
 *
 * > [!IMPORTANT] This list exists so a TEST FIXTURE can be faithful, and that is not tidying
 * > These eleven statements used to be inline `db.run(...)` calls spread across four
 * > functions, with nothing exporting them. The consequence was not untidiness, it was that
 * > **no test in this tree could build a fixture the query planner treats like production**.
 * > Measured 2026-09-05 while writing `query-plans.test.ts`: a fixture built from `SCHEMA` +
 * > `EXPLODE_GENRES` at n=5,000, 20,000, 60,000 and 150,000 rows returned `SCAN` for every
 * > query at every size, with and without `analyze`, because it had no indexes at all.
 * > `browse.test.ts` has the same blind spot -- it pins the vote-floor POLICY correctly and
 * > could not have noticed the 807ms plan that `ix_tg_rank` was serving.
 *
 * GROUPED, not one flat list, because WHEN an index is built is part of the build's
 * semantics: the rank indexes must follow `applyRank` and `EXPLODE_GENRES` or they index a
 * column of nulls, and the cast indexes must follow the stage that fills their tables.
 * `allIndexes()` flattens it for a fixture, which has no such ordering to respect.
 */
export const INDEXES = {
  /**
   * Built by `buildRankLayer`, AFTER `applyRank` and `EXPLODE_GENRES`.
   *
   * **The column order is the whole optimisation and none of it is arbitrary.** The rule
   * these three share: pin the equality columns a caller actually fixes, put the sort column
   * next, and put a column that is only ever FILTERED last -- where it is still covered, so
   * the filter is answered from the index rather than by reaching into `title`.
   */
  rank: [
    // (kind, rank desc): `rankedSeek` pins one kind at a time precisely so this can be read
    // in order. See its docstring for why leaving `kind` free was the 933ms "Best in Drama".
    "create index ix_rank on title(kind, rank desc)",
    /*
      `kind` sits AFTER `rank desc`, and this was measured rather than reasoned.

      It was `(genre, kind, rank desc)` until 2026-09-05, which is the same mistake
      `ix_tg_votes` below already carries a comment about -- with `kind` in the middle the
      ordering is split across four groups, so a genre browse that pins NO kind cannot read
      rank in order and SQLite sorts the whole genre in a temp b-tree instead. Every
      computed top list in the product runs exactly that query (`browseIndex` with
      `sort: "rank"`, and `browseMembers` under it), so all of them paid it.

      Measured on the real 2.18 GB index, `?genre=Drama&sort=rank`:
        (genre, kind, rank desc)   807.48 ms   SEARCH ix_tg_votes + USE TEMP B-TREE
        (genre, rank desc, kind)     0.11 ms   SEARCH ix_tg_rank, no sort
      and at offset 200, which is what a reader paging a top-250 list hits:
        (genre, kind, rank desc)  1074.78 ms
        (genre, rank desc, kind)     0.24 ms

      It costs NOTHING: it is a reshape rather than an addition, 48.7 MB either way. And the
      kind-PINNED form `rankedSeek` runs got faster too (0.34ms -> 0.15ms), so there is no
      trade here at all -- one index now serves both shapes, which the old order did not.

      The trailing `title_rowid, votes` are payload, +9.9 MB, taking the seek to 0.07 ms and
      the offset page to 0.13 ms by covering the join key so the row lookup never leaves the
      index. Bytes are the cheap axis on a file written once and read forever.
    */
    "create index ix_tg_rank on title_genre(genre, rank desc, kind, title_rowid, votes)",
    /*
      The kind-free ranked browse with NO genre either -- "finderr Top 250" itself.

      `ix_rank` leads with `kind`, so it cannot serve a query that pins none, and the planner
      fell back to `SCAN t | USE TEMP B-TREE FOR ORDER BY` over all 541,657 ranked rows.
      Measured on the real index: 82.23 ms -> 0.06 ms, and 0.05 ms at offset 200. 15.9 MB.

      Not merged into `ix_rank` by dropping its leading column: `rankedSeek` pins `kind` on
      every call and would lose its seek. These are two genuinely different questions, so
      they are two indexes -- unlike `ix_tg_genre(genre)`, removed above because it WAS a
      leading-column prefix of `ix_tg_rank` and so served nothing that index did not.
    */
    "create index ix_rank_all on title(rank desc)",
    // The VOTES twin of ix_tg_rank, and the column order is not the same shape by accident.
    // `kind` sits LAST here, after the sort column, because a genre browse most often pins
    // no kind at all -- with `kind` in the middle the ordering would be split across two
    // groups and SQLite would fall back to a temp b-tree for the one query this exists to
    // remove. Last, it is still covered, so `?genre=Comedy&kind=movie` filters from the
    // index rather than from `title`. Both queries are answered without touching the title
    // table at all, which is what takes the count from 1151ms to a seek.
    "create index ix_tg_votes on title_genre(genre, votes desc, kind)",
  ],

  /** Built after the cast, crosswalk and people-search stages have filled their tables. */
  secondary: [
    "create index ix_votes on title(votes desc)",
    /*
      (year, votes desc) -- WIDENED from (year), not added beside it.

      `ix_year(year)` is a leading-column PREFIX of this, so this serves every query the
      narrow one served and the pair would be two indexes that are genuinely one. That is the
      same argument already made for `ix_kind` and for the removal of `ix_tg_genre`; a
      separate `ix_year_votes` shipped first and was folded in here, saving 14 MB against
      carrying both.

      **What the extra column buys, and the trap in it.** A decade browse asks `year >= ? and
      year <= ?`, and a RANGE on the leading column means `votes` is not ordered ACROSS the
      range -- so no index can serve `order by votes desc` over ten years, and SQLite is right
      to refuse. Measured: with the range query still in place, adding this changed
      `decade=2010` by nothing at all, 161.11 ms before and 164.61 ms after, same plan.

      It pays only because `browseIndex` SPLITS a decade into ten single-year seeks and merges
      them (`decadeRows` in `search.ts`). One pinned year is a seek at 0.14 ms; ten merged is
      0.92 ms against 161 ms. **The widening and the split are one change and neither works
      alone** -- do not narrow this back believing the split covers it, and do not delete the
      split believing the index does.
    */
    "create index ix_year on title(year, votes desc)",
    // (kind, votes desc), not (kind). The narrower index is a leading-column PREFIX of this
    // one and so serves nothing this does not -- the same argument that removed
    // ix_tg_genre below. What the extra column buys: `?kind=movie` was 466ms to count and
    // 354ms to page on the live NAS index, because SQLite picked ix_kind, walked every
    // movie row to test `votes`, and then sorted. Both halves are now covered seeks.
    "create index ix_kind on title(kind, votes desc)",
    // The stopword-only query's whole cost, removed. PARTIAL so it holds ~24k rows of 1.27M
    // (672 KB, 2.1s to build) and COVERING so `title like 'the %'` is answered from index
    // pages without fetching a single row -- that fetch was a 51.8ms median and a 1461ms worst
    // case. See `search-stopwords.ts`, which owns the DDL so its floor cannot drift from the
    // floor the query asks for.
    POPULAR_TITLE_INDEX,
    "create index ix_tg_title on title_genre(title_rowid)",
    // ix_tg_genre(genre) is gone: ix_tg_rank leads with `genre`, so it serves every query
    // the narrower index served -- a leading-column prefix is the one case where two
    // indexes are genuinely one. Keeping both would cost build time and pages for nothing.
    // ix_tp_person is the REVERSE index and the entire reason the cast tables exist:
    // person -> filmography. ix_tp_title serves the other direction, which the title
    // page needs to turn a cast name into a link.
    "create index ix_tp_person on title_principal(person_rowid)",
    "create index ix_tp_title on title_principal(title_rowid)",
    "create index ix_person_name on person(name)",
    /*
      ONE COVERING INDEX over `episode`, and it used to be two.

      The payload columns EARN their bytes and stay: every column the pane and `episodesOf`
      read is in the trailing list, so SQLite answers a season list without touching the
      table's own pages. Measured against a slim non-covering `(parent, season, number)`:
      20-30% slower warm, 4-13 ms cold on a title page, and up to 496 ms cold on a
      15,456-episode soap. That is the shape aannarr's standing rule asks for -- bytes are
      the cheap axis on a file written once and read forever.

      **The SECOND index did not earn them, and that was measured rather than assumed.**
      `ix_ep_rating(parent, rating desc, ...)` was added on the same rule, unmeasured, at
      445 MB. Benchmarked across 30 query/parent pairs, `parent-only` and `rating-only` match
      each other within noise on all of them -- the two are interchangeable, and keeping both
      bought nothing. The single measurable difference was `minRating=8.5` against that same
      soap: 0.016 ms with the rating index against 0.662 ms without. **445 MB for 0.65 ms on
      the corpus's worst case** is the one direction the rule does not point.

      On the deployment array those bytes are worse than idle: the index is read into the page
      cache at boot (see `warmPageCache` in `src/server/live-index.ts`) at ~300 MB/s, so 445 MB
      of index nobody queries is a second and a half added to every boot and every swap.

      **Exactly one index on `parent` must survive.** With neither, `queryEpisodes` scans
      7.7M rows: 400-800 ms warm and 4.1 s cold. This is not a candidate for further trimming.

      NOTE, and the comment this replaces had it wrong: every `queryEpisodes` plan DOES sort,
      because the order is `season = 0, season, number` and that leading expression is not a
      column any index can carry. It is cheap -- 0.03-1.5 ms, against 0.042 vs 0.071 ms for an
      index-served order on Breaking Bad -- so it is left alone deliberately. Season 0 sorting
      last is a product rule (`orderSeasons`), and paying a millisecond to keep it is correct.
    */
    "create index ix_ep_parent on episode(parent, season, number, tconst, title, rating, votes, year)",
  ],
} satisfies Record<string, readonly string[]>;

/**
 * The vote floor a broad browse applies, and the one `browse_count.n_floor` is built at.
 *
 * Declared HERE rather than in `search.ts` because the build has to bake it into a stored
 * column: a floor the query applies and a floor the table was built at are the same number or
 * the count is wrong, and only one of them can be the owner. `search.ts` imports it, and
 * `INDEX_STAGES.browseCounts` carries it in its recipe so moving it orders a rebuild rather
 * than silently invalidating every stored total.
 */
export const BROWSE_VOTE_FLOOR = 1000;

/**
 * Fill `browse_count`: one row per (kind, genre, year), plus the any-genre rows.
 *
 * Runs AFTER `title_genre` is exploded and after `applyRank`, because it reads both. The
 * second insert is not a duplicate of the first -- see the schema comment: it is the
 * `genre = ''` grain that makes an unfiltered total possible without double-counting a title
 * that has more than one genre.
 *
 * `coalesce(year, 0)` because a title with no year still has to be counted somewhere, and 0
 * is a year no filter can ask for -- so those rows are included in a total and excluded from
 * every year and decade slice, which is exactly what the live query does with a null year.
 */
export function buildBrowseCounts(db: Database): number {
  const grain = `count(*), sum(case when t.votes >= ${BROWSE_VOTE_FLOOR} then 1 else 0 end),
                 sum(case when t.rank is not null then 1 else 0 end)`;
  db.run("delete from browse_count");
  db.run(
    `insert into browse_count (kind, genre, year, n, n_floor, n_ranked)
     select t.kind, g.genre, coalesce(t.year, 0), ${grain}
     from title t join title_genre g on g.title_rowid = t.rowid_
     group by t.kind, g.genre, coalesce(t.year, 0)`,
  );
  db.run(
    `insert into browse_count (kind, genre, year, n, n_floor, n_ranked)
     select t.kind, '', coalesce(t.year, 0), ${grain}
     from title t group by t.kind, coalesce(t.year, 0)`,
  );
  return (db.query("select count(*) c from browse_count").get() as { c: number }).c;
}

/**
 * The `meta` key holding the genres worth a shelf, computed once at build.
 *
 * Exported so `SearchEngine.topGenres` reads the same name the builder writes -- two string
 * literals is exactly the drift this file's other single-owner rules exist to prevent.
 */
export const SHELF_GENRES_META_KEY = "shelf_genres";

/** How many genres the front page can draw. Stored generously; a caller slices. */
const SHELF_GENRES_STORED = 12;

/**
 * Which genres have enough well-rated titles to be worth a shelf -- answered at BUILD time.
 *
 * > [!IMPORTANT] This is the purest form of "runtime beats build time" in the tree
 * > The answer is a pure function of the finished index, so it is **constant for the whole
 * > life of the file** -- and it was being recomputed on every uncached front-page assembly.
 * > Measured on the real 2.18 GB index: **25.05 ms**, as an aggregate over `title_genre`
 * > joined to `title` with a temp b-tree for the GROUP BY and a second for the ORDER BY.
 * > Reading it back out of `meta` is a single row.
 * >
 * > The build pays it once, unattended, at 09:00 UTC. Nobody is waiting for that; somebody
 * > is always waiting for the front page.
 *
 * The floors are the ones `topGenres` used and are deliberately unchanged -- this moves WHEN
 * the question is answered, never WHAT the answer is, so a build and a live query must agree
 * exactly. `search.ts`'s fallback runs this same SQL against an index built before the key
 * existed, which is the one place the two copies must match; the constants live here because
 * this is where the answer is produced.
 */
export function computeShelfGenres(db: Database): string[] {
  return (
    db
      .query(
        `select g.genre, count(*) c
         from title_genre g join title t on t.rowid_ = g.title_rowid
         where t.votes >= 20000 and t.rating >= 7.0
         group by g.genre order by c desc limit ?`,
      )
      .all(SHELF_GENRES_STORED) as { genre: string }[]
  ).map((r) => r.genre);
}

/**
 * Every index, flat, for a test fixture that has no build order to respect.
 *
 * The spellfix vocabulary's index is deliberately absent: it is created inside the vocabulary
 * stage against a table that stage also creates, and a fixture without that table would fail
 * on the statement rather than on anything it was testing.
 */
export function allIndexes(): string[] {
  return Object.values(INDEXES).flat();
}

/** What ranked the index, recorded so a list page can say how it was ordered. */
export interface RankPrior {
  /** The prior's strength in votes -- `index.rankPriorVotes`. */
  c: number;
  /** The corpus mean rating it pulls toward, MEASURED rather than configured. */
  mean: number;
  /** How many titles carry a rank at all. */
  ranked: number;
}

/**
 * The Bayesian weighted rank, written into `title.rank`.
 *
 *     rank = (v / (v + C)) * R  +  (C / (v + C)) * m
 *
 * where `v` is the vote count, `R` the title's own rating, `C` the prior's strength in
 * votes and `m` the corpus mean. It is the same shape IMDb's own Top 250 uses, and
 * measured against the real index on 2026-09-01 it reproduces IMDb's head to within a
 * couple of positions -- Shawshank, The Godfather, The Dark Knight, Return of the King,
 * Schindler's List. It will never match exactly, because IMDb's vote filtering is
 * unpublished. **So it ships as "finderr Top 250" and never as IMDb's.**
 *
 * **`m` IS MEASURED, NOT WRITTEN DOWN.** It is one `avg()` over the table we have just
 * filled, and it is measured over exactly the titles clearing `C` votes -- the pool whose
 * ratings the prior is claiming to speak for, which is what makes the two constants one
 * decision instead of two. A literal here would be right on the day it was typed and
 * would then quietly stop describing the corpus on every rebuild after it.
 *
 * **An unrated title gets NULL rather than the prior.** With no votes the formula
 * collapses to `m` exactly, so 1.2M unrated rows would tie at the corpus mean and sit
 * ABOVE every genuinely badly-rated film -- a well-formed number that means "we know
 * nothing", which is the worst kind of wrong answer. NULL sorts last under `desc` and
 * says so.
 *
 * Takes the database rather than opening one, so the policy can be exercised against a
 * handful of rows in a temp file.
 */
export function applyRank(db: Database, c: number): RankPrior {
  // Refuse rather than write NULL over the whole corpus. `validate()` already rejects a
  // bad `rankPriorVotes`, but a hand-built config that never went through `loadConfig`
  // can reach here -- and the failure mode is silent: `votes + undefined` is NULL, so
  // EVERY row loses its rank and every list renders empty with nothing in any log to say
  // why. A build that cannot rank must fail at the build, not at the browser.
  if (!Number.isFinite(c) || c < 1) {
    throw new Error(`applyRank: prior strength must be a number >= 1, got ${c}`);
  }
  const mean =
    (db.query("select avg(rating) m from title where votes >= ?").get(c) as { m: number | null }).m ?? 0;
  db.run(
    `update title set rank = case when votes > 0 and rating > 0
       then (votes * 1.0 / (votes + ?)) * rating + (? * 1.0 / (votes + ?)) * ?
       else null end`,
    [c, c, c, mean],
  );
  const ranked = (db.query("select count(*) n from title where rank is not null").get() as { n: number }).n;
  return { c, mean, ranked };
}

/**
 * Rank every title, explode the genres, and index both -- in the one order that works.
 *
 * One function because the three steps are one fact with three storage sites: the rank on
 * `title`, its copy on `title_genre`, and the two indexes that make either an ordered seek
 * instead of a sort. Splitting them across the builder is how the copy on `title_genre`
 * would eventually be filled before the value it copies exists.
 *
 * Measured on the Mac against the real 1.28M-row index: prior 16ms, rank update 1.5s,
 * explode 2.1s, indexes 3.3s -- so the whole layer is under 7s on a build that costs
 * minutes (BUILD COST, module docstring). It rides the existing 09:00 refresh and
 * schedules nothing new.
 */
export function buildRankLayer(db: Database, cfg: Config, log: (msg: string) => void = () => {}): RankPrior {
  const t0 = Date.now();
  const prior = applyRank(db, cfg.index.rankPriorVotes);
  db.run("begin");
  db.run(EXPLODE_GENRES);
  db.run("commit");
  for (const sql of INDEXES.rank) db.run(sql);
  log(
    `rank: ${prior.ranked.toLocaleString()} titles ranked, prior C=${prior.c.toLocaleString()} ` +
      `mean=${prior.mean.toFixed(3)} in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
  return prior;
}

/**
 * Build the index into `dest`. Returns stats; does not promote.
 */
export async function buildIndex(
  cfg: Config,
  dumpDir: string,
  dest: string,
  log: (msg: string) => void = console.log,
): Promise<BuildStats> {
  const started = Date.now();
  if (existsSync(dest)) unlinkSync(dest);
  for (const suffix of ["-wal", "-shm"]) {
    const p = `${dest}${suffix}`;
    if (existsSync(p)) unlinkSync(p);
  }
  mkdirSync(dest.slice(0, dest.lastIndexOf("/")), { recursive: true });

  // Before the first connection: the vocabulary stage below needs an extension-capable
  // SQLite, and on macOS that is a process-global choice that cannot be made later.
  prepareSqlite(log);

  /*
    SQLite's scratch files go BESIDE THE INDEX, and this is not a tidiness choice.

    > [!CAUTION] `temp_store = memory` OOM-KILLED THE BUILD ON THE NAS. Measured 2026-09-05.
    > The container runs under `mem_limit: 1500m`. Creating the covering index over the
    > 7,799,819-row `episode` table needs a sorter far larger than that, and with
    > `temp_store = memory` the sorter has nowhere to go but RAM -- so the build was SIGKILLed
    > at "building secondary indexes", `index refresh build exited 137`, leaving a 1.42 GB
    > `titles.new.db` that was correctly never promoted. The old index kept serving, which is
    > the one thing that went right.
    >
    > It had never been caught because the episode stage had never built on the NAS: that
    > deployment was still on a pre-episode index, and every earlier build of this stage ran
    > on a dev machine with no cgroup limit at all.

    So the sorter spills to DISK. That is slower -- on nine spinning disks in RAID5,
    noticeably so -- and under the standing rule that is the correct side of the trade:
    build time is the cheap axis, and a build that dies is infinitely slow.

    **The directory has to be named explicitly.** SQLite's default scratch locations are
    `/var/tmp`, `/usr/tmp`, `/tmp`; the container mounts its root `read_only: true` and gives
    `/tmp` a **64 MB tmpfs** -- which is both far too small AND counted against the very
    memory limit being escaped. The data directory is the one writable path with real disk
    behind it, so both the pragma and `SQLITE_TMPDIR` point there. Both, because the pragma is
    deprecated and the env var is read when SQLite first needs scratch space; setting one and
    not the other is a silent fall back to the 64 MB tmpfs.
  */
  const scratch = dest.slice(0, dest.lastIndexOf("/"));
  process.env.SQLITE_TMPDIR = scratch;

  const db = new Database(dest, { create: true });
  // These are safe here: we are building a throwaway file. If the process dies the
  // partial DB is discarded, never promoted.
  db.run("pragma journal_mode = off");
  db.run("pragma synchronous = off");
  db.run("pragma temp_store = file");
  db.run(`pragma temp_store_directory = '${scratch.replace(/'/g, "''")}'`);
  db.run(SCHEMA);

  // --- ratings first: small (8.6 MB) and needed while streaming basics
  log("reading title.ratings ...");
  const ratings = new Map<string, { rating: number; votes: number }>();
  for await (const cols of streamTsv(`${dumpDir}/title.ratings.tsv.gz`, "title.ratings")) {
    const votes = intOrNull(cols[2]);
    if (votes === null) continue;
    ratings.set(cols[0], { rating: Number.parseFloat(cols[1]) || 0, votes });
  }
  log(`  ${ratings.size.toLocaleString()} rated titles`);

  /*
    --- episodes, part ONE of two, and it runs BEFORE the basics stream by necessity
    rather than by preference.

    An episode's NAME and YEAR live only in title.basics -- the most expensive file we read,
    at 12.76M rows and 226 MB. Deciding WHICH episodes to keep needs title.episode and the
    ratings map, and both are available right here, so the skeleton rows go in first and the
    basics pass we are making anyway fills the two columns only it carries. The alternative
    is a SECOND full read of title.basics, which would cost more than this whole stage does
    (BUILD COST, module docstring) on a build that is already over its budget on the NAS.

    Deliberately NOT solved with a JS membership set of the kept episode ids. That would
    make the probes in the loop below unnecessary and cost almost nothing in time -- but it
    is over a million live entries held across the whole basics pass, beside the ratings map
    that is already the largest thing this build holds, and docker-compose.yml runs the
    container under a 1500 MB limit. The probes are cheap enough that the memory would be
    bought for nothing.
  */
  const episodeRows = await episodeStage(db, cfg, dumpDir, ratings, log);
  const nameEpisode = db.prepare("update episode set title = ?, year = ? where tconst = ?");

  // --- basics: the big one (226 MB compressed, 12.7M rows)
  const keepTypes = new Set(cfg.index.titleTypes);
  const insert = db.prepare(
    "insert or ignore into title (tconst, kind, title, orig, year, end_year, runtime, genres, votes, rating, ntitle, norig, dtitle) " +
      "values (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );

  log("reading title.basics ...");
  let scanned = 0;
  let kept = 0;
  db.run("begin");
  for await (const cols of streamTsv(`${dumpDir}/title.basics.tsv.gz`, "title.basics")) {
    scanned++;
    const [tconst, kind, primaryTitle, originalTitle, isAdult] = cols;

    // Episodes, part TWO of two: the name and the year, which this file alone carries.
    //
    // The probe runs for EVERY tvEpisode row rather than being gated on a set of the ones
    // the stage kept, which is the trade part one names: it is one index seek into a table
    // an order of magnitude smaller than the rows being scanned, and it holds nothing.
    // `episodeRows` guards it so a build with no episode dump does not pay for it at all.
    if (episodeRows > 0 && kind === "tvEpisode") {
      nameEpisode.run(primaryTitle || null, intOrNull(cols[5]), tconst);
    }

    if (!keepTypes.has(kind)) continue;
    if (!cfg.index.includeAdult && isAdult === "1") continue;
    if (!primaryTitle) continue;

    const r = ratings.get(tconst);
    const orig = nullable(originalTitle);
    const nt = normalizeStripped(primaryTitle);
    const no = orig ? normalizeStripped(orig) : "";
    // One despaced blob covering both variants -- this is what makes "buda pest"
    // and "nilecity" resolve.
    const dt = `${despace(primaryTitle)} ${orig ? despace(orig) : ""}`.trim();

    insert.run(
      tconst,
      kind,
      primaryTitle,
      orig,
      intOrNull(cols[5]),
      intOrNull(cols[6]),
      intOrNull(cols[7]),
      nullable(cols[8]) ?? "",
      r?.votes ?? 0,
      r?.rating ?? 0,
      nt,
      no,
      dt,
    );
    kept++;
    if (kept % 200_000 === 0) log(`  ${kept.toLocaleString()} kept ...`);
  }
  db.run("commit");
  log(`  scanned ${scanned.toLocaleString()}, kept ${kept.toLocaleString()}`);

  const episodesKept = pruneOrphanEpisodes(db, episodeRows, log);

  // --- the rank column, then genres exploded into a join table carrying a copy of it.
  // One step, in that order, because the copy cannot precede the value. Facet counts are
  // an indexed group-by over the same table.
  log("ranking and exploding genres ...");
  const prior = buildRankLayer(db, cfg, log);
  const genreRows = (db.query("select count(*) c from title_genre").get() as { c: number }).c;
  log(`  ${genreRows.toLocaleString()} genre rows`);

  log("building FTS index ...");
  buildTitleSearchIndex(db);

  // --- Typo tolerance, on disk.
  //
  // `unicode61` above matches whole words, so it cannot survive a typo -- "brigerton"
  // finds nothing. That gap used to be filled by a trigram index built in RAM at every
  // boot, costing 1,514 MB and ~9M live objects, which kept the garbage collector busy
  // enough to burn 14.5% of a core on an idle container. Building the vocabulary HERE
  // means the work happens once per index rather than once per process start, and the
  // result is paged off disk by SQLite instead of traced by the collector.
  //
  // Failing to load the extension is not fatal: the index is still valid and search
  // still works, it just loses the fuzzy tier. A build box without the extension must
  // not produce an index that cannot be promoted.
  buildVocabulary(db, cfg, log);

  const cast = await castStage(db, cfg, dumpDir, log);
  // AFTER the cast stage either built or carried the people, and never inside it: both
  // branches produce the same `person` table and both need the same search layer over it.
  log("indexing people for search ...");
  buildPersonSearchIndex(db, log);
  const idRows = crosswalkStage(db, dumpDir, log);
  // AFTER the cast stage, not beside it: this one keeps only people `person` already holds,
  // so running it first would restrict against an empty table and keep nothing.
  const personIdRows = personCrosswalkStage(db, dumpDir, log);

  log("building secondary indexes ...");
  for (const sql of INDEXES.secondary) db.run(sql);

  log("counting every browse slice ...");
  const countRows = buildBrowseCounts(db);
  log(`  ${countRows.toLocaleString()} browse-count rows`);
  const shelfGenres = computeShelfGenres(db);

  const now = new Date().toISOString();
  const setMeta = db.prepare("insert or replace into meta (key, value) values (?, ?)");
  setMeta.run("built_at", now);
  setMeta.run("rows", String(kept));
  setMeta.run("scanned", String(scanned));
  setMeta.run("rated", String(ratings.size));
  setMeta.run("genre_rows", String(genreRows));
  setMeta.run("title_types", cfg.index.titleTypes.join(","));
  setMeta.run("credit_rows", String(cast.creditRows));
  setMeta.run("people", String(cast.people));
  setMeta.run("cast_min_votes", String(cfg.index.castMinVotes));
  setMeta.run("episode_rows", String(episodesKept));
  setMeta.run("episode_series_min_votes", String(cfg.index.episodeSeriesMinVotes));
  setMeta.run("id_rows", String(idRows));
  setMeta.run("person_id_rows", String(personIdRows));
  // How the lists were ranked, so a list page can say it rather than restate a constant
  // that has since moved. `rank_prior_mean` is the measured corpus mean, not a setting.
  setMeta.run("rank_prior_votes", String(prior.c));
  setMeta.run("rank_prior_mean", prior.mean.toFixed(4));
  setMeta.run("ranked", String(prior.ranked));
  setMeta.run(SHELF_GENRES_META_KEY, shelfGenres.join(","));
  // WHICH stages this file carries, so the next release can tell that an index predates a
  // stage rather than only that it cannot read one. Written here, after every stage has
  // run, and never by a stage itself -- see `stampStages`.
  stampStages(db, cfg);

  db.run("pragma optimize");
  db.close();

  const bytes = statSync(dest).size;
  const ms = Date.now() - started;
  log(
    `built ${kept.toLocaleString()} titles -> ${(bytes / 1e6).toFixed(1)} MB in ${(ms / 1000).toFixed(1)}s`,
  );
  return {
    scanned,
    kept,
    rated: ratings.size,
    genreRows,
    creditRows: cast.creditRows,
    people: cast.people,
    episodeRows: episodesKept,
    idRows,
    personIdRows,
    bytes,
    ms,
  };
}

/**
 * Bulk-load the `tconst -> tmdb/tvdb` crosswalk, so no render path ever buys one.
 *
 * ADDITIVE AND OPTIONAL, exactly like the cast stage above and for the same reason: a
 * build box that cannot reach the source must still produce a promotable index. A missing
 * crosswalk costs nothing but the calls we were making anyway -- both providers still
 * resolve their own ids and park them in `kv`, which is what they did before this existed.
 * `title_ids` is simply empty and every lookup misses.
 *
 * **READS THE DISK AND NEVER THE NETWORK**, which is the same division the IMDb dumps
 * already follow: `src/jobs/build-index.ts` downloads, this builds. A build stage that
 * fetched would make every index test that runs it reach the internet, and the cast tests
 * caught exactly that.
 */
function crosswalkStage(db: Database, dumpDir: string, log: (m: string) => void): number {
  const path = `${dumpDir}/${TITLE_CROSSWALK.file}`;
  if (!existsSync(path)) {
    log("no id crosswalk on disk -- providers will resolve their own ids, as before");
    return 0;
  }

  log("loading the id crosswalk ...");
  const rows = parseCrosswalkCsv(readFileSync(path, "utf8"));
  const kept = loadCrosswalk(db, rows);
  log(`  ${kept.toLocaleString()} of our titles carry an id (${rows.length.toLocaleString()} in the source)`);
  return kept;
}

/**
 * Bulk-load the `TMDB person id -> nconst` crosswalk, so a cast tile can link by id.
 *
 * ADDITIVE AND OPTIONAL like every stage above it, and the degraded answer is the one the
 * product already shipped for months: with no `person_external` a cast name is linked by the
 * title-scoped name join or not at all. Nothing breaks, fewer names are live.
 *
 * DEPENDS ON THE CAST STAGE having run -- `loadPersonCrosswalk` keeps only people `person`
 * holds. On a build with no people dumps that is nobody, which is correct rather than
 * unfortunate: without `person` there are no person pages to link to either.
 */
function personCrosswalkStage(db: Database, dumpDir: string, log: (m: string) => void): number {
  const path = `${dumpDir}/${PERSON_CROSSWALK.file}`;
  if (!existsSync(path)) {
    log("no person crosswalk on disk -- cast names link by the title-scoped name join, as before");
    return 0;
  }

  log("loading the person crosswalk ...");
  const rows = parsePersonCrosswalkCsv(readFileSync(path, "utf8"));
  const kept = loadPersonCrosswalk(db, rows);
  log(
    `  ${kept.toLocaleString()} of our people carry a TMDB id (${rows.length.toLocaleString()} in the source)`,
  );
  return kept;
}

// ---------------------------------------------------------------------------
// Episodes
// ---------------------------------------------------------------------------

/**
 * Fill `episode` from `title.episode.tsv.gz`, floored on the SERIES.
 *
 * **THE FLOOR IS ON THE PARENT, AND PUTTING IT ON THE EPISODE WOULD BE THE BUG.** IMDb
 * ratings accumulate over weeks, so an episode that aired on Tuesday has almost no votes on
 * Wednesday -- an episode-level floor would delete exactly the episodes a reader asks about
 * first, on the one day they want them, while keeping every episode of every show that
 * finished airing in 2004. The series has had years to earn its own votes, so flooring
 * there keeps a popular show's complete run from the day each episode airs. The threshold
 * and the counts behind it live on `episodeSeriesMinVotes` in `./config.ts`, which owns
 * them.
 *
 * **A MISSING DUMP IS NOT AN ERROR**, the same rule the cast stage follows for the same
 * reason: a checkout that has never fetched it still builds a complete, promotable index,
 * and `episode` is simply empty. `SearchEngine.hasEpisodes` is what keeps that index
 * serving rather than throwing.
 *
 * **An episode with no season or episode number is DROPPED, not filed under zero.** This is
 * about a tenth of what the floor would otherwise keep -- the count is in the census on
 * `episodeSeriesMinVotes` -- and they are mostly talk shows and other unnumbered runs. The
 * one surface this table exists for is an ordered season list, so a row with no place in
 * that order has nowhere to go, and season 0 is already taken: it is the specials, which is
 * a different fact from "we do not know". They are counted into the log line rather than
 * swallowed, because a tenth of the input disappearing should be visible somewhere.
 *
 * **READS THE DISK AND NEVER THE NETWORK**, like every other stage here: the job downloads,
 * this builds.
 */
async function episodeStage(
  db: Database,
  cfg: Config,
  dumpDir: string,
  ratings: Map<string, { rating: number; votes: number }>,
  log: (msg: string) => void,
): Promise<number> {
  const path = `${dumpDir}/title.episode.tsv.gz`;
  if (!existsSync(path)) {
    log("episodes: title.episode not on disk, skipping -- the index is still valid, just without episodes");
    return 0;
  }

  const floor = cfg.index.episodeSeriesMinVotes;
  log(`reading title.episode (series floor ${floor.toLocaleString()} votes) ...`);
  const insert = db.prepare(
    "insert or ignore into episode (tconst, parent, season, number, rating, votes) values (?,?,?,?,?,?)",
  );
  let scanned = 0;
  let kept = 0;
  let unnumbered = 0;

  db.run("begin");
  for await (const cols of streamTsv(path, "title.episode")) {
    scanned++;
    const [tconst, parent] = cols;
    // The parent's votes come from the ratings map rather than from `title`, because that
    // table has not been FILLED yet -- see the ordering note at the call site. The two
    // agree by construction: `title.votes` is written from this same map, so a parent that
    // clears the floor here clears it there. What the map cannot answer is whether the
    // parent survives the titleType and adult filters, which is `pruneOrphanEpisodes`' job.
    const parentVotes = ratings.get(parent)?.votes ?? 0;
    if (parentVotes < floor) continue;

    const season = intOrNull(cols[2]);
    const number = intOrNull(cols[3]);
    if (season === null || number === null) {
      unnumbered++;
      continue;
    }

    // The episode's OWN rating, and `null` rather than 0 when it has none. See the table's
    // comment: 0.0 would be a well-formed score for a title nobody has scored.
    const own = ratings.get(tconst);
    insert.run(tconst, parent, season, number, own?.rating ?? null, own?.votes ?? 0);
    kept++;
  }
  db.run("commit");

  log(
    `  scanned ${scanned.toLocaleString()}, kept ${kept.toLocaleString()} episodes ` +
      `(${unnumbered.toLocaleString()} dropped for having no season or episode number)`,
  );
  return kept;
}

/**
 * Drop episodes whose parent series did not make it into `title`.
 *
 * The floor in `episodeStage` is applied against the ratings map, which knows a title's
 * votes and nothing about its TYPE or its adult flag -- so a series `titleTypes` or
 * `includeAdult` excluded would otherwise leave its whole run behind as rows nothing can
 * reach and nothing can explain.
 *
 * **It is not a theoretical guard, which is worth knowing before anybody optimises it
 * away.** A real build against the 2026-09-04 dumps deleted four rows here, and all four
 * were episodes of adult series that `includeAdult: false` had kept out of `title`. An
 * estimate made beforehand said zero, because it checked `titleTypes` and forgot the adult
 * filter -- exactly the kind of second condition a prune written against the finished table
 * catches for free and one written against the ratings map would not.
 */
function pruneOrphanEpisodes(db: Database, episodeRows: number, log: (msg: string) => void): number {
  if (episodeRows === 0) return 0;
  db.run("delete from episode where parent not in (select tconst from title)");
  const kept = (db.query("select count(*) c from episode").get() as { c: number }).c;
  if (kept < episodeRows) {
    log(`  ${(episodeRows - kept).toLocaleString()} episodes dropped -- their series is not in the index`);
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Cast and crew
// ---------------------------------------------------------------------------

/**
 * Rescan the principals dump, or carry the previous index's cast tables forward.
 *
 * The whole point of the split, and the reason it is a separate function from both: the
 * decision is a POLICY about cost, and it belongs in one place rather than smeared
 * through the builder as an `if`.
 *
 * Rescans when there is nothing to carry (first build, or the previous index predates the
 * cast tables), when the RECIPE that produced the carried tables no longer matches the
 * one configured now, or when the carried data is older than `castRefreshDays`. Otherwise
 * copies, which takes seconds against the minutes a scan costs on the NAS (BUILD COST,
 * module docstring).
 *
 * **Age alone was not enough, and the gap was quiet.** Carried tables are only equivalent
 * to a rescan while the filters that produced them still hold, so widening
 * `castCategories` used to be swallowed for up to `castRefreshDays`: the config said
 * composers were indexed, the index did not have them, and the change appeared to land on
 * its own days later when the window happened to expire. Cost is not a reason to serve
 * data the configuration disagrees with.
 */
async function castStage(
  db: Database,
  cfg: Config,
  dumpDir: string,
  log: (msg: string) => void,
): Promise<{ creditRows: number; people: number }> {
  const p = paths(cfg);
  const days = cfg.index.castRefreshDays;
  const previous = existsSync(p.db) && hasCastData(p.db) ? p.db : null;

  if (!previous) {
    if (days > 0) log("cast: no previous cast data to carry -- scanning");
    return buildCast(db, cfg, dumpDir, log);
  }
  if (days <= 0) return buildCast(db, cfg, dumpDir, log);

  const recipe = castRecipe(cfg);
  const carriedRecipe = castRecipeOf(p.db);
  if (carriedRecipe !== recipe) {
    log(
      `cast: filters changed since the carried tables were built (${carriedRecipe ?? "unstamped"}) -- rescanning`,
    );
    return buildCast(db, cfg, dumpDir, log);
  }

  const builtAt = castBuiltAt(p.db);
  const ageDays = builtAt === null ? Number.POSITIVE_INFINITY : (Date.now() - builtAt) / 86_400_000;
  if (ageDays >= days) {
    log(`cast: carried data is ${ageDays.toFixed(1)} days old (limit ${days}) -- rescanning`);
    return buildCast(db, cfg, dumpDir, log);
  }

  log(`cast: ${ageDays.toFixed(1)} days old, under the ${days}-day limit -- carrying forward`);
  const carried = carryCastForward(db, previous, log);
  // The stamp travels with the data, NOT with the build. Restamping on every carry would
  // make the age reset nightly and the rescan never happen -- the bug this whole split
  // exists to avoid, and one that would look like it was working.
  stampCast(db, cfg, builtAt === null ? new Date() : new Date(builtAt));
  return carried;
}

/**
 * Record WHEN the cast tables were scanned and WHAT produced them, together.
 *
 * One writer for both keys, because they are one fact about one set of tables: a stamp
 * that said only "when" is what let a changed recipe ride along looking current.
 */
function stampCast(db: Database, cfg: Config, builtAt: Date): void {
  const set = db.prepare("insert or replace into meta (key, value) values (?, ?)");
  set.run("cast_built_at", builtAt.toISOString());
  set.run("cast_recipe", castRecipe(cfg));
}

/**
 * The filters that decide which credits exist, in a canonical form two builds can compare.
 *
 * Categories are DEDUPED AND SORTED by `INDEX_STAGES.cast`, so listing them in a different
 * order is the same recipe. Getting that wrong is not a small bug: every build would see a
 * mismatch, rescan 101.5M rows, and quietly undo the carry-forward that makes a nightly
 * build affordable.
 *
 * **It delegates rather than deriving its own**, because the same string is now also the
 * cast entry in the index STAGE stamp (`./index-stages`). Two derivations of one recipe
 * would let a boot-time "cast is stale" disagree with the build's own carry-forward
 * decision -- the build would carry the tables forward and the next boot would order
 * another rebuild, forever.
 */
function castRecipe(cfg: Config): string {
  return INDEX_STAGES.cast(cfg);
}

/** The recipe an existing index was built with, or null if it predates the stamp. */
function castRecipeOf(path: string): string | null {
  const db = new Database(path, { readonly: true });
  try {
    const row = db.query("select value from meta where key = 'cast_recipe'").get() as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** When the carried cast data was last actually SCANNED, in epoch ms. */
function castBuiltAt(path: string): number | null {
  const db = new Database(path, { readonly: true });
  try {
    const row = db.query("select value from meta where key = 'cast_built_at'").get() as
      | { value: string }
      | undefined;
    if (!row) return null;
    const t = Date.parse(row.value);
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/**
 * Copy the cast tables out of the previous index instead of rebuilding them.
 *
 * **This is what makes a nightly build affordable.** The cast scan is about 60% of a
 * refresh build on the NAS, and reading the dump is almost all of that -- so an
 * incremental scan would save nothing, because it still reads the whole dump to discover
 * what changed (BUILD COST, module docstring). Cast for a released title cannot change,
 * so most nights there is nothing to discover.
 *
 * **`title_rowid` is REMAPPED through `tconst`, never carried verbatim.** Rowids are
 * assigned by insertion order while streaming `title.basics`, so one new title appearing
 * mid-file shifts every rowid after it. Copying the integers straight across would
 * silently reattribute credits to whatever title now sits at that rowid -- the kind of
 * corruption that looks like plausible data. Person rowids ARE carried verbatim, because
 * they are internal to these two tables and nothing else references them.
 *
 * A title that has since left the index drops its credits, which is correct: there is no
 * page for them to appear on.
 */
function carryCastForward(
  db: Database,
  fromPath: string,
  log: (msg: string) => void,
): { creditRows: number; people: number } {
  db.run("attach ? as prev", [fromPath]);
  try {
    db.run(
      "insert into person (rowid_, nconst, name, birth_year, death_year) " +
        "select rowid_, nconst, name, birth_year, death_year from prev.person",
    );
    db.run(
      "insert into title_principal (title_rowid, person_rowid, category, ordering, characters) " +
        "select t.rowid_, tp.person_rowid, tp.category, tp.ordering, tp.characters " +
        "from prev.title_principal tp " +
        "join prev.title ot on ot.rowid_ = tp.title_rowid " +
        "join title t on t.tconst = ot.tconst",
    );
  } finally {
    db.run("detach prev");
  }

  const creditRows = (db.query("select count(*) c from title_principal").get() as { c: number }).c;
  const people = (db.query("select count(*) c from person").get() as { c: number }).c;
  log(`cast: carried ${creditRows.toLocaleString()} credits / ${people.toLocaleString()} people forward`);
  return { creditRows, people };
}

/** Does this index have cast tables with anything in them? */
function hasCastData(path: string): boolean {
  if (!existsSync(path)) return false;
  const db = new Database(path, { readonly: true });
  try {
    const t = db.query("select 1 from sqlite_master where type='table' and name='title_principal'").get();
    if (!t) return false;
    return (db.query("select count(*) c from title_principal").get() as { c: number }).c > 0;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

/**
 * Build `person` and `title_principal` from the two people dumps.
 *
 * **This stage is floored, and the floor is not a preference.** `title.principals` is
 * eighty times the whole title index; restricted to titles clearing `castMinVotes` and to
 * the categories in `castCategories` it merely doubles it. Unfiltered it is not a bigger
 * table, it is a different product with a different build time. The counts behind that
 * live on `castMinVotes` in `./config.ts`, which owns them.
 *
 * Two passes, in this order, because the second depends on the first: principals decides
 * WHICH people matter, and only then is `name.basics` worth reading -- it carries 15.6M
 * people and we need a third of a million of them.
 *
 * MISSING DUMPS ARE NOT AN ERROR. A checkout that has never fetched them still builds a
 * complete, promotable title index; it just has no person pages. The cast tables are
 * additive, so an existing deployment keeps working through the upgrade that adds them.
 */
async function buildCast(
  db: Database,
  cfg: Config,
  dumpDir: string,
  log: (msg: string) => void,
): Promise<{ creditRows: number; people: number }> {
  const categories = new Set(cfg.index.castCategories);
  if (categories.size === 0) {
    log("cast: no categories configured, skipping");
    return { creditRows: 0, people: 0 };
  }

  const principalsPath = `${dumpDir}/title.principals.tsv.gz`;
  const namesPath = `${dumpDir}/name.basics.tsv.gz`;
  if (!existsSync(principalsPath) || !existsSync(namesPath)) {
    log("cast: dumps not present, skipping -- the index is still valid, just without people");
    return { creditRows: 0, people: 0 };
  }

  // Which titles earn credits, and what rowid to attach them to. Built from the table
  // we just wrote rather than from the ratings map, so a title excluded by type or by
  // the adult filter cannot sneak credits in through the side door.
  const eligible = new Map<string, number>();
  for (const row of db
    .query("select tconst, rowid_ from title where votes >= ?")
    .all(cfg.index.castMinVotes) as { tconst: string; rowid_: number }[]) {
    eligible.set(row.tconst, row.rowid_);
  }
  log(
    `cast: ${eligible.size.toLocaleString()} titles clear ${cfg.index.castMinVotes.toLocaleString()} votes`,
  );

  // --- pass 1: principals. The expensive one -- 101.5M rows streamed to keep ~1.4M.
  log("reading title.principals ...");
  const insertCredit = db.prepare(
    "insert into title_principal (title_rowid, person_rowid, category, ordering, characters) values (?,?,?,?,?)",
  );
  // nconst -> the rowid we will give that person. Assigned here, during the streaming
  // pass, so principals never needs a second read once names are known.
  const personRowid = new Map<string, number>();
  let creditRows = 0;
  let scannedPrincipals = 0;

  db.run("begin");
  for await (const cols of streamTsv(principalsPath, "title.principals")) {
    scannedPrincipals++;
    const titleRowid = eligible.get(cols[0]);
    if (titleRowid === undefined) continue;
    if (!categories.has(cols[3])) continue;

    const nconst = cols[2];
    let pid = personRowid.get(nconst);
    if (pid === undefined) {
      pid = personRowid.size + 1;
      personRowid.set(nconst, pid);
    }

    insertCredit.run(titleRowid, pid, cols[3], intOrNull(cols[1]) ?? 0, charactersOf(cols[5]));
    creditRows++;
    if (creditRows % 250_000 === 0) log(`  ${creditRows.toLocaleString()} credits ...`);
  }
  db.run("commit");
  log(
    `  scanned ${scannedPrincipals.toLocaleString()}, kept ${creditRows.toLocaleString()} credits over ${personRowid.size.toLocaleString()} people`,
  );

  // --- pass 2: names, for those people only.
  log("reading name.basics ...");
  const insertPerson = db.prepare(
    "insert into person (rowid_, nconst, name, birth_year, death_year) values (?,?,?,?,?)",
  );
  let named = 0;
  db.run("begin");
  for await (const cols of streamTsv(namesPath, "name.basics")) {
    const pid = personRowid.get(cols[0]);
    if (pid === undefined) continue;
    if (!cols[1]) continue;
    insertPerson.run(pid, cols[0], cols[1], intOrNull(cols[2]), intOrNull(cols[3]));
    named++;
  }
  db.run("commit");

  // A credit pointing at a person `name.basics` never described would render a link to
  // a page with no name on it. Rare, but it happens when the two dumps are published a
  // few minutes apart, so it is reported rather than assumed away.
  if (named < personRowid.size) {
    log(
      `  ${(personRowid.size - named).toLocaleString()} people had no name row -- credits kept, names blank`,
    );
  }
  log(`  ${named.toLocaleString()} people named`);

  // Stamped only on a real SCAN. `castStage` carries the previous stamp forward on a
  // copy, so the age this drives is "how long since we last read the dump" rather than
  // "how long since the last build" -- otherwise the clock resets nightly and the
  // rescan never fires.
  stampCast(db, cfg, new Date());

  return { creditRows, people: named };
}

/**
 * IMDb wraps the character list in a JSON array -- `["Dom Cobb"]`.
 *
 * Unwrapped once here rather than on every render. A malformed value is dropped rather
 * than stored raw: a literal `["Dom Cobb"]` on screen is worse than no character name,
 * and this runs 1.4M times so it must not throw.
 */
function charactersOf(raw: string | undefined): string | null {
  if (!raw || raw === "\\N") return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const joined = parsed.filter((c): c is string => typeof c === "string").join(", ");
    return joined || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Populate the spellfix1 vocabulary that serves the fuzzy search tier.
 *
 * Scoped to `votes >= fuzzyMinVotes` for the same reason the old in-memory pool was:
 * below that floor the corpus is mostly untitled shorts and duplicates, and including
 * them costs recall rather than adding it. The floor is what keeps Solstollarna (122
 * votes) reachable while 1.07M near-empty rows stay out.
 *
 * Both title forms are indexed. Indexing only `ntitle` made every foreign-language
 * title unreachable by fuzzy search -- Jägarna is stored with title="The Hunters" --
 * which is the same trap the pool documented.
 *
 * `rank` is fed the vote count: spellfix1 uses it to break ties between equally-close
 * matches, so the popular title wins, which is what the ranking layer wants anyway.
 */
export function buildVocabulary(db: Database, cfg: Config, log: (m: string) => void): void {
  const t0 = Date.now();
  const loaded = loadSpellfix(db, log);
  if (!loaded.ok) {
    log("vocabulary: SKIPPED -- spellfix1 unavailable. The index is valid; fuzzy search will be off.");
    return;
  }

  db.run(`create virtual table ${SPELLFIX_TABLE} using spellfix1`);
  db.run(`create table ${SPELLFIX_MAP_TABLE} (id integer primary key, rowid_ integer not null)`);

  const rows = db
    .query("select rowid_ as rowid, ntitle, norig, votes from title where votes >= ?")
    .all(cfg.index.fuzzyMinVotes) as {
    rowid: number;
    ntitle: string;
    norig: string;
    votes: number;
  }[];

  const insV = db.prepare(`insert into ${SPELLFIX_TABLE}(rowid, word, rank) values (?, ?, ?)`);
  const insM = db.prepare(`insert into ${SPELLFIX_MAP_TABLE} (id, rowid_) values (?, ?)`);
  db.run("begin");
  let id = 0;
  for (const r of rows) {
    for (const w of [...new Set([r.ntitle, r.norig].filter((x) => x && x.length > 0))]) {
      id++;
      insV.run(id, w, r.votes);
      insM.run(id, r.rowid);
    }
  }
  db.run("commit");
  db.run(`create index ix_vocab_map on ${SPELLFIX_MAP_TABLE}(rowid_)`);

  // Record the floor the vocabulary was actually built at. The running server compares
  // it against its own config: changing FINDERR_INDEX_FUZZY_MIN_VOTES without rebuilding
  // otherwise leaves fuzzy coverage silently different from what config claims, and the
  // symptom is one obscure title quietly becoming unfindable.
  db.query("insert or replace into meta (key, value) values (?, ?)").run(
    "vocab_min_votes",
    String(cfg.index.fuzzyMinVotes),
  );

  log(
    `vocabulary: ${id.toLocaleString()} words from ${rows.length.toLocaleString()} titles ` +
      `(votes >= ${cfg.index.fuzzyMinVotes}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
}

// ---------------------------------------------------------------------------
// Promotion gates
// ---------------------------------------------------------------------------

export interface GateResult {
  ok: boolean;
  name: string;
  detail: string;
}

/** Row count must not collapse -- catches a truncated or half-parsed dump. */
export function gateVolume(candidate: string, live: string, minRatio = 0.95): GateResult {
  if (!existsSync(live))
    return {
      ok: true,
      name: "volume",
      detail: "no live index yet, nothing to compare",
    };
  const count = (p: string) => {
    const db = new Database(p, { readonly: true });
    try {
      return (db.query("select count(*) c from title").get() as { c: number }).c;
    } finally {
      db.close();
    }
  };
  const a = count(candidate);
  const b = count(live);
  const ratio = b === 0 ? 1 : a / b;
  return {
    ok: ratio >= minRatio,
    name: "volume",
    detail: `${a.toLocaleString()} rows vs live ${b.toLocaleString()} (${(ratio * 100).toFixed(1)}%, floor ${(minRatio * 100).toFixed(0)}%)`,
  };
}

/**
 * Atomically promote a verified candidate.
 *
 * A rename on one filesystem is atomic, so readers either see the whole old index or
 * the whole new one -- never a half-written file.
 */
export function promote(cfg: Config): void {
  const p = paths(cfg);
  if (!existsSync(p.dbNew)) throw new Error(`nothing to promote: ${p.dbNew} does not exist`);
  if (existsSync(p.db)) {
    if (existsSync(p.dbPrev)) unlinkSync(p.dbPrev);
    renameSync(p.db, p.dbPrev);
  }
  renameSync(p.dbNew, p.db);
}

/** Undo the last promotion. */
export function rollback(cfg: Config): void {
  const p = paths(cfg);
  if (!existsSync(p.dbPrev)) throw new Error("no previous index to roll back to");
  if (existsSync(p.db)) unlinkSync(p.db);
  renameSync(p.dbPrev, p.db);
}
