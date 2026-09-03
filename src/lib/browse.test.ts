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
import { browseIndex, browseMembers, browseVoteFloor, decadeOf } from "./search";

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

/**
 * `browseMembers` -- the ids of a list, for counting how many of them we own.
 *
 * Every case asserts the SAME ANSWER as `browseIndex`, because that is the only property
 * worth having: a completion count computed over a different set from the grid it is
 * printed above would be a wrong number nobody could see was wrong.
 */
describe("browseMembers", () => {
  const RANKED = Array.from({ length: 12 }, (_, i) => ({
    tconst: `tt-m${i}`,
    year: 2000,
    kind: "movie",
    votes: 100_000,
    genres: i % 2 === 0 ? "Horror" : "Drama",
    rating: 5 + i * 0.25,
  }));

  test("it returns exactly the ids `browseIndex` returns, in the same order", () => {
    const db = indexOf(RANKED);
    for (const opts of [
      { kind: "movie", sort: "rank" as const, limit: 5 },
      { kind: "movie", sort: "rank" as const, limit: 5, offset: 5 },
      { genre: "Horror", kind: "movie", sort: "rank" as const, limit: 3 },
      { genre: "Horror", kind: "movie", sort: "rank" as const, limit: 3, genreVotes: true },
      // Not a list, but the function takes any browse and must not disagree on one either.
      { kind: "movie", limit: 4 },
    ]) {
      expect(browseMembers(db, opts)).toEqual(browseIndex(db, opts).rows.map((r) => r.tconst));
    }
  });

  test("it stops at the limit even when the list is longer", () => {
    const db = indexOf(RANKED);
    expect(browseMembers(db, { kind: "movie", sort: "rank", limit: 4 })).toHaveLength(4);
    // And returns what there IS when the slice is thinner than the limit, which is what
    // makes a completion denominator honest for a genre nobody has ranked much of.
    expect(browseMembers(db, { genre: "Horror", kind: "movie", sort: "rank", limit: 250 })).toHaveLength(6);
  });

  test("an unrated title is not a member, exactly as it is not a row", () => {
    const db = indexOf([
      { tconst: "tt-rated", year: 2000, kind: "movie", votes: 5_000, genres: "Drama", rating: 8 },
      { tconst: "tt-unrated", year: 2000, kind: "movie", votes: 0, genres: "Drama", rating: 0 },
    ]);
    expect(browseMembers(db, { kind: "movie", sort: "rank", limit: 250 })).toEqual(["tt-rated"]);
  });
});

/**
 * `title_genre.votes`, the denormalised copy that turned a 3.66s genre browse into a seek.
 *
 * The point of these is that the FAST path and the SLOW path are the same ANSWER. A
 * denormalised copy is only ever a correctness risk -- an optimisation that returns
 * different rows is not an optimisation -- so every case here runs the same query twice,
 * once through `g.votes` and once through `t.votes`, and asserts they agree.
 */
describe("the denormalised genre vote copy", () => {
  const MIXED = [
    { tconst: "tt-c1", year: 2001, kind: "movie", votes: 500_000, genres: "Comedy,Drama" },
    { tconst: "tt-c2", year: 2002, kind: "movie", votes: 200_000, genres: "Comedy" },
    { tconst: "tt-c3", year: 2003, kind: "tvSeries", votes: 300_000, genres: "Comedy" },
    { tconst: "tt-c4", year: 2004, kind: "movie", votes: 40, genres: "Comedy" },
    { tconst: "tt-d1", year: 2005, kind: "movie", votes: 900_000, genres: "Drama" },
  ];

  test("the explode copies each title's votes onto every one of its genre rows", () => {
    const db = indexOf(MIXED);
    const rows = db
      .query("select genre, votes from title_genre where title_rowid = 1 order by genre")
      .all() as { genre: string; votes: number }[];

    // tt-c1 is Comedy AND Drama, so its vote count lands on both rows.
    expect(rows).toEqual([
      { genre: "Comedy", votes: 500_000 },
      { genre: "Drama", votes: 500_000 },
    ]);
  });

  for (const opts of [
    { genre: "Comedy" },
    { genre: "Comedy", kind: "movie" },
    { genre: "Comedy", minVotes: 0 },
    { genre: "Comedy", kind: "tvSeries" },
    { genre: "Comedy", sort: "rank" as const },
    { genre: "Comedy", decade: 2000 },
  ]) {
    test(`${JSON.stringify(opts)} answers identically either way`, () => {
      const db = indexOf(MIXED);
      const fast = browseIndex(db, { ...opts, genreVotes: true });
      const slow = browseIndex(db, { ...opts, genreVotes: false });

      expect(fast.rows.map((r) => r.tconst)).toEqual(slow.rows.map((r) => r.tconst));
      expect(fast.total).toBe(slow.total);
      expect(fast.hiddenByFloor).toEqual(slow.hiddenByFloor);
    });
  }

  test("the fast path still honours the floor and still reports what it hid", () => {
    const db = indexOf(MIXED);
    // Only tt-c4 (40 votes) is under the 1000 floor, so the floor is doing real work here
    // rather than being a no-op the assertion could not tell apart.
    const floored = browseIndex(db, { genre: "Comedy", genreVotes: true });
    expect(floored.rows.map((r) => r.tconst)).toEqual(["tt-c1", "tt-c3", "tt-c2"]);
    expect(floored.total).toBe(3);

    const all = browseIndex(db, { genre: "Comedy", minVotes: 0, genreVotes: true });
    expect(all.total).toBe(4);
  });

  /*
    REGRESSION: the capability, not the column.

    `title_genre.votes` arrived on 2026-09-02, so for up to a day after the release ships
    the running server holds an index without it -- and a genre browse is the single most
    common list in the product. Naming `g.votes` unconditionally would throw `no such
    column` for that whole window. `genreVotes` defaults to false for exactly this, and this
    is the test that would have caught it.
  */
  test("an index built BEFORE the column still browses, on the slow path", () => {
    const db = indexOf(MIXED);
    db.run("alter table title_genre drop column votes");

    const out = browseIndex(db, { genre: "Comedy" });

    expect(out.rows.map((r) => r.tconst)).toEqual(["tt-c1", "tt-c3", "tt-c2"]);
    expect(out.total).toBe(3);
    // And the fast path is what would have broken it, which is why the default is false.
    expect(() => browseIndex(db, { genre: "Comedy", genreVotes: true })).toThrow();
  });

  /*
    The count drops the `title` join when every predicate is answerable from title_genre --
    182ms to 2.5ms on the live NAS index. It is safe because EXPLODE_GENRES writes one
    title_genre row per (title, genre) from an existing title row keyed on an INTEGER
    PRIMARY KEY, so the join can neither add nor remove a row. These pin that the totals
    agree with the joined form in every case, including the ones where the join must STAY.
  */
  test("dropping the count's join gives the same total, joined or not", () => {
    const db = indexOf(MIXED);
    for (const opts of [
      { genre: "Comedy" },
      { genre: "Comedy", kind: "movie" },
      { genre: "Comedy", minVotes: 0 },
      // year and decade are NOT denormalised, so these must keep the join -- and still agree.
      { genre: "Comedy", year: 2002 },
      { genre: "Comedy", decade: 2000 },
    ]) {
      const fast = browseIndex(db, { ...opts, genreVotes: true });
      const joined = browseIndex(db, { ...opts, genreVotes: false });
      expect(fast.total).toBe(joined.total);
      expect(fast.rows.map((r) => r.tconst)).toEqual(joined.rows.map((r) => r.tconst));
    }
  });

  test("a genre row orphaned from its title would be counted -- so nothing may orphan one", () => {
    // Not a wish: this asserts the exact invariant the dropped join relies on, so a future
    // edit that deletes from `title` without deleting from `title_genre` fails HERE, with
    // this comment, rather than as a browse whose total exceeds its rows by a few hundred.
    const db = indexOf(MIXED);
    const orphans = db
      .query(
        "select count(*) c from title_genre g left join title t on t.rowid_ = g.title_rowid where t.rowid_ is null",
      )
      .get() as { c: number };
    expect(orphans.c).toBe(0);
  });

  test("a browse with NO genre is unaffected -- there is no join to read the copy from", () => {
    const db = indexOf(MIXED);
    const withFlag = browseIndex(db, { kind: "movie", genreVotes: true });
    const without = browseIndex(db, { kind: "movie" });

    expect(withFlag.rows.map((r) => r.tconst)).toEqual(without.rows.map((r) => r.tconst));
    expect(withFlag.rows.map((r) => r.tconst)).toEqual(["tt-d1", "tt-c1", "tt-c2"]);
  });
});
