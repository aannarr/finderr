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

/** A throwaway index carrying the real schema, the origin stage, and its index. */
function indexOf(rows: Row[], opts: { withOrigin?: boolean } = {}): Database {
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
  for (const sql of INDEXES.origin) db.run(sql);
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
function engineOn(rows: Row[], opts: { withOrigin?: boolean } = {}): SearchEngine {
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
  const planOf = (db: Database, sql: string, args: unknown[]) =>
    (db.query(`explain query plan ${sql}`).all(...(args as never[])) as { detail: string }[])
      .map((r) => r.detail)
      .join(" | ");

  test("a genre browse seeks ix_lang and materialises no list", () => {
    const db = indexOf(CORPUS);
    db.run("analyze");
    const sql = `select t.tconst from title t join title_genre g on g.title_rowid = t.rowid_
       where g.genre = ? and exists (select 1 from title_lang l where l.title_rowid = g.title_rowid
         and l.lang in (?, ?, ?)) order by g.rank desc limit 40`;
    const plan = planOf(db, sql, ["Crime", ...EN_SV]);
    expect(plan).toContain("ix_lang");
    expect(plan).toContain("CORRELATED");
    // The shape that was 1,014 ms. A LIST SUBQUERY here means the `in (select ...)` form
    // has come back, whatever the index says.
    expect(plan).not.toContain("LIST SUBQUERY");
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
    expect(plan).toContain("ix_lang");
    expect(plan).toContain("CORRELATED");
    // The `not exists` half is the one that could quietly become a scan of the whole
    // language table once per candidate row, which is 1.3M rows on the real index.
    expect(plan).not.toContain("LIST SUBQUERY");
    expect(plan).not.toContain("SCAN l");
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
});
