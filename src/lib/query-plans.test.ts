/**
 * The render path seeks; it does not sort the corpus.
 *
 * Every query behind a shelf, a grid or a top list is supposed to READ ROWS IN THE ORDER
 * AN INDEX ALREADY HOLDS THEM and stop at `limit`. When one instead collects every
 * matching row and sorts it, the cost stops being a function of the page size and becomes
 * a function of the corpus -- which is invisible on a fixture, invisible in a unit test,
 * and 820 ms on the real index. SQLite says which of the two it is doing, in one word, and
 * that word is what these tests read.
 *
 * > [!IMPORTANT] Assert the PLAN, never the milliseconds
 * > A wall-clock assertion is machine-dependent, load-dependent and worthless in CI: it
 * > either has a threshold so loose it never fires or so tight it fires on a busy runner.
 * > `USE TEMP B-TREE FOR ORDER BY` is neither -- it is a categorical statement by the
 * > query planner that it could not serve the sort from an index, and it is the exact
 * > property that separates a 0.5 ms page from an 820 ms one.
 *
 * > [!IMPORTANT] THE FIXTURE MUST CARRY THE REAL INDEXES, and that was learned the hard way
 * > The first version of this file built its fixture from `SCHEMA` + `EXPLODE_GENRES` alone,
 * > exactly as `browse.test.ts` does, and every query came back `SCAN` at n=5,000, 20,000,
 * > 60,000 and 150,000 rows, with and without `analyze` -- because that fixture **has no
 * > indexes on it at all**. It was red for a reason that had nothing to do with the defect.
 * >
 * > That is why `INDEXES` is exported from the builder: the fixture applies the same DDL the
 * > real build does, so the planner is choosing between the same options in both places. A
 * > hand-written list of indexes here would be a second owner and would drift the first time
 * > somebody tuned a column order -- which is precisely the change these tests exist to
 * > guard.
 *
 * The SQL is not written out here either. It is captured from the real `browseIndex` through
 * a recording database, so there is no second copy of the query to drift from the one that
 * ships.
 */

import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allIndexes, applyRank, EXPLODE_GENRES, SCHEMA } from "./index-builder";
import { type BrowseOptions, browseIndex, browseMembers } from "./search";

const dir = mkdtempSync(join(tmpdir(), "finderr-plans-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const GENRES = ["Drama", "Comedy", "Horror", "Action"];
const KINDS = ["movie", "tvSeries", "tvMiniSeries", "tvMovie"];

/**
 * An index with the real schema and enough spread to make every filter selective.
 *
 * Built once and shared: the planner's decision is a property of the schema and the
 * statement, not of which rows are in there, so re-seeding per test would only make the
 * file slower to no end.
 */
function fixture(n = 1_000): Database {
  const db = new Database(join(dir, `${crypto.randomUUID()}.db`), { create: true });
  db.run(SCHEMA);
  const ins = db.query(
    "insert into title (tconst, kind, title, year, votes, rating, genres) values (?, ?, ?, ?, ?, ?, ?)",
  );
  db.run("begin");
  for (let i = 0; i < n; i++) {
    ins.run(
      `tt${String(i).padStart(8, "0")}`,
      KINDS[i % KINDS.length] as string,
      `title ${i}`,
      1900 + (i % 126),
      // Coprime stride, so votes do not correlate with year, kind or genre -- a fixture
      // where they did could let one index accidentally serve every sort.
      (i * 7919) % 500_000,
      5 + ((i * 13) % 50) / 10,
      GENRES[i % GENRES.length] as string,
    );
  }
  db.run("commit");
  // The builder's order, and it is not interchangeable -- the explode copies `rank` and
  // `kind` onto `title_genre`, so ranking after it writes a table of NULL ranks.
  applyRank(db, 25_000);
  db.run(EXPLODE_GENRES);
  /*
    The real DDL, from the real builder.

    `allIndexes()` includes the cast and episode indexes, whose tables `SCHEMA` creates but
    this fixture never fills. That is fine and deliberate: an index over an empty table costs
    nothing to create and keeps this loop honest -- it applies EVERY index the build applies,
    so an index added to `INDEXES` is automatically present here rather than needing somebody
    to remember this file.
  */
  for (const sql of allIndexes()) db.run(sql);
  // The planner consults `sqlite_stat1` when it exists, and the real index has it -- the build
  // ends on this same statement. Without it here the fixture would be choosing indexes on
  // heuristics while production chooses on statistics, which is the other way this file
  // could quietly stop modelling the thing it claims to model.
  db.run("analyze");
  return db;
}

const db = fixture();
afterAll(() => db.close());

/**
 * Every statement the callee runs, captured from the real code rather than restated.
 *
 * `browseIndex` takes its database as an argument, which is what makes this possible: the
 * recorder delegates every call and keeps the SQL, so what gets explained below is the
 * exact string that ships. A hand-written copy in this file would pass for as long as
 * somebody remembered to update it, which is the failure mode the capture removes.
 */
function statementsOf(run: (db: Database) => unknown): string[] {
  const seen: string[] = [];
  /*
    A plain object holding BOUND methods, deliberately NOT a `new Proxy(db, ...)`.

    bun:sqlite's `Database` uses real JS private fields, and a private field is resolved on
    the RECEIVER -- which for a proxied method call is the proxy rather than the target. Any
    method the proxy did not explicitly intercept throws `Cannot access invalid private
    field` the moment it runs. A proxy happens to work for as long as the callee touches
    nothing but `query`, which makes it a trap rather than a technique: it breaks on the
    first `prepare`, `run` or `transaction` somebody adds to `browseIndex`, and the failure
    reads as a bun bug rather than as a test-harness bug. Measured while writing this file.
  */
  const recorder = {
    query: (sql: string) => {
      seen.push(sql);
      return db.query(sql);
    },
    prepare: (sql: string) => {
      seen.push(sql);
      return db.prepare(sql);
    },
    run: (sql: string, ...a: unknown[]) => db.run(sql, ...(a as never[])),
  } as unknown as Database;
  run(recorder);
  return seen;
}

/** The planner's own words for every statement a call ran, flattened. */
function plansOf(run: (db: Database) => unknown, args: unknown[]): string[] {
  return statementsOf(run).map((sql) => {
    // `explain query plan` needs the same parameter count; the VALUES never change a plan.
    const bound = args.slice(0, (sql.match(/\?/g) ?? []).length);
    return (db.query(`explain query plan ${sql}`).all(...(bound as never[])) as { detail: string }[])
      .map((p) => p.detail)
      .join(" | ");
  });
}

/**
 * The assertion, in one place.
 *
 * Named rather than inlined because the message is the whole value of the test: a bare
 * `expect(plan).not.toContain(...)` failing in CI tells a reader nothing about why a temp
 * b-tree is a defect, and this is a test somebody will meet for the first time when it goes
 * red.
 */
function expectSeek(label: string, plans: string[]): void {
  // Asserted rather than skipped: a scenario that ran no statement would otherwise pass by
  // checking nothing, which is how a test like this rots into decoration.
  expect(plans.length, `${label}: no statements were captured -- the recorder is not wired`).toBeGreaterThan(
    0,
  );
  const sorted = plans.filter((p) => p.includes(SORT));
  expect(
    sorted,
    `${label}: the planner sorted the whole matching set instead of reading an index in order.\n` +
      sorted.map((p) => `  plan: ${p}`).join("\n") +
      `\n  This is the difference between a page that costs its own size and one that costs\n` +
      `  the corpus. Fix the index or pin the leading columns; do not relax this test.`,
  ).toEqual([]);
}

/** The planner's own words for "I could not serve this sort from an index". */
const SORT = "USE TEMP B-TREE FOR ORDER BY";

const cases: [string, BrowseOptions, unknown[]][] = [
  // The one that was 820 ms on the real index: rank ordered, kind left free, so
  // ix_tg_rank(genre, kind, rank desc) cannot be read in order.
  ["ranked browse in a genre", { genre: "Drama", sort: "rank", limit: 40 }, ["Drama", 40, 0]],
  [
    "ranked browse in a genre, deep page",
    { genre: "Drama", sort: "rank", limit: 40, offset: 200 },
    ["Drama", 40, 200],
  ],
  // 100-275 ms: a range on the leading column, so (year, votes desc) is not globally ordered.
  ["decade browse", { decade: 1990, limit: 40 }, [1990, 1999, 40, 0]],
  ["decade browse in a genre", { decade: 1990, genre: "Drama", limit: 40 }, ["Drama", 1990, 1999, 40, 0]],
  // These already seek on the real index; they are here so a fix to the two above cannot
  // quietly regress the paths that were fine.
  ["broad kind browse", { kind: "movie", limit: 40 }, ["movie", 1000, 40, 0]],
  ["single year browse", { year: 1995, limit: 40 }, [1995, 40, 0]],
  [
    "ranked browse, kind pinned",
    { genre: "Drama", kind: "movie", sort: "rank", limit: 40 },
    ["Drama", "movie", 40, 0],
  ],
];

for (const [label, opts, args] of cases) {
  test(`${label} reads an index in order rather than sorting the corpus`, () => {
    expectSeek(
      label,
      plansOf((d) => browseIndex(d, opts), args),
    );
  });
}

test("browseMembers seeks too -- every computed top list is this call", () => {
  // `/lists` asks for the head of twenty-six lists at once, so a sort here is paid
  // twenty-six times on one render.
  expectSeek(
    "browseMembers",
    plansOf(
      (d) => browseMembers(d, { genre: "Drama", sort: "rank", limit: 250, rankIndexes: true }),
      ["Drama", 250, 0],
    ),
  );
});

/*
  THE TEST THAT PROVES THE OTHER TESTS HAVE TEETH.

  Everything above asserts that a sort does NOT appear. That family of assertion has a
  well-known failure: it also passes when the fixture is incapable of producing the thing it
  is looking for -- a mis-seeded table, a planner that never had the choice, a recorder that
  captured nothing. The suite would stay green while guarding nothing.

  So this rebuilds the fixture with the column order `ix_tg_rank` had BEFORE 2026-09-05 and
  asserts the temp b-tree comes BACK. It is the same defect, on the same rows, through the
  same code path -- which is what makes the green above mean "the fix works" rather than
  "the question was never asked".

  If this test ever fails, the ones above are worthless until it is fixed: it means the
  fixture can no longer express the bug, not that the bug is extra-fixed.
*/
test("the fixture can still express the defect -- the old column order sorts", () => {
  const old = new Database(join(dir, `${crypto.randomUUID()}.db`), { create: true });
  old.run(SCHEMA);
  const ins = old.query(
    "insert into title (tconst, kind, title, year, votes, rating, genres) values (?, ?, ?, ?, ?, ?, ?)",
  );
  old.run("begin");
  for (let i = 0; i < 1_000; i++) {
    ins.run(
      `tt${String(i).padStart(8, "0")}`,
      KINDS[i % KINDS.length] as string,
      `title ${i}`,
      1900 + (i % 126),
      (i * 7919) % 500_000,
      5 + ((i * 13) % 50) / 10,
      GENRES[i % GENRES.length] as string,
    );
  }
  old.run("commit");
  applyRank(old, 25_000);
  old.run(EXPLODE_GENRES);
  for (const sql of allIndexes()) {
    // Everything the real build makes, EXCEPT with ix_tg_rank back in its old shape.
    old.run(
      sql.includes("ix_tg_rank") ? "create index ix_tg_rank on title_genre(genre, kind, rank desc)" : sql,
    );
  }
  old.run("analyze");

  const sql = `select t.tconst from title t join title_genre g on g.title_rowid = t.rowid_
    where g.genre = ? and g.rank is not null order by g.rank desc limit ? offset ?`;
  const plan = (old.query(`explain query plan ${sql}`).all("Drama", 40, 0) as { detail: string }[])
    .map((p) => p.detail)
    .join(" | ");
  old.close();

  expect(
    plan,
    "The old (genre, kind, rank desc) order no longer produces a sort on this fixture, so the\n" +
      "tests above are not proving anything. Do not delete this test -- fix the fixture until\n" +
      "it can express the defect again.",
  ).toContain(SORT);
});

test("the recorder captures the statements it claims to", () => {
  // Guards the test itself: a `browseIndex` that stopped taking its database as an argument,
  // or a Proxy that stopped intercepting, would make every assertion above vacuously pass.
  const seen = statementsOf((d) => browseIndex(d, { genre: "Drama", sort: "rank", limit: 40 }));
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.some((s) => s.includes("title_genre"))).toBe(true);
});

/*
  THE RANKED DECADE -- asserted as a CONTRACT, not as a plan, and the distinction is honest.

  This shape shipped SPLIT, exactly like the votes decade, and that was a regression: `/lists`
  draws seven "Best of the <decade>s" lists at 250 rows and they cost **1,233 ms of members**
  on the deployment NAS, `decade-2010` alone at 372 ms, against a claim of 36 ms for the whole
  payload in `src/server/lists.ts`.

  The two sorts want opposite things. A VOTES decade has no index that can order across a year
  RANGE, so ten pinned-year seeks beat it. A RANK decade already has one -- `ix_rank(kind, rank
  desc)` reads rows in the output order and stops at `limit` -- so splitting throws that
  ordering away and pays ten sorts instead of one walk. Left to itself the planner then picks
  `ix_year` for the range and sorts anyway.

  Measured on the real 1.27M-row index, "Best of the 2010s" at 250 rows:

    split into ten years        372.53 ms
    range, planner's choice     469.01 ms   SEARCH ix_year + USE TEMP B-TREE
    range, indexed by ix_rank     1.25 ms   SEARCH ix_rank (kind=? AND rank>?)
    no kind, ix_rank_all          0.80 ms

  > [!IMPORTANT] These assert the SQL, not the plan, because a small fixture cannot model this
  > Every other case in this file asserts `USE TEMP B-TREE` is absent, which a 1,000-row
  > fixture reproduces faithfully. This one it does NOT: at that size the planner's cost model
  > reaches a different conclusion than it does at 1.27M rows, so a plan assertion here would
  > be red against code that is correct in production -- which is worse than no test, because
  > the fix for it is to weaken the test.
  >
  > What IS a property of the code rather than of the planner: that a ranked decade issues ONE
  > row query rather than ten, and that it names the index. Those are the two halves of the
  > fix, both would have caught the regression, and neither depends on corpus size. The plan
  > itself is verified on the real index by `bun run bench`.
*/
test("a ranked decade is ONE query, not ten -- the split is for votes only", () => {
  const ranked = statementsOf((d) =>
    browseIndex(d, { kind: "movie", decade: 2010, sort: "rank", limit: 250, rankIndexes: true }),
  ).filter((sql) => sql.includes("select t.tconst, t.title"));
  expect(ranked.length, "a ranked decade was split into per-year queries -- that is the regression").toBe(1);

  // The votes decade is the case the split exists for, and it must still be split.
  const voted = statementsOf((d) =>
    browseIndex(d, { kind: "movie", decade: 2010, limit: 40, rankIndexes: true }),
  ).filter((sql) => sql.includes("select t.tconst, t.title"));
  expect(voted.length, "the votes decade stopped splitting -- it is 161ms unsplit").toBe(10);
});

test("a ranked decade names the rank index, so the planner cannot pick ix_year", () => {
  const pinned = (opts: BrowseOptions) =>
    statementsOf((d) => browseIndex(d, { ...opts, rankIndexes: true })).find((sql) =>
      sql.includes("select t.tconst, t.title"),
    ) ?? "";

  expect(pinned({ kind: "movie", decade: 2010, sort: "rank", limit: 250 })).toContain("indexed by ix_rank");
  expect(pinned({ decade: 2010, sort: "rank", limit: 250 })).toContain("indexed by ix_rank_all");
  // A GENRE decade is deliberately NOT pinned: ix_tg_rank leads with `genre`, the planner
  // already picks it, and it measures 0.93 ms. A pin there would be a second owner of a
  // decision that is currently right.
  expect(pinned({ genre: "Drama", decade: 2010, sort: "rank", limit: 250 })).not.toContain("indexed by");
  // And no pin at all on the shapes that never needed one.
  expect(pinned({ kind: "movie", decade: 2010, limit: 40 })).not.toContain("indexed by");
  expect(pinned({ genre: "Drama", sort: "rank", limit: 40 })).not.toContain("indexed by");
});

test("an index without the rank indexes is served WITHOUT a pin rather than throwing", () => {
  // `INDEXED BY` is not a hint -- SQLite refuses to PREPARE a statement naming an index that
  // is not there. So an older file must take the planner's path, slowly, rather than break.
  const sql = statementsOf((d) =>
    browseIndex(d, { kind: "movie", decade: 2010, sort: "rank", limit: 250, rankIndexes: false }),
  ).find((s) => s.includes("select t.tconst, t.title"));
  expect(sql).not.toContain("indexed by");
});
