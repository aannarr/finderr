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
import { loadOrigin, ORIGIN_SCHEMA, parseOriginCsv, UNKNOWN_LANG } from "./crosswalk";
import { applyRank, EXPLODE_GENRES, INDEXES, SCHEMA } from "./index-builder";
import { browseIndex, browseVoteFloor, languageFilter } from "./search";

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
});
