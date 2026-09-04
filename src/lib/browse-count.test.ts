/**
 * The precomputed total is the SAME NUMBER the live count would give.
 *
 * `browse_count` exists to stop a browse paying 137 ms to count what it is about to show
 * forty rows of. That is only a win if the stored number is exactly right: a total is printed
 * to the reader as a fact -- "1,132 titles", "you own 178 of 250" -- so a total that is merely
 * close is a lie rendered in a confident font, and it is worse than the slow query it
 * replaced.
 *
 * > [!IMPORTANT] These tests assert EQUALITY WITH THE LIVE COUNT, never a literal number
 * > A test that pinned `expect(total).toBe(47)` would pass for a stored count and a live count
 * > that agreed with each other and disagreed with reality, and it would have to be rewritten
 * > every time the fixture moved. Comparing the two paths against each other is what actually
 * > catches the failure mode -- and it is the failure mode that nearly shipped here, so it is
 * > worth naming.
 *
 * > [!CAUTION] `genre = ''` is the ANY-GENRE row, not "titles with no genre"
 * > The first prototype of this table wrote one row per (kind, genre, year) with a `left
 * > join`, so a title with three genres had three rows and a title with none had one row under
 * > `''`. Summing across genres therefore double-counted, and summing `genre = ''` counted
 * > only the genre-less titles -- an unfiltered total that was wildly wrong in both
 * > directions depending on which way you asked. The build now writes a SECOND pass over
 * > `title` alone for the `''` grain. `an unfiltered count is not the sum of the genres` below
 * > is the test that would have caught it, and it fails loudly against that first shape.
 */

import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allIndexes,
  applyRank,
  BROWSE_VOTE_FLOOR,
  buildBrowseCounts,
  EXPLODE_GENRES,
  SCHEMA,
} from "./index-builder";
import { type BrowseOptions, browseIndex } from "./search";

const dir = mkdtempSync(join(tmpdir(), "finderr-bcount-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const GENRES = ["Drama", "Comedy", "Horror", "Action", "Drama,Comedy", "Drama,Horror,Action", ""];
const KINDS = ["movie", "tvSeries", "tvMiniSeries", "tvMovie"];

/**
 * A fixture with MULTI-GENRE titles, genre-less titles and null years in it.
 *
 * Every one of those is a case the grain has to get right, and a fixture of single-genre
 * titles would pass while the double-counting bug was live. `Drama,Horror,Action` is the row
 * that breaks a naive sum; `""` is the row that breaks a naive any-genre grain; a null year
 * is the row that has to be counted in a total and excluded from every decade.
 */
function fixture(): Database {
  const db = new Database(join(dir, `${crypto.randomUUID()}.db`), { create: true });
  db.run(SCHEMA);
  const ins = db.query(
    "insert into title (tconst, kind, title, year, votes, rating, genres) values (?, ?, ?, ?, ?, ?, ?)",
  );
  db.run("begin");
  for (let i = 0; i < 1_500; i++) {
    ins.run(
      `tt${String(i).padStart(8, "0")}`,
      KINDS[i % KINDS.length] as string,
      `title ${i}`,
      // Every 37th title has no year at all.
      i % 37 === 0 ? null : 1900 + (i % 126),
      // Straddles BROWSE_VOTE_FLOOR in both directions, so `n` and `n_floor` differ.
      (i * 7919) % 5_000,
      5 + ((i * 13) % 50) / 10,
      GENRES[i % GENRES.length] as string,
    );
  }
  db.run("commit");
  applyRank(db, 25_000);
  db.run(EXPLODE_GENRES);
  for (const sql of allIndexes()) db.run(sql);
  buildBrowseCounts(db);
  return db;
}

const db = fixture();
afterAll(() => db.close());

/** The same browse, both ways. The stored path is the one under test. */
function bothWays(opts: BrowseOptions): { stored: number; live: number } {
  return {
    stored: browseIndex(db, { ...opts, browseCounts: true }).total,
    live: browseIndex(db, { ...opts, browseCounts: false }).total,
  };
}

const cases: [string, BrowseOptions][] = [
  ["no filters at all", {}],
  ["one kind", { kind: "movie" }],
  ["one kind, series", { kind: "tvSeries" }],
  ["one genre", { genre: "Drama" }],
  // Drama appears alone AND inside two multi-genre strings, so this is the double-count case.
  ["a genre that is also part of multi-genre titles", { genre: "Comedy" }],
  ["genre and kind together", { genre: "Drama", kind: "movie" }],
  ["one year", { year: 1950 }],
  ["a year nothing is in", { year: 1801 }],
  ["a decade", { decade: 1990 }],
  ["a decade and a genre", { decade: 1990, genre: "Drama" }],
  ["a decade, a genre and a kind", { decade: 1990, genre: "Drama", kind: "movie" }],
  ["ranked, no filters", { sort: "rank" }],
  ["ranked in a genre", { genre: "Drama", sort: "rank" }],
  ["ranked in a genre and kind", { genre: "Drama", kind: "movie", sort: "rank" }],
  ["ranked in a decade", { decade: 2000, sort: "rank" }],
  ["the floor explicitly dropped", { kind: "movie", minVotes: 0 }],
  ["the floor explicitly set to its own value", { kind: "movie", minVotes: BROWSE_VOTE_FLOOR }],
];

for (const [label, opts] of cases) {
  test(`${label}: the stored total equals the live one`, () => {
    const { stored, live } = bothWays(opts);
    expect(stored, `${label}: browse_count disagrees with a live count over the same rows`).toBe(live);
  });
}

test("an unfiltered count is not the sum of the genres", () => {
  // The bug this pins: a title with three genres has three `title_genre` rows, so an
  // any-genre total built by summing them would exceed the corpus. It must come from a
  // separate pass over `title`.
  const total = browseIndex(db, { browseCounts: true, minVotes: 0 }).total;
  const genreSum = ["Drama", "Comedy", "Horror", "Action"]
    .map((genre) => browseIndex(db, { genre, browseCounts: true, minVotes: 0 }).total)
    .reduce((a, b) => a + b, 0);
  expect(total).toBe(1_500);
  expect(genreSum).toBeGreaterThan(total);
});

test("a title with no year is counted in the total and in no decade", () => {
  const all = browseIndex(db, { browseCounts: true, minVotes: 0 }).total;
  let decades = 0;
  for (let d = 1900; d <= 2020; d += 10) {
    decades += browseIndex(db, { decade: d, browseCounts: true, minVotes: 0 }).total;
  }
  // 1,500 titles, every 37th with a null year -- so the decades cannot add up to the whole
  // corpus, and the difference is exactly the titles that have no year to file under.
  const undated = Math.floor(1_499 / 37) + 1;
  expect(all - decades).toBe(undated);
});

test("a custom minVotes falls back to the live count rather than guessing", () => {
  // 2,500 is a floor the table was not built at. The grain cannot express it, so the stored
  // path must decline rather than return the nearest column it has.
  const { stored, live } = bothWays({ kind: "movie", minVotes: 2_500 });
  expect(stored).toBe(live);
});

test("an index with no browse_count still answers every total", () => {
  // The upgrade path: `hasBrowseCounts` is false against a file built before the stage, and
  // every number is still right down the live path. Same rule as `hasRank` and `hasIds`.
  const old = new Database(join(dir, `${crypto.randomUUID()}.db`), { create: true });
  old.run(SCHEMA);
  old.run(
    "insert into title (tconst, kind, title, year, votes, rating, genres) values ('tt1','movie','a',1994,5000,8,'Drama')",
  );
  applyRank(old, 25_000);
  old.run(EXPLODE_GENRES);
  old.run("drop table browse_count");
  expect(browseIndex(old, { genre: "Drama", browseCounts: false }).total).toBe(1);
  old.close();
});
