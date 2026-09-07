/**
 * Language origin: the data, the filter, and the honesty rule that goes with it.
 *
 * The cases here are not guesses about what might break -- each one is a finding from
 * `.claude/docs/2026-09-05-rank-experiments.md`, which measured this problem before any of
 * it was built. Two in particular:
 *
 *   - **An index built before the origin stage must not have the filter applied to it.**
 *     `title_lang` would be empty and the semi-join would match nothing, so a configured
 *     preference would empty every list in the product for the window before the next
 *     nightly rebuild. That is the one way this feature can fail catastrophically.
 *   - **A title whose language nobody knows is ADMITTED.** Coverage is 84% at the browse
 *     floor, so a filter that excluded them would silently delete thousands of titles for
 *     a gap that is OURS.
 *
 * Policy, never a census of `data/titles.db` -- the same rule `browse.test.ts` states.
 */

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";
import { loadOrigin, ORIGIN_SCHEMA, parseOriginCsv, UNKNOWN_LANG } from "./crosswalk";
import { applyRank, EXPLODE_GENRES, INDEXES, SCHEMA } from "./index-builder";
import { browseIndex, browseVoteFloor, languageFilter, SearchEngine } from "./search";

const dir = mkdtempSync(join(tmpdir(), "finderr-origin-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Row {
  tconst: string;
  year: number;
  kind: string;
  votes: number;
  genres: string;
  rating?: number;
  /** P364 codes. An EMPTY array means Wikidata has no language for it. */
  langs?: string[];
  countries?: string[];
}

/** How faithful a `title_lang` the fixture should carry. */
interface FixtureShape {
  /** `false` builds a file from before the origin stage: no `title_lang` at all. */
  withOrigin?: boolean;
  /** `false` builds a file from before the 2026-09-06 WIDENING: the original two columns. */
  withLangRank?: boolean;
  /**
   * `false` builds a file from before the 2026-09-07 widening: `kind`, `rank` and
   * `non_english` present, `year` and `votes` absent, and no `ix_lang_votes`.
   *
   * The state between the two widenings, and it is the one a running deployment is actually
   * in for up to a day after this ships -- which is why it is a shape rather than a mock.
   */
  withLangYear?: boolean;
}

/**
 * `title_lang` as an OLDER build wrote it, rebuilt from the current one rather than ALTERed.
 *
 * An `alter table drop column` would leave the file carrying today's indexes minus a column,
 * which is a shape no release ever produced -- and a capability probe exercised against a
 * file that could not exist proves nothing about the file that can. Both the columns and the
 * index DDL are spelled out by the caller, because both of them are what the old build wrote.
 *
 * `INDEXES.origin` is deliberately NOT read here: it is today's list, and the whole point of
 * these fixtures is to be yesterday's.
 */
function narrowLangTable(db: Database, columns: readonly string[], indexes: readonly string[]): void {
  const names = columns.map((c) => c.split(/\s+/)[0]).join(", ");
  db.run(`create table lang_old (${columns.join(", ")})`);
  db.run(`insert into lang_old select ${names} from title_lang`);
  db.run("drop table title_lang");
  db.run("alter table lang_old rename to title_lang");
  for (const sql of indexes) db.run(sql);
}

/** The two columns and two indexes `title_lang` shipped with until 2026-09-06. */
const LANG_BEFORE_RANK = {
  columns: ["title_rowid integer not null", "lang text not null"],
  indexes: [
    "create index ix_lang on title_lang(title_rowid, lang)",
    "create index ix_lang_code on title_lang(lang, title_rowid)",
  ],
} as const;

/** What it carried between the two widenings: the list columns, no `year` and no `votes`. */
const LANG_BEFORE_YEAR = {
  columns: [
    "title_rowid integer not null",
    "lang text not null",
    "kind text not null default ''",
    "rank real",
    "non_english integer not null default 1",
  ],
  indexes: [
    "create index ix_lang on title_lang(title_rowid, lang)",
    "create index ix_lang_code on title_lang(lang, title_rowid)",
    "create index ix_lang_rank on title_lang(lang, kind, rank desc, non_english)",
  ],
} as const;

/** A throwaway index carrying the real schema, the origin stage, and its indexes. */
function indexOf(rows: Row[], opts: FixtureShape = {}): Database {
  const db = new Database(join(dir, `${crypto.randomUUID()}.db`), { create: true });
  db.run(SCHEMA);
  const insert = db.query(
    "insert into title (tconst, kind, title, year, votes, rating, genres) values (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const r of rows) insert.run(r.tconst, r.kind, r.tconst, r.year, r.votes, r.rating ?? 7, r.genres);
  applyRank(db, 10);
  db.run(EXPLODE_GENRES);
  if (opts.withOrigin === false) {
    // A file built BEFORE this stage existed. `ORIGIN_SCHEMA` is part of `SCHEMA`, so a
    // fresh build always has the table -- the only faithful way to produce the older shape
    // is to take it away again, which is exactly what such a file looks like on disk.
    db.run("drop table title_lang");
    return db;
  }
  loadOrigin(
    db,
    rows.flatMap((r) => (r.langs ?? []).map((code) => ({ imdb: r.tconst, code }))),
    rows.flatMap((r) => (r.countries ?? []).map((code) => ({ imdb: r.tconst, code }))),
  );
  const older =
    opts.withLangRank === false ? LANG_BEFORE_RANK : opts.withLangYear === false ? LANG_BEFORE_YEAR : null;
  if (older) narrowLangTable(db, older.columns, older.indexes);
  else for (const sql of INDEXES.origin) db.run(sql);
  return db;
}

/*
  Ratings DIFFER on purpose. With one rating across the fixture every `rank` collapses to
  the corpus mean and every ordering assertion becomes a coin toss -- which is how the
  first draft of this file "passed" a sort it was not testing.
*/
const CORPUS: Row[] = [
  {
    tconst: "tt-en1",
    year: 2015,
    kind: "movie",
    votes: 900_000,
    rating: 8.4,
    genres: "Crime",
    langs: ["en"],
  },
  {
    tconst: "tt-en2",
    year: 2018,
    kind: "movie",
    votes: 400_000,
    rating: 8.1,
    genres: "Crime",
    langs: ["en"],
  },
  { tconst: "tt-sv", year: 2016, kind: "movie", votes: 30_000, rating: 7.2, genres: "Crime", langs: ["sv"] },
  { tconst: "tt-ta", year: 2021, kind: "movie", votes: 200_000, rating: 8.6, genres: "Crime", langs: ["ta"] },
  { tconst: "tt-hi", year: 2022, kind: "movie", votes: 150_000, rating: 8.2, genres: "Crime", langs: ["hi"] },
  // The multi-language case. `Sardar Udham` is hi/en/pa upstream and rides in on its `en`.
  {
    tconst: "tt-multi",
    year: 2021,
    kind: "movie",
    votes: 50_000,
    rating: 8.3,
    genres: "Crime",
    langs: ["hi", "en", "pa"],
  },
  // The 16%: in the index, nobody knows what language it is.
  { tconst: "tt-unknown", year: 2019, kind: "movie", votes: 80_000, rating: 7.6, genres: "Crime" },
];

const EN_SV = languageFilter(["en", "sv"]);
const titles = (db: Database, opts: Parameters<typeof browseIndex>[1]) =>
  browseIndex(db, opts).rows.map((r) => r.tconst);

/**
 * The same fixture, reopened through `SearchEngine`.
 *
 * `hasOrigin` is a property of the OPEN FILE rather than of a query, so the two guards it
 * drives cannot be exercised against a `Database` handed straight to `browseIndex` -- that
 * function deliberately knows nothing about which file it was given.
 */
function engineOn(rows: Row[], opts: FixtureShape = {}): SearchEngine {
  const db = indexOf(rows, opts);
  const path = db.filename;
  db.close();
  return new SearchEngine(path, loadConfig());
}

describe("the origin data", () => {
  test("parseOriginCsv keeps two-letter codes and drops everything else", () => {
    const rows = parseOriginCsv(
      ["imdb,code", "tt1,en", "tt2,SV", "tt3,eng", "nm1,en", "tt4,", "tt5,en,extra", "tt6,x"].join("\n"),
    );
    // Lower-cased on the way in, so a config spelling and a stored code cannot disagree.
    expect(rows).toEqual([
      { imdb: "tt1", code: "en" },
      { imdb: "tt2", code: "sv" },
    ]);
  });

  test("EVERY title gets a language row, and an unknown one gets UNKNOWN_LANG", () => {
    const db = indexOf(CORPUS);
    const n = db.query("select count(distinct title_rowid) c from title_lang").get() as { c: number };
    expect(n.c).toBe(CORPUS.length);
    const unknown = db
      .query("select t.tconst from title t join title_lang l on l.title_rowid = t.rowid_ where l.lang = ?")
      .all(UNKNOWN_LANG) as { tconst: string }[];
    expect(unknown.map((r) => r.tconst)).toEqual(["tt-unknown"]);
  });

  test("a multi-language title keeps every one of its languages", () => {
    const db = indexOf(CORPUS);
    const rows = db
      .query(
        `select l.lang from title_lang l join title t on t.rowid_ = l.title_rowid
         where t.tconst = 'tt-multi' order by l.lang`,
      )
      .all() as { lang: string }[];
    expect(rows.map((r) => r.lang)).toEqual(["en", "hi", "pa"]);
  });

  test("country is comma-joined, sorted and upper-cased; absent stays null", () => {
    const db = indexOf([
      { ...CORPUS[0]!, countries: ["us", "gb"] },
      { tconst: "tt-none", year: 2000, kind: "movie", votes: 10, genres: "Drama" },
    ]);
    const rows = db.query("select tconst, country from title order by tconst").all() as {
      tconst: string;
      country: string | null;
    }[];
    expect(rows).toEqual([
      { tconst: "tt-en1", country: "GB,US" },
      { tconst: "tt-none", country: null },
    ]);
  });

  test("a build with NO origin files still gives every title a row", () => {
    // The sourceless deployment. Without the backfill this table would be empty and a
    // configured preference would then hide the entire index.
    const db = indexOf(CORPUS.map((r) => ({ ...r, langs: [], countries: [] })));
    const n = db.query("select count(*) c from title_lang").get() as { c: number };
    expect(n.c).toBe(CORPUS.length);
    expect(titles(db, { genre: "Crime", languages: EN_SV }).length).toBe(CORPUS.length);
  });
});

describe("the stage is LINEAR in its inputs, not quadratic", () => {
  /*
    The regression test for the only bug this stage has had, and it is a SCALE test rather
    than a duration one -- the assertion is that doubling the corpus does not square the
    work, and the threshold is set two orders of magnitude away from the passing time so a
    slow machine cannot fail it.

    What it catches: the first draft of `loadOrigin` correlated two subqueries against
    UNKEYED temp tables. At production scale that is ~600 billion row comparisons and the
    real build sat at 98.8% CPU for seventeen minutes before it was killed. At the size
    below it is a few seconds; with the seeks it is milliseconds. A unit test on a
    seven-row fixture cannot see any of it, which is exactly why this one is here.
  */
  const N = 40_000;

  test(`${N.toLocaleString()} titles and as many country rows load in well under a second`, () => {
    const db = new Database(join(dir, `${crypto.randomUUID()}.db`), { create: true });
    db.run(SCHEMA);
    const insert = db.query(
      "insert into title (tconst, kind, title, year, votes, rating, genres) values (?, ?, ?, ?, ?, ?, ?)",
    );
    db.transaction(() => {
      for (let i = 0; i < N; i++) insert.run(`tt${i}`, "movie", `t${i}`, 2000, 100, 7, "Drama");
    })();

    // Half the corpus has a language, all of it has a country, and a tenth has two of each
    // -- the multi-value path is where the aggregate does its work.
    const langs: { imdb: string; code: string }[] = [];
    const countries: { imdb: string; code: string }[] = [];
    for (let i = 0; i < N; i++) {
      if (i % 2 === 0) langs.push({ imdb: `tt${i}`, code: i % 3 === 0 ? "en" : "ta" });
      countries.push({ imdb: `tt${i}`, code: "us" });
      if (i % 10 === 0) {
        langs.push({ imdb: `tt${i}`, code: "sv" });
        countries.push({ imdb: `tt${i}`, code: "gb" });
      }
    }

    const t0 = performance.now();
    const res = loadOrigin(db, langs, countries);
    const ms = performance.now() - t0;

    /*
      Correctness first -- a fast wrong answer is not the thing being tested.

      Counted with `count(distinct)` rather than the `not exists` the small fixtures use.
      At this size that correlated form is itself the quadratic shape this test exists to
      catch (40,000 x 44,000 measured at 28 seconds), so the obvious assertion would have
      made the test fail against correct code. Worth knowing before adding another one.
    */
    expect(res.langRows).toBeGreaterThan(N);
    expect((db.query("select count(distinct title_rowid) c from title_lang").get() as { c: number }).c).toBe(
      N,
    );
    expect(
      (db.query("select country from title where tconst = 'tt0'").get() as { country: string }).country,
    ).toBe("GB,US");

    // The gate. Measured at ~0.2s with the seeks in place on an M1 Max; the quadratic form
    // does not finish inside this at a quarter of this size.
    expect(ms).toBeLessThan(10_000);
  });
});

describe("the filter SEEKS its index", () => {
  /*
    The second bug this stage had, and the reason the index shape is not obvious.

    "Which titles are in one of these languages" sounds like it wants `ix_lang(lang,
    title_rowid)`, and that is what shipped first. Measured on the real 1.28M-row index it
    was **1,014 ms against 0.08 ms unfiltered**, because the fail-open backfill puts
    `UNKNOWN_LANG` on 81% of the corpus and `in (select ...)` materialises every one of
    those rowids on every browse.

    A duration cannot be asserted on a seven-row fixture, so this asserts the PLAN instead:
    the predicate must be a correlated seek into the index, never a list subquery and never
    a scan. `browseSql` and `INDEXES.origin` have to change together, and this is what says
    so when one of them moves.
  */

  /*
    DO NOT PIN THE WORD "CORRELATED" HERE AGAIN. It is SQLite's wording for the plan node,
    not a property of our query, and SQLite changed it underneath us.

    Both assertions below used to read `expect(plan).toContain("CORRELATED")`. That passed on
    macOS and FAILED IN CI, which is the worst shape a test can have -- green on the machine
    that writes the code, red on the machine that gates it, and the red line names a SQL
    keyword rather than the thing that broke. Measured on 2026-09-06 with the same fixture
    and the same query, bun 1.4.0 on both sides:

      macOS, SQLite 3.51.0   SEARCH g USING INDEX ix_genre (genre=?)
                             CORRELATED SCALAR SUBQUERY 1
                             SEARCH l USING COVERING INDEX ix_lang_rank (lang=? AND title_rowid=?)
                             SEARCH t USING INTEGER PRIMARY KEY (rowid=?)

      Linux,  SQLite 3.53.2  SEARCH g USING INDEX ix_genre (genre=?)
                             SEARCH t USING INTEGER PRIMARY KEY (rowid=?)
                             SEARCH l EXISTS USING COVERING INDEX ix_lang (title_rowid=? AND lang=?)

    3.53 folded the `exists` into the outer loop and emits `SEARCH ... EXISTS` where 3.51
    emitted a separate `CORRELATED SCALAR SUBQUERY` node. **The invariant is intact in both**
    -- arguably stated more plainly by the newer form -- so the TEST was the bug, not the
    query and not the index.

    What actually has to hold is: `l` is reached by an indexed SEEK keyed on the outer row's
    rowid, never scanned and never materialised into a list. That is what `seeksTitleLang`
    asserts, and it is true on both versions. A future SQLite may reword this again; it may
    not turn the seek into a scan without this failing.
  */
  const planOf = (db: Database, sql: string, args: unknown[]) =>
    (db.query(`explain query plan ${sql}`).all(...(args as never[])) as { detail: string }[])
      .map((r) => r.detail)
      .join(" | ");

  /** The language table is SEEKED through one of its own indexes, whatever SQLite calls the node. */
  const seeksTitleLang = (plan: string) => /SEARCH l\b[^|]*USING COVERING INDEX ix_lang/.test(plan);

  test("a genre browse seeks ix_lang and materialises no list", () => {
    const db = indexOf(CORPUS);
    db.run("analyze");
    const sql = `select t.tconst from title t join title_genre g on g.title_rowid = t.rowid_
       where g.genre = ? and exists (select 1 from title_lang l where l.title_rowid = g.title_rowid
         and l.lang in (?, ?, ?)) order by g.rank desc limit 40`;
    const plan = planOf(db, sql, ["Crime", ...EN_SV]);
    expect(seeksTitleLang(plan)).toBe(true);
    // The shape that was 1,014 ms. A LIST SUBQUERY here means the `in (select ...)` form
    // has come back, whatever the index says.
    expect(plan).not.toContain("LIST SUBQUERY");
    expect(plan).not.toContain("SCAN l");
  });

  test("the index leads with title_rowid, which is what makes the seek possible", () => {
    // Pinned as DDL rather than by reading a plan, because the plan test above would still
    // pass on a scan of a small fixture. Together they say seek AND why.
    expect(INDEXES.origin.join("")).toContain("title_lang(title_rowid, lang)");
  });

  test("a SECOND index leads with lang, which is what a language LIST needs", () => {
    /*
      Not the withdrawn shape coming back -- it is an ADDITION, and both exist because the
      two queries drive from opposite ends. A preference is a list of codes covering 81% of
      the corpus, so leading with `lang` materialises a million rowids; a language list is
      ONE code matching a fraction of a percent, and its `not exists` half has to prove a
      negative per candidate row, which `(title_rowid, lang)` cannot do selectively.

      Measured on a copy of the real 1,288,159-row index on 2026-09-06, with the index the
      only thing that changed: the twelve shipped lists go from 125.8 ms to 77.4 ms, and the
      preference query kept its correlated-seek plan at 1.9 ms rather than regressing to the
      1,014 ms of the shape that was withdrawn.
    */
    expect(INDEXES.origin.join("")).toContain("title_lang(lang, title_rowid)");
  });

  test("a language LIST seeks an index too, and materialises no list subquery", () => {
    const db = indexOf(CORPUS);
    db.run("analyze");
    const sql = `select t.tconst from title t
       where t.kind = ? and exists (select 1 from title_lang l where l.title_rowid = t.rowid_ and l.lang in (?))
         and not exists (select 1 from title_lang l where l.title_rowid = t.rowid_ and l.lang in (?))
       order by t.rank desc limit 250`;
    const plan = planOf(db, sql, ["movie", "hi", "en"]);
    expect(seeksTitleLang(plan)).toBe(true);
    // The `not exists` half is the one that could quietly become a scan of the whole
    // language table once per candidate row, which is 1.3M rows on the real index.
    expect(plan).not.toContain("LIST SUBQUERY");
    expect(plan).not.toContain("SCAN l");
  });
});

describe("the denormalised list columns", () => {
  /*
    `kind`, `rank` and `non_english` are one value each, copied from the title at build time
    -- the same trade `title_genre` makes with `kind`, `rank` and `votes`. What these tests
    defend is that they are copies of the RIGHT thing: a `rank` written before `applyRank`
    would be a table of NULLs and every language list would be empty, which is the shape the
    genre explosion's own docstring warns about.
  */
  test("kind and rank are the title's own, on every row", () => {
    const db = indexOf(CORPUS);
    const wrong = db
      .query(
        `select count(*) c from title_lang l join title t on t.rowid_ = l.title_rowid
          where l.kind != t.kind or l.rank is not t.rank`,
      )
      .get() as { c: number };
    expect(wrong.c).toBe(0);
    // And not vacuously: the fixture has ranks, so a stage that ran before `applyRank` would
    // agree with a table of NULLs and pass the assertion above.
    const ranked = db.query("select count(*) c from title_lang where rank is not null").get() as {
      c: number;
    };
    expect(ranked.c).toBeGreaterThan(0);
  });

  test("non_english is a property of the TITLE, so every row of a title agrees", () => {
    // `tt-multi` is hi/en/pa: all three of its rows are 0, including the `hi` one, which is
    // what makes "in Hindi and not also in English" a single equality rather than a proof.
    const db = indexOf(CORPUS);
    const flags = db
      .query(
        `select t.tconst, l.lang, l.non_english n from title_lang l join title t on t.rowid_ = l.title_rowid
          where t.tconst in ('tt-multi', 'tt-hi', 'tt-en1', 'tt-unknown') order by t.tconst, l.lang`,
      )
      .all() as { tconst: string; lang: string; n: number }[];
    expect(flags).toEqual([
      { tconst: "tt-en1", lang: "en", n: 0 },
      { tconst: "tt-hi", lang: "hi", n: 1 },
      { tconst: "tt-multi", lang: "en", n: 0 },
      { tconst: "tt-multi", lang: "hi", n: 0 },
      { tconst: "tt-multi", lang: "pa", n: 0 },
      // The backfill. Nobody knows its language, so nothing says it is English.
      { tconst: "tt-unknown", lang: UNKNOWN_LANG, n: 1 },
    ]);
  });

  test("the backfilled row carries the columns too, not just the language", () => {
    // It is in the same index as every other row, so a NULL `kind` here would be a row that
    // seeks differently from its neighbours for no reason anybody would think to look for.
    const db = indexOf(CORPUS);
    const row = db
      .query(
        `select l.kind, l.rank from title_lang l join title t on t.rowid_ = l.title_rowid
          where t.tconst = 'tt-unknown'`,
      )
      .get() as { kind: string; rank: number | null };
    expect(row.kind).toBe("movie");
    expect(row.rank).not.toBeNull();
  });
});

describe("a language LIST seeks ix_lang_rank rather than walking the rank order", () => {
  /*
    THE POINT OF THE WHOLE CARD, and it cannot be asserted as a duration on a seven-row
    fixture, so it is asserted as a PLAN -- the same device the `ix_lang` block above uses.

    The shape being defended: three equality columns fix a range and `rank desc` is read in
    output order, so 250 rows cost 250 rows however thin the language's catalogue is. A TEMP
    B-TREE here means the ordering has stopped being served and the seek has become a sort of
    everything that matched, which is the regression that would be invisible in every other
    test in this file.

    Measured on a copy of the real 1,288,159-row index on 2026-09-06 with `ix_lang_rank` the
    only thing that changed -- figures per language are in `LIST_LANGUAGES`.

    `browseSql` writes this predicate and `INDEXES.origin` builds this index; the two have to
    move together and this is what says so when one of them does.
  */
  const planOf = (db: Database, sql: string, args: unknown[]) =>
    (db.query(`explain query plan ${sql}`).all(...(args as never[])) as { detail: string }[])
      .map((r) => r.detail)
      .join(" | ");

  test("the plan is a covering seek with no sort", () => {
    const db = indexOf(CORPUS);
    db.run("analyze");
    const sql = `select t.tconst from title t join title_lang l on l.title_rowid = t.rowid_
       where l.lang = ? and l.non_english = 1 and l.kind = ? and l.rank is not null
       order by l.rank desc limit 250`;
    const plan = planOf(db, sql, ["hi", "movie"]);
    expect(plan).toContain("ix_lang_rank");
    expect(plan).not.toContain("TEMP B-TREE");
  });

  test("the index carries the two equality columns AHEAD of the sort column", () => {
    /*
      Pinned as DDL, because the plan test above would still pass on a fixture small enough to
      scan. Together they say seek AND why. Moving `rank desc` in front of `lang` or `kind`
      would leave an index that cannot serve the order for a fixed language.

      `non_english` and `year` sit AFTER the sort column, and for the same reason: `non_english`
      is what admits English, the one language that constrains it not at all, and `year` is a
      RANGE on a decade browse. Either one in front of `rank desc` leaves an index that cannot
      serve the order -- see `langListJoin` and `INDEXES.origin`.

      Both orders are pinned, because there is one index per order now and a widening applied
      to only one of them is exactly the drift this asserts against.
    */
    expect(INDEXES.origin.join("")).toContain("title_lang(lang, kind, rank desc, non_english, year)");
    expect(INDEXES.origin.join("")).toContain("title_lang(lang, kind, votes desc, non_english, year)");
  });

  test("English seeks the same index, with no `non_english` range to merge", () => {
    // The card's own case. English constrains `non_english` not at all, so this plan is only
    // a seek because the sort column comes first -- under the original column order it was a
    // TEMP B-TREE over every English film, which is why the join was declined outright.
    const db = indexOf(CORPUS);
    db.run("analyze");
    const sql = `select t.tconst from title t join title_lang l on l.title_rowid = t.rowid_
       where l.lang = ? and l.kind = ? and l.rank is not null
       order by l.rank desc limit 250`;
    const plan = planOf(db, sql, ["en", "movie"]);
    expect(plan).toContain("ix_lang_rank");
    expect(plan).not.toContain("TEMP B-TREE");
  });

  test("and its COUNT reads title_lang alone, which is where the 194 ms was", () => {
    // The rows were never the cost: 0.06 ms of them against 196 ms of counting every English
    // film through `title`. `coveringCountTable` is what turns the count into an index range,
    // and it can only do that while no predicate names a column `title_lang` lacks.
    const db = indexOf(CORPUS);
    db.run("analyze");
    const plan = planOf(
      db,
      "select count(*) c from title_lang l where l.lang = ? and l.kind = ? and l.rank is not null",
      ["en", "movie"],
    );
    expect(plan).toContain("ix_lang_rank");
    // COVERING is the whole claim: a count that reaches into a table page per matching row is
    // the 196 ms shape wearing an index's name.
    expect(plan).toContain("COVERING INDEX");
  });
});

describe("the two paths are the same list", () => {
  /*
    The denormalised path is an OPTIMISATION, so the only thing that may differ between it
    and the `exists`/`not exists` pair is how long it takes. Asserted over every shape the
    fixture can express rather than on one language, because the ways they could diverge are
    all edges: a multi-language title counted twice by the join, a title whose `en` row makes
    it foreign to itself, a language nobody is in.

    > [!IMPORTANT] "The same list" means the same SET. TIED RANKS ORDER ARBITRARILY, on both
    > paths, and that is not something this card introduced
    > `order by rank desc` carries no unique tiebreak anywhere in `browseSql`, and the
    > Bayesian rank collapses to the identical value for every title sharing a rating and a
    > vote count -- which most of the low-vote tail does. So the two paths, reading two
    > different indexes, legitimately disagree about which of two equally-ranked films sits at
    > position 148, and about which of them falls off the end at 250.
    >
    > Measured on the real 1,288,159-row index on 2026-09-06: 37 of 75 language lists came
    > back in a different order, and across 54 checked position by position, EVERY difference
    > was between titles carrying the same `rank` bit for bit, with exactly one title swapping
    > at a 250 boundary. The fixture below carries a deliberate tie so the rule is pinned
    > rather than only written down.
  */
  /*
    `fast` turns on EVERY `title_lang` capability, not only `langRank`. They are one stage's
    output and a real engine reads all three off the same file, so a `fast` that left `langYear`
    off would quietly decline the join on any year-sliced shape -- and then compare the slow
    path against itself, which is the vacuous test this block exists to avoid.
  */
  const both = (db: Database, opts: Parameters<typeof browseIndex>[1]) => ({
    slow: browseIndex(db, { ...opts, langRank: false, langYear: false, langVotes: false }),
    fast: browseIndex(db, { ...opts, langRank: true, langYear: true, langVotes: true }),
  });

  for (const lang of ["hi", "ta", "sv", "pa", "ko"]) {
    test(`\`lang=${lang}\` resolves to the same rows and the same total`, () => {
      const db = indexOf(CORPUS);
      const { slow, fast } = both(db, { kind: "movie", lang, sort: "rank", limit: 50 });
      expect(fast.rows.map((r) => r.tconst)).toEqual(slow.rows.map((r) => r.tconst));
      expect(fast.total).toBe(slow.total);
    });
  }

  test("tied ranks give the same SET, and any positional difference is a tie", () => {
    // Two Swedish films with the identical rating and vote count, so `applyRank` gives them
    // the identical rank and neither path has anything to order them by. What must hold is
    // that both films are in both answers.
    const tied: Row[] = [
      {
        tconst: "tt-tie1",
        year: 2001,
        kind: "movie",
        votes: 40_000,
        rating: 7.5,
        genres: "Crime",
        langs: ["sv"],
      },
      {
        tconst: "tt-tie2",
        year: 2002,
        kind: "movie",
        votes: 40_000,
        rating: 7.5,
        genres: "Crime",
        langs: ["sv"],
      },
    ];
    const db = indexOf([...CORPUS, ...tied]);
    const ranks = db.query("select rank from title where tconst in ('tt-tie1','tt-tie2')").all() as {
      rank: number;
    }[];
    expect(ranks[0]?.rank).toBe(ranks[1]!.rank);
    const { slow, fast } = both(db, { kind: "movie", lang: "sv", sort: "rank", limit: 50 });
    expect(new Set(fast.rows.map((r) => r.tconst))).toEqual(new Set(slow.rows.map((r) => r.tconst)));
    expect(fast.total).toBe(slow.total);
  });

  test("a multi-language title appears ONCE, not once per language", () => {
    // The join's own hazard: `title_lang` has three rows for `tt-multi`, and a join that did
    // not fix `lang` would return it three times -- which a `limit` turns into a short page
    // rather than into an error. Here it is out of the Hindi list entirely (it is also in
    // English), so the case is put on a title that IS in its list.
    const db = indexOf([
      ...CORPUS,
      {
        tconst: "tt-hipa",
        year: 2020,
        kind: "movie",
        votes: 60_000,
        rating: 8.0,
        genres: "Crime",
        langs: ["hi", "pa"],
      },
    ]);
    const ids = browseIndex(db, { kind: "movie", lang: "hi", sort: "rank", limit: 50, langRank: true }).rows;
    expect(ids.filter((r) => r.tconst === "tt-hipa").length).toBe(1);
  });

  test("`lang=en` on a FILTERED browse declines the join and still means films in English", () => {
    // English is the one language with no `not exists` half -- a title carrying an `en` row is
    // not foreign, including its own `en` row -- so `title_lang` narrows nothing for it and
    // the join only pays when the index answers the whole query. A genre is one of the four
    // things that stops it: see `langIndexServesAlone`.
    const db = indexOf(CORPUS);
    const { slow, fast } = both(db, { genre: "Crime", lang: "en", limit: 50 });
    expect(fast.rows.map((r) => r.tconst).sort()).toEqual(["tt-en1", "tt-en2", "tt-multi"].sort());
    expect(fast.rows.map((r) => r.tconst)).toEqual(slow.rows.map((r) => r.tconst));
  });

  test("`lang=en` on the RANKED browse takes the join and means the same thing", () => {
    /*
      The shape the whole card is about, and the one place English drives from `title_lang`.
      "Films in English" here is every title carrying an `en` row -- `tt-multi` is in three
      languages including English and belongs, which is exactly the row a `non_english = 1`
      predicate leaking into this path would drop. That failure would look like a shorter page
      rather than an error, so it is asserted as a SET and not only as an agreement.
    */
    const db = indexOf(CORPUS);
    const { slow, fast } = both(db, { kind: "movie", lang: "en", sort: "rank", limit: 50 });
    expect(fast.rows.map((r) => r.tconst).sort()).toEqual(["tt-en1", "tt-en2", "tt-multi"].sort());
    expect(fast.rows.map((r) => r.tconst)).toEqual(slow.rows.map((r) => r.tconst));
    expect(fast.total).toBe(slow.total);
  });

  test("a GENRE still puts `title` back in the query and hands English to the slow path", () => {
    /*
      The one clause of `langIndexServesAlone` that did NOT move on 2026-09-07, and it is a
      decision rather than a gap -- a title has many genres, so denormalising one onto
      `title_lang` is a cross product rather than a column. See `coveringCountTable`.

      WHICH BRANCH RAN IS ASSERTED, not just that the answers match -- an equivalence between
      two runs of the SAME query is the vacuous test the preference case below names. The
      device: on a file built before the 2026-09-06 widening the denormalised predicate is a
      `no such column`, so forcing `langRank` on THROWS exactly when the join was taken. The
      unfiltered shape throwing is half the assertion; the genre one not throwing is the other.
    */
    const old = indexOf(CORPUS, { withLangRank: false });
    const force = (opts: Parameters<typeof browseIndex>[1]) => () =>
      browseIndex(old, { ...opts, langRank: true });
    expect(force({ kind: "movie", lang: "en", sort: "rank", limit: 50 })).toThrow();

    const genred = { kind: "movie", lang: "en", genre: "Crime", sort: "rank" as const, limit: 50 };
    expect(force(genred)).not.toThrow();
    const db = indexOf(CORPUS);
    const { slow, fast } = both(db, genred);
    expect(fast.rows.map((r) => r.tconst)).toEqual(slow.rows.map((r) => r.tconst));
    expect(fast.total).toBe(slow.total);
  });

  test("a YEAR, a DECADE and a VOTES sort now take the join, and mean the same thing", () => {
    /*
      The three clauses that MOVED on 2026-09-07, once `year` and `votes` were denormalised
      here. Each was a measured regression on the joined path before those columns existed --
      79.2 ms against 10.0 with a year, 156.2 against 29.0 on a votes sort -- and each is now
      the other way round: measured on a copy of the real 1,276,669-title index, M1 Max,
      `?lang=en&kind=movie&decade=2010&sort=rank` 280.9 ms -> 3.2 and
      `?lang=en&kind=movie&sort=votes` 28.1 -> 0.9.

      Same device as the genre case above, one widening later: on a file carrying the list
      columns but not `year` or `votes`, forcing the new capability on is a `no such column`,
      so it THROWS exactly when the join was taken. Both halves are asserted -- forcing the
      flag ON throws, leaving it OFF does not -- because only the pair rules out a flag that
      does nothing.
    */
    const old = indexOf(CORPUS, { withLangYear: false });
    const db = indexOf(CORPUS);
    for (const [opts, caps] of [
      [{ kind: "movie", lang: "en", year: 2015, sort: "rank" as const, limit: 50 }, { langYear: true }],
      [{ kind: "movie", lang: "en", decade: 2010, sort: "rank" as const, limit: 50 }, { langYear: true }],
      [{ kind: "movie", lang: "en", sort: "votes" as const, limit: 50 }, { langVotes: true }],
    ] as const) {
      expect(() => browseIndex(old, { ...opts, langRank: true, ...caps })).toThrow();
      expect(() => browseIndex(old, { ...opts, langRank: true })).not.toThrow();
      const { slow, fast } = both(db, opts);
      expect(fast.rows.map((r) => r.tconst)).toEqual(slow.rows.map((r) => r.tconst));
      expect(fast.total).toBe(slow.total);
    }
  });

  test("a genre, a decade and a vote floor all survive the join", () => {
    // The combined shapes, where the count can no longer read one table alone and `title` is
    // back in the from-clause. Correct or a `no such column`, never quietly different.
    const db = indexOf(CORPUS);
    for (const opts of [
      { genre: "Crime", lang: "hi", sort: "rank" as const, limit: 50 },
      { kind: "movie", lang: "hi", decade: 2020, limit: 50 },
      { kind: "movie", lang: "hi", minVotes: 1000, limit: 50 },
    ]) {
      const { slow, fast } = both(db, opts);
      expect(fast.rows.map((r) => r.tconst)).toEqual(slow.rows.map((r) => r.tconst));
      expect(fast.total).toBe(slow.total);
    }
  });

  test("a DEPLOYMENT PREFERENCE is untouched by the flag -- it is not a list", () => {
    // Driving a preference from `title_lang` would read 81% of the table, which is the
    // 1,014 ms shape `INDEXES.origin` documents. `langListJoin` declines it, so the two
    // answers here are the same query rather than two paths agreeing.
    const db = indexOf(CORPUS);
    const { slow, fast } = both(db, { genre: "Crime", languages: EN_SV, limit: 50 });
    expect(fast.rows.map((r) => r.tconst)).toEqual(slow.rows.map((r) => r.tconst));
    expect(fast.hiddenByLanguage).toEqual(slow.hiddenByLanguage);
  });
});

describe("an index built BEFORE the widening", () => {
  /*
    The `hasGenreVotes` contract rather than the `hasOrigin` one: this capability gates an
    OPTIMISATION, so a file without it must answer every language list CORRECTLY and merely
    more slowly. The failure it exists to prevent is the opposite of `hasOrigin`'s -- not an
    empty product, but a `no such column: l.non_english` on every language list for the
    up-to-a-day window before the next nightly rebuild lands.
  */
  test("the flag switches a real path, which is what makes the equivalence above mean something", () => {
    // The denormalised predicate names columns this file does not have, so forcing the flag
    // on is a `no such column`. Without this, every "the two paths agree" test above would
    // still pass if `langRank` did nothing at all.
    const db = indexOf(CORPUS, { withLangRank: false });
    expect(() => browseIndex(db, { kind: "movie", lang: "hi", langRank: true, limit: 50 })).toThrow();
    expect(() => browseIndex(db, { kind: "movie", lang: "hi", langRank: false, limit: 50 })).not.toThrow();
  });

  test("hasLangRank is false while hasOrigin stays true", () => {
    const engine = engineOn(CORPUS, { withLangRank: false });
    try {
      expect(engine.hasOrigin).toBe(true);
      expect(engine.hasLangRank).toBe(false);
    } finally {
      engine.close();
    }
  });

  test("every language list answers exactly what the widened file answers", () => {
    const old = engineOn(CORPUS, { withLangRank: false });
    const wide = engineOn(CORPUS);
    try {
      expect(wide.hasLangRank).toBe(true);
      for (const lang of ["hi", "ta", "sv", "en", "ko"]) {
        expect(old.rankedMembers({ kind: "movie", lang }, 250)).toEqual(
          wide.rankedMembers({ kind: "movie", lang }, 250),
        );
        const a = old.browse({ kind: "movie", lang, limit: 50 });
        const b = wide.browse({ kind: "movie", lang, limit: 50 });
        expect(a.rows.map((r) => r.tconst)).toEqual(b.rows.map((r) => r.tconst));
        expect(a.total).toBe(b.total);
      }
    } finally {
      old.close();
      wide.close();
    }
  });
});

describe("an index built between the two widenings -- list columns, no `year` and no `votes`", () => {
  /*
    The state a running deployment is actually in for up to a day after the 2026-09-07 stage
    lands, and the one this card's capability pair exists for. Same contract as the block
    above: SLOWER, never absent, never an exception.
  */
  test("hasLangRank stays true while hasLangYear and hasLangVotes go false", () => {
    const engine = engineOn(CORPUS, { withLangYear: false });
    try {
      expect(engine.hasOrigin).toBe(true);
      expect(engine.hasLangRank).toBe(true);
      expect(engine.hasLangYear).toBe(false);
      expect(engine.hasLangVotes).toBe(false);
    } finally {
      engine.close();
    }
  });

  test("the COLUMN alone is not enough -- a narrow `ix_lang_rank` still reads false", () => {
    /*
      The half `hasLangRank` set the precedent for, and the one a column check alone would
      miss: with `year` on the table but not in the index, the count falls out of the index
      onto a table lookup per candidate row -- slower than the path it replaced, which is the
      one way a capability probe can make things worse rather than better.
    */
    const db = indexOf(CORPUS, { withLangYear: false });
    db.run("alter table title_lang add column year integer");
    const path = db.filename;
    db.close();
    const engine = new SearchEngine(path, loadConfig());
    try {
      expect(engine.hasLangYear).toBe(false);
    } finally {
      engine.close();
    }
  });

  test("every shape the new columns serve answers exactly what the widened file answers", () => {
    const old = engineOn(CORPUS, { withLangYear: false });
    const wide = engineOn(CORPUS);
    try {
      expect(wide.hasLangYear).toBe(true);
      expect(wide.hasLangVotes).toBe(true);
      for (const opts of [
        { kind: "movie", lang: "en", year: 2015, sort: "rank" as const, limit: 50 },
        { kind: "movie", lang: "en", decade: 2010, sort: "rank" as const, limit: 50 },
        { kind: "movie", lang: "en", sort: "votes" as const, limit: 50 },
        { kind: "movie", lang: "hi", decade: 2020, sort: "votes" as const, limit: 50 },
        { kind: "movie", lang: "sv", sort: "votes" as const, limit: 50 },
        { kind: "movie", lang: "hi", genre: "Crime", sort: "votes" as const, limit: 50 },
      ]) {
        const a = old.browse(opts);
        const b = wide.browse(opts);
        expect(b.rows.map((r) => r.tconst)).toEqual(a.rows.map((r) => r.tconst));
        expect(b.total).toBe(a.total);
      }
    } finally {
      old.close();
      wide.close();
    }
  });
});

describe("languageFilter", () => {
  test("no preference stays no preference", () => {
    expect(languageFilter([])).toEqual([]);
  });

  test("a preference always admits the unknowns -- the fail-open rule", () => {
    expect(languageFilter(["en", "sv"])).toEqual(["en", "sv", UNKNOWN_LANG]);
  });
});

describe("the browse filter", () => {
  test("keeps the listed languages and drops the rest", () => {
    const db = indexOf(CORPUS);
    const kept = titles(db, { genre: "Crime", languages: EN_SV, limit: 50 });
    expect(kept).toContain("tt-en1");
    expect(kept).toContain("tt-sv");
    expect(kept).not.toContain("tt-ta");
    expect(kept).not.toContain("tt-hi");
  });

  test("a title matches on ANY of its languages", () => {
    const db = indexOf(CORPUS);
    expect(titles(db, { genre: "Crime", languages: EN_SV, limit: 50 })).toContain("tt-multi");
  });

  test("a title of unknown language is ADMITTED, never hidden", () => {
    const db = indexOf(CORPUS);
    expect(titles(db, { genre: "Crime", languages: EN_SV, limit: 50 })).toContain("tt-unknown");
  });

  test("an empty list is no filter at all, not a filter matching nothing", () => {
    const db = indexOf(CORPUS);
    expect(titles(db, { genre: "Crime", languages: [], limit: 50 }).length).toBe(CORPUS.length);
  });

  test("the total counts the filtered rows, not the unfiltered ones", () => {
    const db = indexOf(CORPUS);
    const res = browseIndex(db, { genre: "Crime", languages: EN_SV, limit: 50 });
    expect(res.total).toBe(res.rows.length);
    expect(res.total).toBeLessThan(CORPUS.length);
  });

  test("it survives a GENRE browse, where the count reads title_genre alone", () => {
    // The alias trap: `title_genre` has no `t` to name. A regression here is a
    // `no such column` on the one query the covering count exists to serve.
    const db = indexOf(CORPUS);
    expect(() => browseIndex(db, { genre: "Crime", languages: EN_SV, limit: 50 })).not.toThrow();
    expect(() => browseIndex(db, { kind: "movie", languages: EN_SV, limit: 50 })).not.toThrow();
  });

  test("it applies to a ranked list too -- the complaint that started this", () => {
    const db = indexOf(CORPUS);
    const ranked = titles(db, { genre: "Crime", sort: "rank", languages: EN_SV, limit: 50 });
    expect(ranked).not.toContain("tt-ta");
    expect(ranked).not.toContain("tt-hi");
    expect(ranked.length).toBeGreaterThan(0);
  });
});

describe("a NAMED language -- what a list is, as opposed to what a preference is", () => {
  /*
    `BrowseFilters.lang` and `BrowseOptions.languages` are two different rules and this block
    is where the difference is pinned. The preference fails toward showing TOO MUCH: any
    match, unknowns admitted, liftable. A list's own language fails the other way, because
    its NAME is a claim about the film -- measured on the real index, "has `ja` among its
    languages" puts Inception at the top of what would be called a Japanese list.

    `tt-multi` is the fixture that carries the whole argument: hi/en/pa, a Hindi film with
    English in it, in on the preference and out of the list.
  */
  test("it keeps films in the language and drops films that are also in English", () => {
    const db = indexOf(CORPUS);
    const kept = titles(db, { genre: "Crime", lang: "hi", limit: 50 });
    expect(kept).toEqual(["tt-hi"]);
    expect(kept).not.toContain("tt-multi");
    // And the preference, over the same fixture, deliberately keeps it.
    expect(titles(db, { genre: "Crime", languages: EN_SV, limit: 50 })).toContain("tt-multi");
  });

  test("a title of unknown language is NOT admitted -- the opposite of the preference", () => {
    // The fail-open rule exists so OUR gap does not hide a reader's titles. A list is a
    // claim, and "we do not know what language this is" cannot substantiate one.
    const db = indexOf(CORPUS);
    expect(titles(db, { genre: "Crime", lang: "hi", limit: 50 })).not.toContain("tt-unknown");
  });

  test("`lang=en` is films in English, not the empty contradiction", () => {
    // Without the exception it would read "in English and not in English", an empty page
    // with no way to see it as anything but a bug. There is no English LIST, but a browse
    // can still be bookmarked with one.
    const db = indexOf(CORPUS);
    const kept = titles(db, { genre: "Crime", lang: "en", limit: 50 });
    expect(kept.sort()).toEqual(["tt-en1", "tt-en2", "tt-multi"].sort());
  });

  test("it REPLACES the deployment preference rather than composing with it", () => {
    // Composing would empty every language list on a deployment that had configured
    // `languages` -- a page of dead links rather than a stricter filter. The reader who
    // named a language has already overridden the default.
    const db = indexOf(CORPUS);
    expect(titles(db, { genre: "Crime", lang: "ta", languages: EN_SV, limit: 50 })).toEqual(["tt-ta"]);
  });

  test("it survives a genre browse and a ranked list, like every other predicate here", () => {
    // The alias trap again: a genre count reads `title_genre` alone and has no `t` to name,
    // and this predicate is now TWO subqueries rather than one.
    const db = indexOf(CORPUS);
    expect(() => browseIndex(db, { genre: "Crime", lang: "hi", limit: 50 })).not.toThrow();
    expect(() => browseIndex(db, { kind: "movie", lang: "hi", sort: "rank", limit: 50 })).not.toThrow();
    expect(titles(db, { kind: "movie", lang: "ta", sort: "rank", limit: 50 })).toEqual(["tt-ta"]);
  });

  test("the total counts the language's rows, never a stored unfiltered count", () => {
    // `browse_count`'s grain is (kind, genre, year) and carries no language dimension, so a
    // stored total here would answer a different question -- and a total is printed to the
    // reader as a fact.
    const db = indexOf(CORPUS);
    const res = browseIndex(db, { genre: "Crime", lang: "hi", limit: 50 });
    expect(res.total).toBe(1);
  });

  test("an empty language page offers NO any-language hatch", () => {
    /*
      The hatch lifts a threshold of OURS. A language the reader navigated to is what the
      page IS, so "show all 3 in any language" under the heading "Best films in Swedish"
      would answer a different question -- and would leave the reader on a page whose title
      no longer describes it.
    */
    const db = indexOf(CORPUS);
    const res = browseIndex(db, { genre: "Crime", lang: "ko", limit: 50 });
    expect(res.rows).toEqual([]);
    expect(res.hiddenByLanguage).toBeUndefined();
    expect(res.hiddenByFloor).toBeUndefined();
  });
});

describe("hiddenByLanguage -- our own threshold may never look like absence", () => {
  test("an emptied page says so, with a count and the languages applied", () => {
    const db = indexOf([
      { tconst: "tt-x1", year: 2021, kind: "movie", votes: 90_000, genres: "Musical", langs: ["ta"] },
      { tconst: "tt-x2", year: 2022, kind: "movie", votes: 80_000, genres: "Musical", langs: ["hi"] },
    ]);
    const res = browseIndex(db, { genre: "Musical", languages: EN_SV, limit: 50 });
    expect(res.rows).toEqual([]);
    expect(res.hiddenByLanguage).toEqual({ titles: 2, languages: ["en", "sv"] });
  });

  test("UNKNOWN_LANG is never printed as one of the languages", () => {
    const db = indexOf([
      { tconst: "tt-y1", year: 2021, kind: "movie", votes: 90_000, genres: "Musical", langs: ["ta"] },
    ]);
    const res = browseIndex(db, { genre: "Musical", languages: EN_SV, limit: 50 });
    expect(res.hiddenByLanguage?.languages).not.toContain(UNKNOWN_LANG);
  });

  test("a page with rows offers no hatch and pays for no second count", () => {
    const db = indexOf(CORPUS);
    const res = browseIndex(db, { genre: "Crime", languages: EN_SV, limit: 50 });
    expect(res.hiddenByLanguage).toBeUndefined();
  });

  test("nothing matching for a reason that is NOT the language offers no language hatch", () => {
    const db = indexOf(CORPUS);
    const res = browseIndex(db, { genre: "Western", languages: EN_SV, limit: 50 });
    expect(res.rows).toEqual([]);
    expect(res.hiddenByLanguage).toBeUndefined();
  });

  test("the LANGUAGE hatch wins over the floor -- only one is ever offered", () => {
    /*
      Both thresholds are in force and each removed something: the Tamil film clears the
      floor and the language filter takes it, the English one is the right language and
      sits below the floor. Offering the floor here would name a count the reader cannot
      reach without also lifting the language.
    */
    const db = indexOf([
      { tconst: "tt-z1", year: 2021, kind: "movie", votes: 90_000, genres: "Musical", langs: ["ta"] },
      { tconst: "tt-z2", year: 2021, kind: "movie", votes: 5, genres: "Musical", langs: ["en"] },
    ]);
    const res = browseIndex(db, { kind: "movie", languages: EN_SV, limit: 50 });
    expect(res.rows).toEqual([]);
    expect(res.hiddenByLanguage).toBeDefined();
    expect(res.hiddenByFloor).toBeUndefined();
  });
});

describe("the years range", () => {
  test("an inclusive [from, to] selects exactly that span", () => {
    const db = indexOf(CORPUS);
    const kept = titles(db, { genre: "Crime", years: [2018, 2021], limit: 50 });
    expect(kept.sort()).toEqual(["tt-en2", "tt-multi", "tt-ta", "tt-unknown"].sort());
  });

  test("it drops the vote floor, exactly as a decade does", () => {
    expect(browseVoteFloor({ years: [2011, 2026] })).toBe(0);
    expect(browseVoteFloor({ kind: "movie" })).toBeGreaterThan(0);
  });

  test("a ranked span is ordered by rank and still filtered by language", () => {
    const db = indexOf(CORPUS);
    const kept = titles(db, { years: [2011, 2026], sort: "rank", languages: EN_SV, limit: 50 });
    expect(kept).not.toContain("tt-ta");
    expect(kept[0]).toBe("tt-en1");
  });

  test("`year` wins over `years`, and `years` over `decade`", () => {
    const db = indexOf(CORPUS);
    expect(titles(db, { year: 2016, years: [2018, 2021], decade: 2010, limit: 50 })).toEqual(["tt-sv"]);
    expect(titles(db, { years: [2022, 2022], decade: 2010, limit: 50 })).toEqual(["tt-hi"]);
  });

  test("a span too wide to split still returns the right rows", () => {
    // Past the split cap it falls back to a range scan -- slower, never wrong.
    const db = indexOf(CORPUS);
    expect(titles(db, { genre: "Crime", years: [1900, 2100], limit: 50 }).length).toBe(CORPUS.length);
  });
});

describe("an index built BEFORE the origin stage", () => {
  test("has no title_lang, so the filter must not be applied to it", () => {
    // Straight to `browseIndex` with a preference is what `SearchEngine.browse` refuses to
    // do -- see `hasOrigin`. This asserts the shape of the file the guard exists for.
    const db = indexOf(CORPUS, { withOrigin: false });
    const has = db
      .query("select count(*) c from sqlite_master where type = 'table' and name = 'title_lang'")
      .get() as { c: number };
    expect(has.c).toBe(0);
    // With no preference passed, the same index browses exactly as it always did.
    expect(titles(db, { genre: "Crime", limit: 50 }).length).toBe(CORPUS.length);
  });

  test("ORIGIN_SCHEMA is part of SCHEMA, so a fresh build always has the table", () => {
    expect(SCHEMA).toContain(ORIGIN_SCHEMA.trim().split("\n")[0]);
  });

  /*
    THE PREFERENCE DROPS AND A NAMED LANGUAGE REFUSES, and these two tests are the whole of
    that rule. Both go through `SearchEngine`, because `hasOrigin` is a property of the OPEN
    FILE and `browseIndex` deliberately knows nothing about it.

    They are opposite answers to one question and both are "fail toward the honest thing". A
    preference the reader never typed should not empty the product, so it is dropped and they
    see titles they did not ask for. A language they navigated to is what the page IS, so
    dropping it would serve the unfiltered top 250 under the heading "Best films in Korean".
  */
  test("a PREFERENCE is dropped, so the product still has rows in it", () => {
    const engine = engineOn(CORPUS, { withOrigin: false });
    try {
      expect(engine.hasOrigin).toBe(false);
      expect(engine.browse({ genre: "Crime", languages: EN_SV, limit: 50 }).rows.length).toBe(CORPUS.length);
    } finally {
      engine.close();
    }
  });

  test("a NAMED language draws nothing, which is what keeps the group off `/lists`", () => {
    const engine = engineOn(CORPUS, { withOrigin: false });
    try {
      // Empty rather than throwing: `title_lang` is absent as a TABLE on such a file, so the
      // semi-join would not return nothing, it would be a `no such table` on every request.
      const res = engine.browse({ genre: "Crime", lang: "hi", limit: 50 });
      expect(res).toEqual({ rows: [], total: 0 });
      // No members means no completion, which is what `requiresMembers` reads to decide the
      // language group draws no rows at all rather than a row per dead link.
      expect(engine.rankedMembers({ kind: "movie", lang: "hi" }, 250)).toEqual([]);
      // The lists that do not name a language are untouched.
      expect(engine.rankedMembers({ kind: "movie" }, 250).length).toBeGreaterThan(0);
    } finally {
      engine.close();
    }
  });

  test("the list-floor census cannot be taken, and says so rather than reporting zeroes", () => {
    const engine = engineOn(CORPUS, { withOrigin: false });
    try {
      // `null`, never an empty map. An empty map is the finding "no language reaches a single
      // ranked film", and `auditListLanguages` would read it as every list being unfounded.
      expect(engine.rankedNonEnglishCounts("movie")).toBeNull();
    } finally {
      engine.close();
    }
  });
});

/**
 * The census `LIST_LANGUAGES` is audited against -- the same set arithmetic a language list
 * does, asked of every code at once.
 *
 * It lives here rather than beside `list-audit.ts` because the thing under test is the QUERY,
 * and this file already owns a faithful `title_lang`. The comparison it feeds is pure and is
 * tested against fixed counts in `list-audit.test.ts`.
 */
describe("counting the ranked non-English films of every language", () => {
  test("counts a language once per title, and only for the kind asked about", () => {
    const engine = engineOn(CORPUS);
    try {
      const counts = engine.rankedNonEnglishCounts("movie");
      expect(counts).not.toBeNull();
      // `tt-multi` is hi/en/pa and rides in on its `en`, so it counts for NEITHER `hi` nor
      // `pa` -- which is why `pa` is absent entirely rather than present at zero. That is the
      // whole "not also in English" rule the group blurb on /lists promises.
      expect([...(counts as Map<string, number>)].sort()).toEqual([
        ["hi", 1],
        ["sv", 1],
        ["ta", 1],
      ]);
    } finally {
      engine.close();
    }
  });

  test("UNKNOWN_LANG is stripped here, so no audit ever reads the sentinel as a language", () => {
    const engine = engineOn(CORPUS);
    try {
      // `tt-unknown` carries the empty string and is 186,109 films on the real index -- easily
      // over any floor, and it is a storage device rather than a language. Left in, it would
      // be reported forever as a language missing its list.
      expect(engine.rankedNonEnglishCounts("movie")?.has(UNKNOWN_LANG)).toBe(false);
    } finally {
      engine.close();
    }
  });

  test("a kind nothing is filed under is an empty census rather than a refusal", () => {
    const engine = engineOn(CORPUS);
    try {
      // The other half of the `null` rule above: this file CAN answer, and the answer is that
      // there are no ranked non-English series in it.
      expect(engine.rankedNonEnglishCounts("tvSeries")).toEqual(new Map());
    } finally {
      engine.close();
    }
  });

  test("it reads the same rows on a file from before either widening", () => {
    // The `not exists` pair rather than `title_lang.non_english`, which is why this works at
    // all on a two-column `title_lang`. A second query for older files would be a second copy
    // of the membership rule -- exactly the drift the audit exists to catch.
    const engine = engineOn(CORPUS, { withLangRank: false });
    try {
      expect([...(engine.rankedNonEnglishCounts("movie") as Map<string, number>)].sort()).toEqual([
        ["hi", 1],
        ["sv", 1],
        ["ta", 1],
      ]);
    } finally {
      engine.close();
    }
  });
});
