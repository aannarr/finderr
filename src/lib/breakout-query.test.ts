/**
 * The breakout SHELF QUERY, against a real index file rather than against the scorer.
 *
 * `breakout.test.ts` pins the maths. This pins the two things only SQLite can be wrong
 * about, and both of them fail SILENTLY -- with an empty shelf, which is also what a
 * correctly-empty shelf looks like:
 *
 * 1. **The stored cutoffs are actually read.** They live in `meta` and reach the query as
 *    subqueries, so a typo in a key name is not an error, it is `NULL`, and every comparison
 *    against `NULL` is false. The shelf would simply never render and nothing would say why.
 * 2. **A missing table degrades rather than throws.** `hasBreakout` is what an index built
 *    by yesterday's image meets, and that is the index MOST likely to be live during a
 *    rollout.
 */

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BREAKOUT_META, BREAKOUT_SHELF, NO_RANK_HEAD, rankHeadCutoff } from "./breakout";
import { loadConfig } from "./config";
import { applyRank, EXPLODE_GENRES, INDEXES, SCHEMA } from "./index-builder";
import { SearchEngine } from "./search";

const dir = mkdtempSync(join(tmpdir(), "finderr-breakout-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Row {
  tconst: string;
  votes: number;
  rating?: number;
  year?: number;
  country?: string;
  /** Score written straight into `title_breakout`; the scorer is tested elsewhere. */
  reach?: number;
  love?: number;
  local?: boolean;
  /** Omit the `title_breakout` row entirely -- an unscoreable title. */
  unscored?: boolean;
}

/**
 * An index with the real schema, the real index definitions, and hand-written scores.
 *
 * Scores are INSERTED rather than computed, deliberately: this file is about whether the
 * query finds the rows it should, so a fixture that had to satisfy `MIN_STRATUM` would need
 * thirty filler titles per case and would be testing the scorer a second time.
 */
function indexOf(
  rows: Row[],
  opts: { cutoffs?: boolean; table?: boolean; headCutoff?: number; drop?: string } = {},
): SearchEngine {
  const path = join(dir, `${crypto.randomUUID()}.db`);
  const db = new Database(path, { create: true });
  db.run(SCHEMA);
  const ins = db.query(
    "insert into title (tconst, kind, title, year, votes, rating, genres, country) values (?,?,?,?,?,?,?,?)",
  );
  const score = db.query(
    "insert into title_breakout (title_rowid, reach, love, local) values (?,?,?,?)",
  );
  for (const r of rows) {
    ins.run(r.tconst, "movie", r.tconst, r.year ?? 2015, r.votes, r.rating ?? 7.5, "Drama", r.country ?? "SE");
    const rowid = (db.query("select rowid_ from title where tconst = ?").get(r.tconst) as { rowid_: number }).rowid_;
    if (!r.unscored) score.run(rowid, r.reach ?? 5, r.love ?? 3, (r.local ?? true) ? 1 : 0);
  }
  applyRank(db, 10);
  db.run(EXPLODE_GENRES);
  for (const sql of INDEXES.breakout) db.run(sql);
  if (opts.cutoffs !== false) {
    const meta = db.query("insert or replace into meta (key, value) values (?, ?)");
    meta.run(BREAKOUT_META.reach, "2");
    meta.run(BREAKOUT_META.love, "1");
    // A fixture is far smaller than the head, so there is no head to exclude -- exactly what
    // `rankHeadCutoff` returns for a small corpus, and the branch a real index never takes.
    meta.run(BREAKOUT_META.rankHead, String(opts.headCutoff ?? NO_RANK_HEAD));
    if (opts.drop) db.run("delete from meta where key = ?", [opts.drop]);
  }
  if (opts.table === false) db.run("drop table title_breakout");
  db.close();
  return new SearchEngine(path, loadConfig());
}

/** In the vote window, recent enough, local, and comfortably over both cutoffs. */
const QUALIFIES: Row = { tconst: "tt0000001", votes: 50_000, reach: 6, love: 4 };

describe("the shelf query reads what the build stored", () => {
  test("a qualifying title is returned", () => {
    const engine = indexOf([QUALIFIES]);
    expect(engine.breakoutTitles(10).map((r) => r.tconst)).toEqual(["tt0000001"]);
  });

  // EACH cutoff is dropped on its own, and that is the point rather than thoroughness for
  // its own sake. A single "drop them all" case passes as long as ANY ONE of the three
  // subqueries fails closed -- so a bug that stopped consulting the reach cutoff would hide
  // behind the love one still working. Proved: mutating only the reach read left a
  // combined-case test fully green.
  test.each([
    ["all three", { cutoffs: false }],
    ["only reach", { drop: BREAKOUT_META.reach }],
    ["only love", { drop: BREAKOUT_META.love }],
    ["only the head cutoff", { drop: BREAKOUT_META.rankHead }],
  ])("a MISSING cutoff (%s) empties the shelf rather than admitting everything", (_which, opt) => {
    // A NULL from `meta` makes every comparison against it false. It must fail CLOSED, and
    // it must not throw.
    const engine = indexOf([QUALIFIES], opt);
    expect(engine.breakoutTitles(10)).toEqual([]);
  });

  test("an index built before the stage degrades to no shelf, and does not throw", () => {
    const engine = indexOf([QUALIFIES], { table: false });
    expect(engine.hasBreakout).toBe(false);
    expect(engine.breakoutTitles(10)).toEqual([]);
  });

  test("a scoreable index still reports the capability", () => {
    expect(indexOf([QUALIFIES]).hasBreakout).toBe(true);
  });
});

describe("every clause in the shelf's definition actually bites", () => {
  test.each([
    ["under the reach cutoff", { ...QUALIFIES, reach: 1 }],
    ["under the love cutoff", { ...QUALIFIES, love: 0.5 }],
    ["not a local market", { ...QUALIFIES, local: false }],
    ["too few votes", { ...QUALIFIES, votes: BREAKOUT_SHELF.minVotes - 1 }],
    ["too many votes", { ...QUALIFIES, votes: BREAKOUT_SHELF.maxVotes + 1 }],
    ["too old", { ...QUALIFIES, year: BREAKOUT_SHELF.fromYear - 1 }],
    ["never scored", { ...QUALIFIES, unscored: true }],
  ])("%s is excluded", (_why, row) => {
    expect(indexOf([row as Row]).breakoutTitles(10)).toEqual([]);
  });
});

describe("the head exclusion is a score, not a position", () => {
  // The bug this shape exists to prevent: `not in (top N by rank)` empties a corpus smaller
  // than N, because every title in it IS the top N. A fixture is always that corpus.
  test("a corpus smaller than the head excludes nothing", () => {
    expect(rankHeadCutoff([9, 8, 7], BREAKOUT_SHELF.rankHead)).toBe(NO_RANK_HEAD);
  });

  test("a corpus larger than the head cuts at the head's own score", () => {
    const ranksDesc = Array.from({ length: BREAKOUT_SHELF.rankHead + 10 }, (_, i) => 10 - i / 1000);
    expect(rankHeadCutoff(ranksDesc, BREAKOUT_SHELF.rankHead)).toBe(
      ranksDesc[BREAKOUT_SHELF.rankHead - 1],
    );
  });

  test("a title inside the head is excluded from the shelf", () => {
    const engine = indexOf([QUALIFIES], { headCutoff: 0 });
    expect(engine.breakoutTitles(10)).toEqual([]);
  });

  test("the sentinel survives a round trip through meta's TEXT column", () => {
    // `Infinity` would come back as 0 here and exclude everything. See NO_RANK_HEAD.
    const engine = indexOf([QUALIFIES], { headCutoff: NO_RANK_HEAD });
    expect(engine.breakoutTitles(10)).toHaveLength(1);
  });
});

describe("ordering and shape", () => {
  test("ordered by love descending, which is the merit axis and not the reach one", () => {
    // Reach is deliberately INVERTED against love here: a query that ordered by reach --
    // the Lupin failure -- would return these in the opposite order.
    const engine = indexOf([
      { tconst: "tt0000001", votes: 50_000, reach: 9, love: 2 },
      { tconst: "tt0000002", votes: 50_000, reach: 3, love: 8 },
      { tconst: "tt0000003", votes: 50_000, reach: 6, love: 5 },
    ]);
    expect(engine.breakoutTitles(10).map((r) => r.tconst)).toEqual([
      "tt0000002",
      "tt0000003",
      "tt0000001",
    ]);
  });

  test("the limit is honoured", () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      ...QUALIFIES,
      tconst: `tt000000${i}`,
      love: 4 + i,
    }));
    expect(indexOf(rows).breakoutTitles(2)).toHaveLength(2);
  });

  test("it returns a full TitleRow, so a card can draw it with no second query", () => {
    const [row] = indexOf([QUALIFIES]).breakoutTitles(1);
    expect(row).toMatchObject({ tconst: "tt0000001", kind: "movie", votes: 50_000, genres: "Drama" });
    expect(row).toHaveProperty("lang");
    expect(row).toHaveProperty("runtime");
  });
});
