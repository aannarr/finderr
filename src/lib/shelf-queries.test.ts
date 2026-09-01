/**
 * The three discovery-shelf queries, and the plan they are REQUIRED to run under.
 *
 * ## What this defends
 *
 * `/api/discover` took **2.8 seconds** on the live index, measured 2026-09-01, and 2.57s of
 * that was these three methods. Every one of them ordered by `rating * ln(votes)` computed
 * per row, which no index can serve, so each was a scan plus `USE TEMP B-TREE FOR ORDER BY`:
 *
 * ```
 *    933.5ms  topRatedInGenre Drama        162.0ms  topRated movie
 *    577.9ms  topRatedInGenre Comedy       108.8ms  topRated series
 *    208.5ms  topRatedInGenre Crime        161.1ms  newThisDecade
 * ```
 *
 * The `rank` column and the two indexes over it were built for exactly these lists -- the
 * schema comment in `index-builder.ts` says so in as many words -- and only the Top 250
 * shelf was using them. On screen it is three seconds of skeleton on the front page.
 *
 * ## Why the assertion is on the PLAN and on the RECORDED SQL
 *
 * A timing assertion in CI is a flake generator, and a plan asserted against SQL retyped
 * here is a copy that drifts away from the real query the moment somebody edits one and not
 * the other -- which is the whole failure mode, since the slow version and the fast version
 * return the SAME ROWS in a different order and nothing else in the suite can tell them
 * apart. So the tests below RECORD what the engine actually issued and explain that, which
 * means an edit reintroducing a sort fails here without anybody having to remember to update
 * a string.
 */

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";
import { buildRankLayer, EXPLODE_GENRES, SCHEMA } from "./index-builder";
import { SearchEngine } from "./search";

const dir = mkdtempSync(join(tmpdir(), "finderr-shelves-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const cfg = { ...loadConfig(), index: { ...loadConfig().index, rankPriorVotes: 100 } };

/** Every kind the real index holds, because the seek is per-kind and a missing one is a gap. */
const KINDS = ["movie", "tvSeries", "tvMovie", "tvMiniSeries"];

/**
 * A fixture shaped like the real index: four kinds, two genres, a spread of years.
 *
 * Ranked with `buildRankLayer` rather than by hand, so `title_genre.rank` and the two
 * indexes are exactly what a real build produces.
 */
function fixture(opts: { rank?: boolean } = {}): string {
  const path = join(dir, `${crypto.randomUUID()}.db`);
  const db = new Database(path, { create: true });
  db.run(SCHEMA);
  const insert = db.query(
    "insert into title (tconst, kind, title, year, votes, rating, genres) values (?, ?, ?, ?, ?, ?, ?)",
  );
  let n = 0;
  for (const kind of KINDS) {
    for (let i = 0; i < 12; i++) {
      n++;
      insert.run(
        `tt-${kind}-${i}`,
        kind,
        `${kind} ${i}`,
        // Half in the current decade, half well before it, so `newThisDecade` has both to
        // choose between rather than trivially matching everything.
        i % 2 === 0 ? new Date().getFullYear() : 1994,
        10_000 + i * 1_000,
        5 + (i % 6),
        i % 3 === 0 ? "Drama" : "Drama,Comedy",
      );
    }
  }
  expect(n).toBe(KINDS.length * 12);
  // `buildRankLayer` explodes the genres itself. Without it the genre table still has to be
  // filled, or a "no rank column" fixture would be testing an EMPTY `title_genre` and the
  // genre shelf would come back empty for a reason that has nothing to do with rank.
  if (opts.rank === false) db.run(EXPLODE_GENRES);
  else buildRankLayer(db, cfg);
  db.close();
  return path;
}

/**
 * Run `fn` and hand back every SQL string the engine issued while it ran.
 *
 * Reaching past `private` on purpose: the point is to assert on the query the engine REALLY
 * sent, and any less direct route would be asserting on a copy.
 */
function recordSql(engine: SearchEngine, fn: () => unknown): string[] {
  const db = (engine as unknown as { db: Database }).db;
  const real = db.query.bind(db);
  const seen: string[] = [];
  (db as unknown as { query: Database["query"] }).query = ((sql: string) => {
    seen.push(sql);
    return real(sql);
  }) as Database["query"];
  try {
    fn();
  } finally {
    (db as unknown as { query: Database["query"] }).query = real;
  }
  return seen;
}

/** The plan for one statement, as a single line. */
function planOf(path: string, sql: string): string {
  const db = new Database(path, { readonly: true });
  try {
    // The arguments never change a plan's SHAPE, and binding real ones here would mean
    // knowing each statement's arity. NULLs bind fine for `explain query plan`.
    const arity = (sql.match(/\?/g) ?? []).length;
    const rows = db.query(`explain query plan ${sql}`).all(...(Array(arity).fill(null) as never[])) as {
      detail: string;
    }[];
    return rows.map((r) => r.detail).join(" | ");
  } finally {
    db.close();
  }
}

const ordering = (sql: string) => /order\s+by/i.test(sql);

describe("the discovery shelves are index seeks, never sorts", () => {
  const path = fixture();

  for (const [name, call] of [
    ["topRated with a kind pinned", (e: SearchEngine) => e.topRated({ kind: "movie", limit: 30 })],
    ["topRated across every kind", (e: SearchEngine) => e.topRated({ limit: 30 })],
    ["topRatedInGenre", (e: SearchEngine) => e.topRatedInGenre("Drama", { limit: 30 })],
    ["newThisDecade", (e: SearchEngine) => e.newThisDecade({ limit: 30 })],
  ] as const) {
    test(`${name} costs no temp b-tree`, () => {
      const engine = new SearchEngine(path, cfg);
      try {
        expect(engine.hasRank).toBe(true);
        const sql = recordSql(engine, () => call(engine)).filter(ordering);
        expect(sql.length).toBeGreaterThan(0);
        for (const one of sql) {
          const plan = planOf(path, one);
          // The claim, and the only thing that separates 0.2ms from 933ms.
          expect(plan).not.toContain("TEMP B-TREE");
          expect(plan).toMatch(/ix_rank|ix_tg_rank/);
        }
      } finally {
        engine.close();
      }
    });
  }

  test("a shelf with no kind pinned seeks EVERY kind, so nothing is silently dropped", () => {
    // The per-kind seek is what makes the index usable, and its failure mode is quiet: skip
    // a kind and that kind simply never appears on the shelf, in the right order, with the
    // right count. Only a test that knows how many kinds exist can catch it.
    const engine = new SearchEngine(path, cfg);
    try {
      const kinds = new Set(engine.topRated({ limit: 200 }).map((r) => r.kind));
      expect([...kinds].sort()).toEqual([...KINDS].sort());
    } finally {
      engine.close();
    }
  });

  test("rows come back in rank order, best first", () => {
    const engine = new SearchEngine(path, cfg);
    try {
      const db = new Database(path, { readonly: true });
      const rankOf = new Map(
        (db.query("select tconst, rank from title").all() as { tconst: string; rank: number }[]).map((r) => [
          r.tconst,
          r.rank,
        ]),
      );
      db.close();
      for (const rows of [
        engine.topRated({ limit: 20 }),
        engine.topRatedInGenre("Drama", { limit: 20 }),
        engine.newThisDecade({ limit: 20 }),
      ]) {
        expect(rows.length).toBeGreaterThan(1);
        const ranks = rows.map((r) => rankOf.get(r.tconst) ?? Number.NaN);
        expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
      }
    } finally {
      engine.close();
    }
  });

  test("excludeTconsts still removes what you own", () => {
    const engine = new SearchEngine(path, cfg);
    try {
      const owned = new Set(engine.topRated({ limit: 5 }).map((r) => r.tconst));
      expect(owned.size).toBe(5);
      const rest = engine.topRated({ limit: 20, excludeTconsts: owned });
      expect(rest.some((r) => owned.has(r.tconst))).toBe(false);
    } finally {
      engine.close();
    }
  });
});

describe("an index with no rank column still fills its shelves", () => {
  /*
    The index a deploy meets is the one the LAST build wrote, so `hasRank` is false for up to
    a day after a rank-carrying release ships. These three shelves must keep serving over that
    window on the old query -- the vote and rating floors live on down there, because with no
    rank column there is nothing else to order by.
  */
  const path = fixture({ rank: false });

  test("hasRank is false and every shelf still returns rows", () => {
    const db = new Database(path);
    db.run("alter table title drop column rank");
    db.run("alter table title_genre drop column rank");
    db.close();

    const engine = new SearchEngine(path, cfg);
    try {
      expect(engine.hasRank).toBe(false);
      expect(engine.topRated({ minVotes: 0, limit: 10 }).length).toBeGreaterThan(0);
      expect(engine.topRatedInGenre("Drama", { minVotes: 0, limit: 10 }).length).toBeGreaterThan(0);
      expect(engine.newThisDecade({ limit: 10 }).length).toBeGreaterThan(0);
    } finally {
      engine.close();
    }
  });
});
