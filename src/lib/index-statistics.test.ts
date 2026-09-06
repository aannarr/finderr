/**
 * The STATISTICS a finished build leaves, exercised through the real builder.
 *
 * `sqlite_stat1` is the only thing the query planner has to choose an index with, and it is
 * written by one statement at the end of `buildIndex`. That statement used to be
 * `pragma optimize`, which does not scan: it caps analysis at 2000 rows per index and
 * extrapolates, so on the real 1.28M-row index `ix_kind` claimed every `kind` matched 2,001
 * rows against a true 319,168. Nothing about that is visible in a plan test -- the fixtures
 * there build their own statistics -- and nothing about it is visible in a wall-clock
 * benchmark either, until the day it picks the wrong index.
 *
 * So this file asserts the PROPERTY rather than the statement: the numbers in `sqlite_stat1`
 * are the true ones for the rows on disk. That needs a fixture bigger than the cap, which is
 * why 3,000 titles are generated here rather than the handful the stage tests use.
 */

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dumpDir, indexConfig } from "../test/index-dumps";
import { buildIndex } from "./index-builder";

const root = mkdtempSync(join(tmpdir(), "finderr-stats-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/**
 * More titles than `pragma optimize` will ever look at, in two kinds.
 *
 * 3,000 is chosen against the 2,000-row cap: below it the two statements agree and this file
 * would pass either way. Two kinds in equal measure makes the expected answer arithmetic --
 * 1,500 rows per `kind` -- rather than something to be read out of whatever the build did.
 */
const TITLES = 3_000;
const KINDS = ["movie", "tvSeries"] as const;

/** basics row: tconst, type, primary, original, isAdult, start, end, runtime, genres */
const basics = (i: number): string[] => [
  `tt${String(i).padStart(7, "0")}`,
  KINDS[i % KINDS.length] as string,
  `Title ${i}`,
  `Title ${i}`,
  "0",
  String(1950 + (i % 70)),
  "\\N",
  "100",
  "Drama",
];

async function buildFixture(): Promise<Database> {
  const rows = Array.from({ length: TITLES }, (_, i) => i);
  const dir = dumpDir(root, {
    // Every title is rated, and well above any floor: this file is about statistics, so a
    // title dropped for being obscure would only make the arithmetic below harder to read.
    ratings: rows.map((i) => [`tt${String(i).padStart(7, "0")}`, "7.5", "5000"]),
    basics: rows.map(basics),
  });
  const dest = join(root, "titles.db");
  await buildIndex(indexConfig({ titleTypes: [...KINDS] }), dir, dest, () => {});
  return new Database(dest, { readonly: true });
}

const db = await buildFixture();
afterAll(() => db.close());

/** The `stat` string SQLite wrote for one index, split into its numbers. */
function statOf(index: string): number[] {
  const row = db.query("select stat from sqlite_stat1 where idx = ?").get(index) as
    | { stat: string }
    | undefined;
  if (!row) throw new Error(`no sqlite_stat1 row for ${index} -- the build wrote no statistics`);
  return row.stat.split(" ").map(Number);
}

describe("a finished build leaves statistics that were SCANNED, not extrapolated", () => {
  test("the rows-per-kind estimate is the real one, not the 2000-row sample's", () => {
    // `ix_kind` is `(kind, votes desc)`, so the second number is "rows per distinct kind".
    // With 3,000 titles evenly split that is 1,500. `pragma optimize` answers 1,001 here --
    // it reads 2,000 rows and divides by the two values it saw in them.
    const [rows, perKind] = statOf("ix_kind");
    expect(rows).toBe(TITLES);
    expect(perKind).toBe(TITLES / KINDS.length);
  });

  test("every index over a table with rows in it carries statistics", () => {
    // The other half of what `pragma optimize` did not do: it only analyses tables whose
    // indexes THIS CONNECTION used, so coverage was a side effect of what the build read.
    //
    // An EMPTY table is excluded because `analyze` deliberately writes no row for one, and
    // this fixture has no cast, people or episodes -- the stages that fill those tables are
    // tested in `cast-build.test.ts` and `episode-index.test.ts`.
    const indexes = db
      .query("select name, tbl_name from sqlite_master where type = 'index' and sql is not null")
      .all() as { name: string; tbl_name: string }[];
    const analysed = new Set(
      (db.query("select idx from sqlite_stat1 where idx is not null").all() as { idx: string }[]).map(
        (r) => r.idx,
      ),
    );
    const populated = indexes.filter(
      (i) => (db.query(`select count(*) c from ${i.tbl_name}`).get() as { c: number }).c > 0,
    );
    expect(populated.length).toBeGreaterThan(0);
    expect(populated.filter((i) => !analysed.has(i.name)).map((i) => i.name)).toEqual([]);
  });
});
