/**
 * The speed harness: every render-path question, timed against an ISOLATED index.
 *
 * ```bash
 * bun run bench                      # clone data/titles.db, 100 runs each, print a report
 * bun run bench -- --runs 500        # more samples
 * bun run bench -- --json out.json   # machine-readable, for diffing two branches
 * bun run bench -- --db /path/to.db  # some other index
 * bun run bench -- --filter browse   # only scenarios whose id contains this
 * ```
 *
 * ## It never runs against the live index, and that is enforced rather than documented
 *
 * It CLONES `data/titles.db` to a scratch path and opens the clone. On macOS the clone is
 * `cp -c`, an APFS copy-on-write reflink: it is instant, costs no disk until something is
 * written, and -- the part that matters -- a write to the clone can never reach the original.
 * `assertNotLiveIndex` then refuses any `--db` that points inside a `data/` directory, so the
 * safety does not depend on remembering to pass the right flag.
 *
 * This is not ceremony. This project has corrupted its SQLite files twice, both times because
 * two things had one database open, and the index is the one file here that takes minutes to
 * rebuild. A benchmark that perturbs the thing it measures is also just a bad benchmark.
 *
 * ## What it reports, and why each column is there
 *
 * - **p50 / p95 / p99** over `--runs` samples, warm. The tail is the point: a p50 that looks
 *   fine over a p99 that does not is a query whose cost depends on which rows it got, and
 *   that is exactly the shape a sort-the-corpus plan has.
 * - **cold**, measured once per scenario against a FRESH CLONE -- a new inode the OS page
 *   cache has never seen. A container that just restarted pays this, and it is the number a
 *   warm loop is usually hiding. Nothing else in this repo measures it.
 * - **rows**, because a query that got faster by returning less is not faster.
 * - **plan**, from `EXPLAIN QUERY PLAN` over the statements the scenario ACTUALLY RAN --
 *   captured, never restated. `SORT` means the planner could not serve the ORDER BY from an
 *   index and collected the whole matching set first, which is the difference between a page
 *   that costs its own size and one that costs the corpus.
 *
 * There is deliberately **no per-query I/O counter**: bun:sqlite exposes neither
 * `sqlite3_db_status` nor `sqlite3_stmt_status`, so a "pages read" column here would be a
 * guess wearing a measurement's clothes. The cold/warm pair is the honest proxy -- the
 * difference between them IS the I/O, and it is measured rather than modelled.
 *
 * The pass/fail gate lives in `src/lib/query-plans.test.ts`, not here: a wall-clock threshold
 * is machine-dependent and belongs in a report a human reads, while a query PLAN is
 * categorical and belongs in the suite.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type BenchFixtures, type Scenario, scenarios } from "../lib/bench-scenarios";
import { loadConfig } from "../lib/config";
import {
  allIndexes,
  BROWSE_COUNT_SCHEMA,
  buildBrowseCounts,
  computeShelfGenres,
  SHELF_GENRES_META_KEY,
} from "../lib/index-builder";
import { SearchEngine } from "../lib/search";

interface Args {
  runs: number;
  /** Use this file AS THE BENCHMARK TARGET -- must not be a live index. */
  db: string | null;
  /** CLONE from this file. May be a live index; that is the whole point of cloning. */
  source: string | null;
  json: string | null;
  filter: string | null;
  keep: boolean;
  /** Rebuild the clone's indexes from the CURRENT `INDEXES` before measuring. */
  reindex: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    runs: 100,
    db: null,
    source: null,
    json: null,
    filter: null,
    keep: false,
    reindex: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--runs") out.runs = Number(argv[++i]);
    else if (a === "--db") out.db = argv[++i] ?? null;
    else if (a === "--source") out.source = argv[++i] ?? null;
    else if (a === "--json") out.json = argv[++i] ?? null;
    else if (a === "--filter") out.filter = argv[++i] ?? null;
    else if (a === "--keep") out.keep = true;
    else if (a === "--reindex") out.reindex = true;
  }
  if (!Number.isFinite(out.runs) || out.runs < 1) throw new Error("--runs must be a positive number");
  return out;
}

/**
 * Where to clone the index FROM.
 *
 * `cfg.dataDir` is `/data` by default, which is the container's path and is not there on a
 * dev machine -- and in a WORKTREE there is no `data/` at all, because the index lives in the
 * main checkout beside `.git`. So the search order ends at the git common directory, which is
 * what makes `bun run bench` work from a worktree without anybody passing a flag.
 */
function findIndex(dataDir: string): string | null {
  const candidates = [join(dataDir, "titles.db"), join(process.cwd(), "data", "titles.db")];
  const common = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common.exitCode === 0) {
    candidates.push(join(dirname(common.stdout.toString().trim()), "data", "titles.db"));
  }
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * Refuse to benchmark a file that something else might be serving from.
 *
 * A benchmark opens a connection, and this project has twice corrupted a SQLite file by
 * having two things open one. The check is on the DIRECTORY rather than on the exact name so
 * `titles.new.db` and `finderr.db` are refused too -- a build in progress is the worst
 * possible thing to point this at.
 */
export function assertNotLiveIndex(path: string): void {
  if (/(^|\/)data\/[^/]*$/.test(resolve(path).replace(/\\/g, "/"))) {
    throw new Error(
      `REFUSING to benchmark ${path}: it is inside a live data directory.\n` +
        "Point --db at a copy. With no --db at all this clones data/titles.db for you.",
    );
  }
}

/**
 * A copy-on-write clone where the platform has one, a real copy where it does not.
 *
 * `cp -c` fails rather than falling back on a non-APFS filesystem, which is why the plain
 * copy is a fallback rather than the default: on the Mac this ships from, the reflink makes a
 * 2.18 GB clone free, and paying two gigabytes of writes per cold sample would make the cold
 * measurement itself the slowest thing in the run.
 */
async function cloneIndex(src: string, dest: string): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true });
  rmSync(dest, { force: true });
  const reflink = Bun.spawnSync(["cp", "-c", src, dest]);
  if (reflink.exitCode !== 0) await Bun.write(dest, Bun.file(src));
}

/**
 * Bring a CLONE up to the index shape this checkout would build, without a full rebuild.
 *
 * An index change is the cheapest kind to test and the most expensive kind to test WRONG: a
 * full `index:build` re-reads a 226 MB dump and takes minutes, so the temptation is to reason
 * about a column order instead of measuring it. Dropping and recreating every index takes a
 * few seconds on the real file, which makes "does this help?" a question you answer rather
 * than argue about.
 *
 * > [!IMPORTANT] It re-EXPLAINS the NEIGHBOURS too, and that is not paranoia
 * > Adding an index changes what the planner picks for queries you did not touch. Measured on
 * > this index: adding a `(kind, year, rank desc)` index took an UNRELATED ranked walk from
 * > 0.34 ms to 95 ms, because the planner switched to the new index and lost its ordering.
 * > That is why the report prints a plan for every scenario rather than only for the one
 * > being tuned -- an index is a global change wearing a local one's clothes.
 *
 * Only ever run against a clone: `assertNotLiveIndex` has already refused a live path by the
 * time this is called, and this is the one place the harness WRITES.
 */
function reindex(path: string): void {
  const db = new Database(path);
  const existing = (
    db.query("select name from sqlite_master where type='index' and sql is not null").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
  const t0 = Bun.nanoseconds();
  db.run("pragma journal_mode = off");
  db.run("pragma synchronous = off");
  for (const sql of allIndexes()) {
    // The name is needed to drop the OLD shape before creating the new one -- a reshape is a
    // drop plus a create, and `create index if not exists` would silently keep the old order.
    const name = sql.match(/create index (?:if not exists )?(\w+)/i)?.[1];
    if (name && existing.includes(name)) db.run(`drop index ${name}`);
    db.run(sql);
  }
  /*
    The PRECOMPUTES are part of the shape too, and forgetting them is a silent wrong answer.

    Both of these fall back to a live query when absent, by design -- so a clone missing them
    still returns every correct number and the benchmark quietly reports the fallback's cost
    as if it were the shipping cost. That happened: the first run after `browse_count` landed
    showed a genre browse at 5.43 ms and the precompute as having done nothing, because the
    cloned file predated the table and `hasBrowseCounts` was false.
  */
  db.run(BROWSE_COUNT_SCHEMA.replace("create table", "create table if not exists"));
  buildBrowseCounts(db);
  db.run("insert or replace into meta (key, value) values (?, ?)", [
    SHELF_GENRES_META_KEY,
    computeShelfGenres(db).join(","),
  ] as never[]);
  db.run("analyze");
  db.close();
  console.log(`# reindexed to this checkout's INDEXES in ${((Bun.nanoseconds() - t0) / 1e9).toFixed(1)}s`);
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
}

/**
 * A database that records the SQL it is asked for and delegates the rest.
 *
 * NOT a `Proxy`: bun:sqlite's `Database` uses real JS private fields, which resolve on the
 * RECEIVER -- so a proxied method call looks the field up on the proxy and throws "Cannot
 * access invalid private field". A plain object of bound methods has no such problem. This
 * cost an hour to learn and is the reason the comment is here.
 */
function recordingDb(real: Database, seen: string[]): Database {
  return {
    query: (sql: string) => {
      seen.push(sql);
      return real.query(sql);
    },
    prepare: (sql: string) => {
      seen.push(sql);
      return real.prepare(sql);
    },
    run: (sql: string, ...a: unknown[]) => real.run(sql, ...(a as never[])),
  } as unknown as Database;
}

interface Row {
  id: string;
  surface: string;
  args: string;
  p50: number;
  p95: number;
  p99: number;
  cold: number;
  rows: number;
  sorts: number;
  scans: number;
  plans: string[];
}

/** How many rows a scenario produced, for anything shaped like a result. */
function countRows(v: unknown): number {
  if (Array.isArray(v)) return v.length;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.rows)) return o.rows.length;
    if (Array.isArray(o.results)) return o.results.length;
    if (Array.isArray(o.credits)) return o.credits.length;
    return 1;
  }
  return v === null || v === undefined ? 0 : 1;
}

function openEngine(path: string, cfg: ReturnType<typeof loadConfig>): SearchEngine {
  const engine = new SearchEngine(path, cfg);
  // Without this the fuzzy tier silently does not load and `search.fuzzy` measures an absent
  // feature -- it comes back in microseconds because it finds nothing.
  engine.prepareFuzzy(() => {});
  return engine;
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const cfg = loadConfig();
  const scratch = join(process.cwd(), ".claude", "temp", "bench");
  // `--db` is a target and must not be live; `--source` is a clone origin and may be.
  if (args.db) assertNotLiveIndex(args.db);
  const source = args.db ?? args.source ?? findIndex(cfg.dataDir);
  if (!source || !existsSync(source)) {
    throw new Error(
      `no index found (looked in ${cfg.dataDir}, ./data, and the main checkout's data/).\n` +
        "Run `bun run index:build`, or point --source at one.",
    );
  }

  const dbPath = join(scratch, "titles.db");
  if (args.db) {
    console.log(`# index: ${source} (used as given)`);
  } else {
    process.stdout.write(`# cloning ${source} -> ${dbPath} ... `);
    const t0 = Bun.nanoseconds();
    await cloneIndex(source, dbPath);
    console.log(`${((Bun.nanoseconds() - t0) / 1e6).toFixed(0)} ms`);
  }
  const target = args.db ?? dbPath;
  assertNotLiveIndex(target);
  if (args.reindex) reindex(target);

  const engine = openEngine(target, cfg);
  const meta = engine.meta();
  console.log(
    `# built_at=${meta.built_at ?? "?"} rows=${meta.rows ?? "?"} episodes=${meta.episode_rows ?? "0"}`,
  );
  console.log(
    `# caps: rank=${engine.hasRank} people=${engine.hasPeople} ids=${engine.hasIds} episodes=${engine.hasEpisodes}`,
  );

  // Fixtures from the index itself, never hardcoded -- a benchmark that measures a MISS is
  // fast for the wrong reason and reports it as good news.
  const top = engine.topRated({ limit: 1 })[0];
  const series = engine.browse({ kind: "tvSeries", sort: "votes", limit: 1 }).rows[0];
  const person = engine.personPage("nm0000138") ? "nm0000138" : "nm0000199";
  const fixtures: BenchFixtures = {
    tconst: top?.tconst ?? "tt0111161",
    seriesTconst: series?.tconst ?? "tt0944947",
    nconst: person,
    genre: engine.topGenres(1)[0] ?? "Drama",
  };
  console.log(
    `# fixtures: title=${fixtures.tconst} series=${fixtures.seriesTconst} person=${fixtures.nconst} genre=${fixtures.genre}`,
  );
  console.log(`# runs=${args.runs} per scenario\n`);

  const all = scenarios(fixtures);
  const chosen = args.filter ? all.filter((s) => s.id.includes(args.filter as string)) : all;
  if (chosen.length === 0) throw new Error(`--filter ${args.filter} matched no scenario`);

  const results: Row[] = [];
  for (const s of chosen) {
    results.push(await measure(engine, s, args, target, cfg, scratch));
    process.stdout.write(".");
  }
  console.log("\n");
  report(results);

  if (args.json) {
    await Bun.write(args.json, JSON.stringify({ meta, fixtures, runs: args.runs, results }, null, 2));
    console.log(`\nwrote ${args.json}`);
  }
  engine.close();
  if (!args.db && !args.keep) rmSync(scratch, { recursive: true, force: true });
}

async function measure(
  engine: SearchEngine,
  s: Scenario,
  args: Args,
  target: string,
  cfg: ReturnType<typeof loadConfig>,
  scratch: string,
): Promise<Row> {
  // Warm: discard one run, then sample.
  const first = s.run(engine);
  const times: number[] = [];
  for (let i = 0; i < args.runs; i++) {
    const t0 = Bun.nanoseconds();
    s.run(engine);
    times.push((Bun.nanoseconds() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);

  /*
    COLD, and it is a fresh CLONE rather than a fresh handle.

    The OS page cache lives above the process, so closing and reopening a Database measures a
    warm file through a new handle -- which is the mistake that makes cold numbers look like
    warm ones. A reflink clone is a new inode the cache has never read, so the first query
    against it pays real disk. Free on APFS, which is what makes this affordable per scenario.
  */
  let cold = 0;
  if (!args.db) {
    const coldPath = join(scratch, `cold-${s.id.replace(/[^a-z0-9]/gi, "-")}.db`);
    await cloneIndex(target, coldPath);
    const coldEngine = openEngine(coldPath, cfg);
    const t0 = Bun.nanoseconds();
    s.run(coldEngine);
    cold = (Bun.nanoseconds() - t0) / 1e6;
    coldEngine.close();
    rmSync(coldPath, { force: true });
  }

  // The plans, from the statements this scenario really ran.
  const seen: string[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: swapping the engine's private handle to record
  const realDb = (engine as any).db as Database;
  // biome-ignore lint/suspicious/noExplicitAny: restored immediately below
  (engine as any).db = recordingDb(realDb, seen);
  try {
    s.run(engine);
  } finally {
    // biome-ignore lint/suspicious/noExplicitAny: restore before anything else uses it
    (engine as any).db = realDb;
  }

  const plans: string[] = [];
  for (const sql of new Set(seen)) {
    const n = (sql.match(/\?/g) ?? []).length;
    for (const filler of [1, "movie", fixturesFiller, 0]) {
      try {
        plans.push(
          (
            realDb.query(`explain query plan ${sql}`).all(...(Array(n).fill(filler) as never[])) as {
              detail: string;
            }[]
          )
            .map((p) => p.detail)
            .join(" | "),
        );
        break;
      } catch {
        /* a bind of the wrong type: try the next shape */
      }
    }
  }

  return {
    id: s.id,
    surface: s.surface,
    args: s.args,
    p50: quantile(times, 0.5),
    p95: quantile(times, 0.95),
    p99: quantile(times, 0.99),
    cold,
    rows: countRows(first),
    sorts: plans.filter((p) => p.includes("USE TEMP B-TREE")).length,
    scans: plans.filter((p) => /SCAN (?!.*USING COVERING INDEX)/.test(p)).length,
    plans,
  };
}

/** A string that binds where a tconst is wanted; only ever used to shape an EXPLAIN. */
const fixturesFiller = "tt0000001";

function report(results: Row[]): void {
  const sorted = [...results].sort((a, b) => b.p50 - a.p50);
  console.log(
    `${"scenario".padEnd(26)}${"p50".padStart(9)}${"p95".padStart(9)}${"p99".padStart(9)}${"cold".padStart(10)}${"rows".padStart(7)}  flags`,
  );
  console.log("-".repeat(86));
  for (const r of sorted) {
    const flags = [r.sorts > 0 ? `SORT x${r.sorts}` : "", r.scans > 0 ? `SCAN x${r.scans}` : ""]
      .filter(Boolean)
      .join(" ");
    console.log(
      `${r.id.padEnd(26)}${r.p50.toFixed(2).padStart(9)}${r.p95.toFixed(2).padStart(9)}${r.p99.toFixed(2).padStart(9)}${r.cold.toFixed(1).padStart(10)}${String(r.rows).padStart(7)}  ${flags}`,
    );
  }

  console.log("\nby surface (sum of p50, ms) -- what a page pays if it runs each once:");
  const bySurface = new Map<string, number>();
  for (const r of results) bySurface.set(r.surface, (bySurface.get(r.surface) ?? 0) + r.p50);
  for (const [s, total] of [...bySurface.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s.padEnd(10)} ${total.toFixed(2).padStart(9)} ms`);
  }

  const bad = sorted.filter((r) => r.sorts > 0 || r.scans > 0);
  if (bad.length > 0) {
    console.log("\nplans that sort or scan -- each is a query costing the corpus, not the page:");
    for (const r of bad) {
      console.log(`\n  ${r.id}  (${r.p50.toFixed(2)} ms p50, ${r.cold.toFixed(1)} ms cold)  args: ${r.args}`);
      for (const p of r.plans.filter(
        (x) => x.includes("USE TEMP B-TREE") || /SCAN (?!.*USING COVERING)/.test(x),
      )) {
        console.log(`    ${p}`);
      }
    }
  } else {
    console.log("\nno scenario sorts or scans -- every ordered read is served from an index.");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
