/**
 * The browse vote floor, and what happens when it is the reason a page is empty.
 *
 * The policy is asserted as POLICY -- "a year drops the floor, a bare kind keeps it" --
 * rather than against a census of `data/titles.db`. A test pinned to the real index
 * would be measuring the IMDb dump, and would go red the next time it is rebuilt.
 */

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRank, EXPLODE_GENRES, SCHEMA } from "./index-builder";
import { browseIndex, browseVoteFloor, decadeOf } from "./search";

interface Fixture {
  tconst: string;
  year: number | null;
  kind: string;
  votes: number;
  genres: string;
  /** Defaults to 7, which is what every pre-rank case in this file assumed. */
  rating?: number;
}

const dir = mkdtempSync(join(tmpdir(), "finderr-browse-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/**
 * A throwaway index with the real schema and the caller's rows in it.
 *
 * The order here is the REAL builder's order and is not interchangeable: rank is applied
 * before the genres are exploded, because the explode copies `rank` and `kind` onto
 * `title_genre`. Reversing it writes a table of NULL ranks and every per-genre assertion
 * below would fail for a reason that has nothing to do with what it is testing.
 *
 * A small prior (10) is used rather than the shipped 25,000 so a fixture can move a row
 * with two-digit vote counts. The FORMULA is what is under test, not the constant.
 */
function indexOf(rows: Fixture[], priorVotes = 10): Database {
  const db = new Database(join(dir, `${crypto.randomUUID()}.db`), { create: true });
  db.run(SCHEMA);
  const insert = db.query(
    "insert into title (tconst, kind, title, year, votes, rating, genres) values (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const r of rows) insert.run(r.tconst, r.kind, r.tconst, r.year, r.votes, r.rating ?? 7, r.genres);
  applyRank(db, priorVotes);
  db.run(EXPLODE_GENRES);
  return db;
}

/** Eight obscure 1901 shorts, and one blockbuster to keep the broad grid populated. */
const OBSCURE_1901 = Array.from({ length: 8 }, (_, i) => ({
  tconst: `tt190${i}`,
  year: 1901,
  kind: "movie",
  votes: 40 + i,
  genres: "Short",
}));

const BLOCKBUSTER = { tconst: "tt-big", year: 1999, kind: "movie", votes: 900_000, genres: "Drama" };

const REALITY_TV_FILMS = Array.from({ length: 3 }, (_, i) => ({
  tconst: `tt-reality-${i}`,
  year: 2015,
  kind: "tvMovie",
  votes: 120 + i,
  genres: "Reality-TV,Documentary",
}));

describe("decadeOf", () => {
  test("a year falls in the decade it starts in", () => {
    expect(decadeOf(1994)).toBe(1990);
    expect(decadeOf(1990)).toBe(1990);
    expect(decadeOf(1999)).toBe(1990);
    expect(decadeOf(2000)).toBe(2000);
  });
});

describe("browseVoteFloor", () => {
  test("a broad query keeps the floor", () => {
    expect(browseVoteFloor({})).toBe(1000);
    expect(browseVoteFloor({ kind: "movie" })).toBe(1000);
    expect(browseVoteFloor({ genre: "Horror" })).toBe(1000);
    expect(browseVoteFloor({ genre: "Reality-TV", kind: "tvMovie" })).toBe(1000);
  });

  test("pinning a year or a decade drops it", () => {
    expect(browseVoteFloor({ year: 1901 })).toBe(0);
    expect(browseVoteFloor({ decade: 1900 })).toBe(0);
    // Still narrow, still no floor -- the year is doing the narrowing either way.
    expect(browseVoteFloor({ year: 1901, kind: "movie" })).toBe(0);
    expect(browseVoteFloor({ genre: "Horror", decade: 1980 })).toBe(0);
  });

  test("a rank sort drops the floor whatever the filters are", () => {
    // ONE owner for "what is hidden from a browse". The rank sort needs no floor because
    // the Bayesian prior suppresses thin titles continuously instead of at a cliff, and
    // that decision lives here rather than as a second threshold somewhere else.
    expect(browseVoteFloor({}, "rank")).toBe(0);
    expect(browseVoteFloor({ kind: "movie" }, "rank")).toBe(0);
    expect(browseVoteFloor({ genre: "Horror" }, "rank")).toBe(0);
    expect(browseVoteFloor({ genre: "Horror", decade: 1980 }, "rank")).toBe(0);
    // And the default argument is still the votes grid, so no existing caller moved.
    expect(browseVoteFloor({ kind: "movie" })).toBe(browseVoteFloor({ kind: "movie" }, "votes"));
  });
});

describe("browseIndex", () => {
  test("a year with only obscure titles returns them instead of nothing", () => {
    const db = indexOf([...OBSCURE_1901, BLOCKBUSTER]);
    const res = browseIndex(db, { year: 1901 });
    expect(res.total).toBe(8);
    expect(res.rows).toHaveLength(8);
    // Nothing was hidden, so there is nothing to offer to unhide.
    expect(res.hiddenByFloor).toBeUndefined();
  });

  test("a decade with only obscure titles returns them too", () => {
    const db = indexOf([...OBSCURE_1901, BLOCKBUSTER]);
    expect(browseIndex(db, { decade: 1900 }).total).toBe(8);
  });

  test("a broad grid still keeps its floor", () => {
    const db = indexOf([...OBSCURE_1901, BLOCKBUSTER]);
    const res = browseIndex(db, { kind: "movie" });
    expect(res.rows.map((r) => r.tconst)).toEqual(["tt-big"]);
  });

  test("a floored query that hid everything says how many and how high", () => {
    const db = indexOf([...REALITY_TV_FILMS, BLOCKBUSTER]);
    const res = browseIndex(db, { genre: "Reality-TV", kind: "tvMovie" });
    expect(res.total).toBe(0);
    expect(res.hiddenByFloor).toEqual({ titles: 3, minVotes: 1000 });
  });

  test("an honestly empty filter offers no escape hatch", () => {
    const db = indexOf([...REALITY_TV_FILMS, BLOCKBUSTER]);
    const res = browseIndex(db, { genre: "Film-Noir" });
    expect(res.total).toBe(0);
    expect(res.hiddenByFloor).toBeUndefined();
  });

  test("minVotes 0 lifts the floor and returns what it was hiding", () => {
    const db = indexOf([...REALITY_TV_FILMS, BLOCKBUSTER]);
    const res = browseIndex(db, { genre: "Reality-TV", kind: "tvMovie", minVotes: 0 });
    expect(res.total).toBe(3);
    expect(res.rows).toHaveLength(3);
    // The floor is gone, so it cannot be what emptied anything.
    expect(res.hiddenByFloor).toBeUndefined();
  });

  test("a rank browse takes no vote floor, because the prior already is one", () => {
    // The 1901 shorts are below every floor in the product. Under `sort: "rank"` they are
    // not hidden -- they are simply ranked, and the prior puts them where they belong.
    const db = indexOf([...OBSCURE_1901, BLOCKBUSTER]);
    const res = browseIndex(db, { kind: "movie", sort: "rank" });
    expect(res.total).toBe(9);
    // No floor was applied, so nothing can have been hidden by one.
    expect(res.hiddenByFloor).toBeUndefined();
  });

  test("the blockbuster outranks a high-rated title nobody voted on", () => {
    // The whole point of the Bayesian prior, in three rows: a perfect 10 from a handful of
    // people must not beat a 9.0 from a crowd. A plain `order by rating desc` gets this
    // exactly backwards, which is why the rank column exists at all.
    // The filler is what makes the corpus mean mean anything: with only two rows the mean
    // IS the crowd title's own rating, and a thinly-rated 10 edges above it. That is a
    // property of a two-row corpus, not of the formula.
    const filler = Array.from({ length: 8 }, (_, i) => ({
      tconst: `tt-mid-${i}`,
      year: 2000,
      kind: "movie",
      votes: 60_000,
      genres: "Drama",
      rating: 5,
    }));
    const db = indexOf([
      ...filler,
      { tconst: "tt-crowd", year: 2000, kind: "movie", votes: 900_000, genres: "Drama", rating: 9 },
      { tconst: "tt-thin", year: 2000, kind: "movie", votes: 3, genres: "Drama", rating: 10 },
    ]);
    const order = browseIndex(db, { kind: "movie", sort: "rank" }).rows.map((r) => r.tconst);
    // The crowd's 9.0 tops the list and the thin 10.0 does not, which is the entire
    // justification for a weighted rank over `order by rating desc`.
    expect(order[0]).toBe("tt-crowd");
    expect(order.indexOf("tt-crowd")).toBeLessThan(order.indexOf("tt-thin"));
  });

  test("an unrated title has no rank and is not in the list at all", () => {
    const db = indexOf([
      { tconst: "tt-rated", year: 2000, kind: "movie", votes: 5_000, genres: "Drama", rating: 8 },
      // Zero votes and zero rating is how the builder stores a title IMDb has no rating
      // for. It must not appear at the corpus mean, above every badly-rated film.
      { tconst: "tt-unrated", year: 2000, kind: "movie", votes: 0, genres: "Drama", rating: 0 },
    ]);
    const ranked = browseIndex(db, { kind: "movie", sort: "rank" });
    expect(ranked.rows.map((r) => r.tconst)).toEqual(["tt-rated"]);
    expect(ranked.total).toBe(1);
    // It is still a title, and a votes-ordered browse still lists it -- membership of a
    // LIST is what it lacks, not existence.
    expect(browseIndex(db, { kind: "movie", sort: "votes", minVotes: 0 }).total).toBe(2);
  });

  test("a genre list is ranked the same way the unfiltered one is", () => {
    // Ordered off `title_genre.rank` rather than `title.rank` -- the join changes which
    // column the SQL names, and this is what pins that the two agree.
    const db = indexOf([
      { tconst: "tt-good-horror", year: 2000, kind: "movie", votes: 500_000, genres: "Horror", rating: 8.5 },
      { tconst: "tt-ok-horror", year: 2000, kind: "movie", votes: 500_000, genres: "Horror", rating: 6.5 },
      { tconst: "tt-best-drama", year: 2000, kind: "movie", votes: 900_000, genres: "Drama", rating: 9.5 },
    ]);
    const res = browseIndex(db, { genre: "Horror", kind: "movie", sort: "rank" });
    expect(res.rows.map((r) => r.tconst)).toEqual(["tt-good-horror", "tt-ok-horror"]);
  });

  test("paging a ranked list never repeats or reshuffles a row", () => {
    // "Fair ranking" is votes-weighted AND stable: an order that differs between page 1
    // and page 2 is worse than one that is merely imperfect.
    const rows = Array.from({ length: 12 }, (_, i) => ({
      tconst: `tt-r${i}`,
      year: 2000,
      kind: "movie",
      votes: 100_000,
      genres: "Drama",
      rating: 5 + i * 0.25,
    }));
    const db = indexOf(rows);
    const first = browseIndex(db, { kind: "movie", sort: "rank", limit: 5 });
    const second = browseIndex(db, { kind: "movie", sort: "rank", limit: 5, offset: 5 });
    const seen = [...first.rows, ...second.rows].map((r) => r.tconst);
    expect(new Set(seen).size).toBe(10);
    // Highest rating first, since every row here has the same vote count.
    expect(seen[0]).toBe("tt-r11");
    expect(browseIndex(db, { kind: "movie", sort: "rank", limit: 5 }).rows.map((r) => r.tconst)).toEqual(
      first.rows.map((r) => r.tconst),
    );
  });

  test("rows come back most-voted first, and paging walks them", () => {
    const db = indexOf(OBSCURE_1901);
    const first = browseIndex(db, { year: 1901, limit: 3 });
    expect(first.rows.map((r) => r.votes)).toEqual([47, 46, 45]);
    const second = browseIndex(db, { year: 1901, limit: 3, offset: 3 });
    expect(second.rows.map((r) => r.votes)).toEqual([44, 43, 42]);
    expect(second.total).toBe(8);
  });
});
