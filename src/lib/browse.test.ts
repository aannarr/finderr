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
import { EXPLODE_GENRES, SCHEMA } from "./index-builder";
import { browseIndex, browseVoteFloor, decadeOf } from "./search";

interface Fixture {
  tconst: string;
  year: number | null;
  kind: string;
  votes: number;
  genres: string;
}

const dir = mkdtempSync(join(tmpdir(), "finderr-browse-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A throwaway index with the real schema and the caller's rows in it. */
function indexOf(rows: Fixture[]): Database {
  const db = new Database(join(dir, `${crypto.randomUUID()}.db`), { create: true });
  db.run(SCHEMA);
  const insert = db.query(
    "insert into title (tconst, kind, title, year, votes, rating, genres) values (?, ?, ?, ?, ?, 7, ?)",
  );
  for (const r of rows) insert.run(r.tconst, r.kind, r.tconst, r.year, r.votes, r.genres);
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

  test("rows come back most-voted first, and paging walks them", () => {
    const db = indexOf(OBSCURE_1901);
    const first = browseIndex(db, { year: 1901, limit: 3 });
    expect(first.rows.map((r) => r.votes)).toEqual([47, 46, 45]);
    const second = browseIndex(db, { year: 1901, limit: 3, offset: 3 });
    expect(second.rows.map((r) => r.votes)).toEqual([44, 43, 42]);
    expect(second.total).toBe(8);
  });
});
