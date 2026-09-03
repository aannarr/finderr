/**
 * Builds the searchable title index from the IMDb dumps.
 *
 * Design decision: REBUILD, never patch. A full rebuild is ~10s of CPU against 1.27M
 * rows. Incremental diffing would be more code, more failure modes, and no faster.
 *
 * The build always targets `titles.new.db` and is only promoted to the live path
 * after every gate passes, so a bad build is a no-op rather than an outage.
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
  death_year integer
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
${CROSSWALK_SCHEMA}${PERSON_CROSSWALK_SCHEMA}`;

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
 * explode 2.1s, indexes 3.3s -- so the whole layer is under 7s on a build that already
 * costs 102.7s here and 376.3s on the NAS. It rides the existing 09:00 refresh and
 * schedules nothing new.
 */
export function buildRankLayer(db: Database, cfg: Config, log: (msg: string) => void = () => {}): RankPrior {
  const t0 = Date.now();
  const prior = applyRank(db, cfg.index.rankPriorVotes);
  db.run("begin");
  db.run(EXPLODE_GENRES);
  db.run("commit");
  // (kind, rank desc) and (genre, kind, rank desc): the leading equality columns are what
  // a list actually pins, and `rank desc` last is what removes the sort. A decade slice
  // adds a range on `year` that no prefix can cover, so it walks this order and filters --
  // 3.1ms measured for "top comedies of the 2020s" against 180ms for the live expression.
  db.run("create index ix_rank on title(kind, rank desc)");
  db.run("create index ix_tg_rank on title_genre(genre, kind, rank desc)");
  // The VOTES twin of ix_tg_rank, and the column order is not the same shape by accident.
  // `kind` sits LAST here, after the sort column, because a genre browse most often pins
  // no kind at all -- with `kind` in the middle the ordering would be split across two
  // groups and SQLite would fall back to a temp b-tree for the one query this exists to
  // remove. Last, it is still covered, so `?genre=Comedy&kind=movie` filters from the
  // index rather than from `title`. Both queries are answered without touching the title
  // table at all, which is what takes the count from 1151ms to a seek.
  db.run("create index ix_tg_votes on title_genre(genre, votes desc, kind)");
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

  const db = new Database(dest, { create: true });
  // These are safe here: we are building a throwaway file. If the process dies the
  // partial DB is discarded, never promoted.
  db.run("pragma journal_mode = off");
  db.run("pragma synchronous = off");
  db.run("pragma temp_store = memory");
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

  // --- the rank column, then genres exploded into a join table carrying a copy of it.
  // One step, in that order, because the copy cannot precede the value. Facet counts are
  // an indexed group-by over the same table.
  log("ranking and exploding genres ...");
  const prior = buildRankLayer(db, cfg, log);
  const genreRows = (db.query("select count(*) c from title_genre").get() as { c: number }).c;
  log(`  ${genreRows.toLocaleString()} genre rows`);

  // --- FTS over the normalized columns.
  // `content=` makes this an external-content table: the text is not duplicated,
  // FTS just indexes what `title` already holds.
  log("building FTS index ...");
  db.run(
    "create virtual table tfts using fts5(ntitle, norig, dtitle, content='title', content_rowid='rowid_', " +
      "tokenize='unicode61 remove_diacritics 2')",
  );
  db.run("insert into tfts(rowid, ntitle, norig, dtitle) select rowid_, ntitle, norig, dtitle from title");

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
  const idRows = crosswalkStage(db, dumpDir, log);
  // AFTER the cast stage, not beside it: this one keeps only people `person` already holds,
  // so running it first would restrict against an empty table and keep nothing.
  const personIdRows = personCrosswalkStage(db, dumpDir, log);

  log("building secondary indexes ...");
  db.run("create index ix_votes on title(votes desc)");
  db.run("create index ix_year on title(year)");
  // (kind, votes desc), not (kind). The narrower index is a leading-column PREFIX of this
  // one and so serves nothing this does not -- the same argument that removed
  // ix_tg_genre below. What the extra column buys: `?kind=movie` was 466ms to count and
  // 354ms to page on the live NAS index, because SQLite picked ix_kind, walked every
  // movie row to test `votes`, and then sorted. Both halves are now covered seeks.
  db.run("create index ix_kind on title(kind, votes desc)");
  // The stopword-only query's whole cost, removed. PARTIAL so it holds ~24k rows of 1.27M
  // (672 KB, 2.1s to build) and COVERING so `title like 'the %'` is answered from index
  // pages without fetching a single row -- that fetch was a 51.8ms median and a 1461ms worst
  // case. See `search-stopwords.ts`, which owns the DDL so its floor cannot drift from the
  // floor the query asks for.
  db.run(POPULAR_TITLE_INDEX);
  db.run("create index ix_tg_title on title_genre(title_rowid)");
  // ix_tg_genre(genre) is gone: ix_tg_rank leads with `genre`, so it serves every query
  // the narrower index served -- a leading-column prefix is the one case where two
  // indexes are genuinely one. Keeping both would cost build time and pages for nothing.
  // ix_tp_person is the REVERSE index and the entire reason the cast tables exist:
  // person -> filmography. ix_tp_title serves the other direction, which the title
  // page needs to turn a cast name into a link.
  db.run("create index ix_tp_person on title_principal(person_rowid)");
  db.run("create index ix_tp_title on title_principal(title_rowid)");
  db.run("create index ix_person_name on person(name)");

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
  setMeta.run("id_rows", String(idRows));
  setMeta.run("person_id_rows", String(personIdRows));
  // How the lists were ranked, so a list page can say it rather than restate a constant
  // that has since moved. `rank_prior_mean` is the measured corpus mean, not a setting.
  setMeta.run("rank_prior_votes", String(prior.c));
  setMeta.run("rank_prior_mean", prior.mean.toFixed(4));
  setMeta.run("ranked", String(prior.ranked));
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
// Cast and crew
// ---------------------------------------------------------------------------

/**
 * Build `person` and `title_principal` from the two people dumps.
 *
 * **This stage is floored, and the floor is not a preference.** `title.principals` is
 * 101,528,386 rows against a title index of 1,275,341 -- eighty times the whole product.
 * Restricted to titles clearing `castMinVotes` and to the categories in
 * `castCategories`, it lands at 1,414,391 rows over 297,233 people (measured 2026-08-31),
 * which merely doubles the index. Unfiltered it is not a bigger table, it is a different
 * product with a different build time.
 *
 * Two passes, in this order, because the second depends on the first: principals decides
 * WHICH people matter, and only then is `name.basics` worth reading -- it carries 15.6M
 * people and we need 297k of them.
 *
 * MISSING DUMPS ARE NOT AN ERROR. A checkout that has never fetched them still builds a
 * complete, promotable title index; it just has no person pages. The cast tables are
 * additive, so an existing deployment keeps working through the upgrade that adds them.
 */
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
 * copies, which takes seconds against the 192s a scan costs on the NAS.
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
 * **This is what makes a nightly build affordable.** Measured on the Synology (Celeron
 * J4125), scanning `title.principals` costs 192s -- and ~93% of that is streaming and
 * parsing 101.5M lines to keep 0.7% of them, NOT the inserts. So an incremental build
 * saves nothing: it still has to read the whole dump to discover what changed. Not
 * reading the dump is the only thing that helps, and cast for a released title cannot
 * change, so most nights there is nothing to discover.
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
