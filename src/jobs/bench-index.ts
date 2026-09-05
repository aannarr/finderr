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
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { hostname, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { profileDrift, STORAGE_PROFILES } from "../lib/bench-profiles";
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
  /**
   * Which index SHAPE to measure -- see `../lib/bench-profiles.ts`.
   *
   * Implies `--reindex`: a profile is a set of indexes, so selecting one has to rebuild them.
   * `shipped` is the baseline and rebuilds to `allIndexes()`, which is what `--reindex`
   * already did, so the two flags are one mechanism with two spellings.
   */
  profile: string | null;
  /** `pragma mmap_size`, in bytes. `0` disables mmap entirely. Null leaves the default. */
  mmap: number | null;
  /** `pragma cache_size`, in KIBIBYTES (written negative into the pragma). */
  cache: number | null;
  /**
   * How many COLD samples per scenario, each against its own fresh clone.
   *
   * One sample was enough while cold was a sanity check. It is not enough to compare two
   * machines: on a spinning array a single cold number carries the whole variance of where
   * the heads happened to be, and the measured spread there is seconds.
   */
  coldRuns: number;
  /**
   * Read the clone end to end before the cold sample, the way `warmPageCache` does at boot.
   *
   * This is the state PRODUCTION is actually in, and neither cold nor warm describes it. It
   * is the cell that decides whether the covering columns are buying anything real.
   */
  prefault: boolean;
  /** Free-text stamp carried into the JSON, so `bench-compare` can label a cell. */
  label: string | null;
  /**
   * Where the clones go. Defaults to `.claude/temp/bench` under the cwd.
   *
   * > [!IMPORTANT] This exists because a reflink cannot cross a bind mount, and the fallback is SILENT
   * > Measured on the NAS 2026-09-05. `cloneIndex` tries `cp -c`, then `cp --reflink=always`, then
   * > a real copy -- and `--reflink=always` fails with EXDEV between two separate Docker bind
   * > mounts of the SAME btrfs filesystem, because the kernel sees two mounts. So a container
   * > run fell through to copying 1.87 GB per cold sample at array speed: 5.7 s each, 105 GB of
   * > writes across a full suite, and nothing in the output saying the fast path had been lost.
   * >
   * > Pointing this INSIDE the same mount as the source restores the reflink. It is also the
   * > only way to guarantee the clone is on the storage under test rather than on the
   * > container's own writable layer -- which on a NAS is a different disk entirely, and would
   * > have measured the wrong device while looking completely correct.
   */
  scratch: string | null;
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
    profile: null,
    mmap: null,
    cache: null,
    coldRuns: 1,
    prefault: false,
    label: null,
    scratch: null,
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
    else if (a === "--profile") out.profile = argv[++i] ?? null;
    else if (a === "--mmap") out.mmap = Number(argv[++i]);
    else if (a === "--cache") out.cache = Number(argv[++i]);
    else if (a === "--cold-runs") out.coldRuns = Number(argv[++i]);
    else if (a === "--prefault") out.prefault = true;
    else if (a === "--label") out.label = argv[++i] ?? null;
    else if (a === "--scratch") out.scratch = argv[++i] ?? null;
  }
  if (!Number.isFinite(out.runs) || out.runs < 1) throw new Error("--runs must be a positive number");
  if (!Number.isFinite(out.coldRuns) || out.coldRuns < 1) throw new Error("--cold-runs must be positive");
  if (out.profile && !STORAGE_PROFILES[out.profile]) {
    throw new Error(`unknown --profile ${out.profile}; have ${Object.keys(STORAGE_PROFILES).join(", ")}`);
  }
  return out;
}

/**
 * Everything about the MACHINE that a number cannot be read without.
 *
 * A wall time is meaningless on its own: 4,635 ms is a catastrophe on one box and impossible
 * on another. This travels in the JSON so `bench-compare` can label a column, and it is
 * printed at the top of the report so a pasted terminal dump is still self-describing.
 *
 * `pageCacheMb` is the one field that is not a constant of the machine, and it is the most
 * important of them here -- an index that fits in the page cache is on RAM no matter what it
 * is stored on, so a cold-vs-warm comparison is only interesting relative to this number.
 */
function hostStamp(dbPath: string): Record<string, unknown> {
  const linuxMeminfo = (): number | null => {
    try {
      const m = readFileSync("/proc/meminfo", "utf8").match(/^Cached:\s+(\d+) kB/m);
      return m ? Math.round(Number(m[1]) / 1024) : null;
    } catch {
      return null;
    }
  };
  return {
    host: hostname(),
    platform: process.platform,
    arch: process.arch,
    cpus: navigator.hardwareConcurrency,
    totalMemMb: Math.round(totalmem() / 1e6),
    pageCacheMb: linuxMeminfo(),
    bun: Bun.version,
    indexBytes: existsSync(dbPath) ? statSync(dbPath).size : null,
  };
}

/**
 * Bytes this process has actually pulled off the BLOCK DEVICE, or null where unknowable.
 *
 * `/proc/self/io`'s `read_bytes` counts what went to the storage layer, so it is zero for a
 * read served from the page cache and non-zero only for real I/O. That is the single most
 * direct answer to "did this query touch the disk?", and it is exactly the column the harness
 * has never had -- its docstring says a pages-read counter would be a guess, and it is right
 * about SQLite's own counters, but the KERNEL knows.
 *
 * **Linux only, and deliberately null rather than 0 on macOS.** A zero would read as "no I/O
 * happened", which is the opposite of "we cannot see". The comparison the whole exercise is
 * for runs on Linux at the end that matters, so having it on one side is worth more than
 * having a fabricated symmetry.
 *
 * It is also PER PROCESS and cumulative, so only a delta across a measured section means
 * anything, and a concurrent read elsewhere in this process would pollute it. The harness is
 * single-threaded and does nothing else while measuring.
 */
function ioReadBytes(): number | null {
  try {
    const m = readFileSync("/proc/self/io", "utf8").match(/^read_bytes:\s+(\d+)/m);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Read a file end to end and discard it, so the OS page cache holds it.
 *
 * The same thing `warmPageCache` does in `../server/live-index.ts`, reproduced rather than
 * imported because that one is a private method on a class that owns a live index and would
 * drag the whole holder in. It is four lines and the duplication is visible from both sides;
 * if it grows a third caller it should move.
 */
async function prefault(path: string): Promise<{ mb: number; ms: number }> {
  const t0 = Bun.nanoseconds();
  let bytes = 0;
  for await (const chunk of Bun.file(path).stream()) bytes += chunk.length;
  return { mb: bytes / 1e6, ms: (Bun.nanoseconds() - t0) / 1e6 };
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
 * A copy-on-write clone where the filesystem has one, a real copy where it does not.
 *
 * > [!IMPORTANT] The reflink is what makes a per-scenario COLD measurement affordable
 * > Cold is measured against a fresh clone -- a new inode the page cache has never read --
 * > so a run makes one clone per scenario. At 730 MB to 2.3 GB each, a real copy would mean
 * > tens of gigabytes of writes per run, and the copying would dwarf what is being measured.
 * > A reflink is instant and costs no space until something writes to it.
 *
 * BOTH spellings are tried, because the two filesystems that matter here disagree: macOS
 * APFS takes `cp -c`, and Linux btrfs -- which is what the Synology this deploys to runs,
 * across nine spinning disks in RAID5 -- takes `cp --reflink`. Trying only the Mac's spelling
 * meant the NAS fell silently through to copying the whole file once per scenario, onto the
 * slowest storage in the system.
 *
 * `--reflink=always` rather than `auto` on purpose: `auto` falls back to a full copy INSIDE
 * `cp` and reports success, so the slow path would be taken with nothing to show it had been.
 */
async function cloneIndex(src: string, dest: string): Promise<"reflink" | "copy"> {
  mkdirSync(dirname(dest), { recursive: true });
  rmSync(dest, { force: true });
  for (const argv of [
    ["cp", "-c", src, dest], // APFS
    ["cp", "--reflink=always", src, dest], // btrfs, XFS
  ]) {
    if (Bun.spawnSync(argv).exitCode === 0) return "reflink";
    // A half-written destination from a failed attempt must not be measured.
    rmSync(dest, { force: true });
  }
  await Bun.write(dest, Bun.file(src));
  return "copy";
}

/**
 * Say ONCE which clone path was taken, because losing the reflink is invisible otherwise.
 *
 * A full copy still produces a correct cold measurement -- it is if anything more definitely
 * cold. What it costs is time and 1.87 GB of writes per sample, and on the array that turned a
 * suite into an hour of copying with nothing in the output to explain where it went. The one
 * line this prints is the difference between noticing and not.
 */
let cloneMethodReported = false;
function reportCloneMethod(how: "reflink" | "copy", ms: number): void {
  if (cloneMethodReported) return;
  cloneMethodReported = true;
  console.log(
    how === "reflink"
      ? `# clone: reflink (instant, no disk)`
      : `# clone: FULL COPY, ${ms.toFixed(0)} ms each -- reflink unavailable (bind mount? not btrfs/APFS?)`,
  );
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
function reindex(path: string, want: readonly string[] = allIndexes()): void {
  const db = new Database(path);
  const existing = (
    db.query("select name from sqlite_master where type='index' and sql is not null").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
  // Which tables this file actually has. An index built before a stage existed has no
  // `episode` table, and `allIndexes()` names two indexes over it -- so a blind loop dies
  // with `no such table: main.episode` against exactly the older index this flag is most
  // useful on. Measured against the live NAS file, which predates the episode stage.
  const tables = new Set(
    (db.query("select name from sqlite_master where type='table'").all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );
  const t0 = Bun.nanoseconds();
  db.run("pragma journal_mode = off");
  db.run("pragma synchronous = off");
  /*
    DROP EVERY INDEX THIS CHECKOUT KNOWS ABOUT FIRST, not just the ones being rebuilt.

    A profile that deliberately OMITS an index (slim drops `ix_pop_title`) would otherwise
    inherit it from the clone, because the loop below only ever drops a name it is about to
    recreate. The result reads as a successful slim run and is actually a shipped run wearing
    slim's label -- the worst kind of wrong number, because nothing about it looks wrong.
  */
  const known = new Set(allIndexes().map((s) => s.match(/create index (?:if not exists )?(\w+)/i)?.[1]));
  for (const name of existing) {
    if (known.has(name)) db.run(`drop index ${name}`);
  }
  let skipped = 0;
  for (const sql of want) {
    // The OLD shape is already gone -- the bulk drop above removed every index this checkout
    // knows about, so a reshape needs no per-statement drop. An index the clone carries that
    // this checkout has NEVER heard of survives on purpose: it belongs to a newer build and
    // silently deleting it would make the clone stop resembling the file it came from.
    const name = sql.match(/create index (?:if not exists )?(\w+)/i)?.[1];
    const table = sql.match(/\bon\s+(\w+)\s*\(/i)?.[1];
    if (table && !tables.has(table)) {
      skipped++;
      continue;
    }
    // Only reachable for an index outside `allIndexes()` -- a profile-only name. Dropping it
    // here keeps `create` from failing on a rerun against a `--keep` clone.
    if (name && existing.includes(name) && !known.has(name)) db.run(`drop index ${name}`);
    db.run(sql);
  }
  if (skipped > 0) console.log(`# skipped ${skipped} index(es) over tables this index does not have`);
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
  /** The worst warm sample. On a synchronous single-threaded server this IS the stall. */
  max: number;
  /** Median of `--cold-runs` samples, each against its own never-read inode. */
  cold: number;
  coldMin: number;
  coldMax: number;
  /**
   * Bytes off the block device during the first cold sample, or null where unknowable.
   *
   * This is the column that turns "it was slow" into "it read 41 MB to answer a 40-row page".
   * Linux only -- see `ioReadBytes`.
   */
  coldIo: number | null;
  /** How long the sequential prefault took, when `--prefault` was on. */
  prefaultMs: number | null;
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

/**
 * Open an engine, optionally overriding the two pragmas that decide how it reads.
 *
 * > [!IMPORTANT] Overridden AFTER construction, not passed in, and that is on purpose
 * > `SearchEngine`'s constructor is the single owner of the read-side pragmas and has a long
 * > comment explaining each one. Threading a bench-only options bag through it would put a
 * > second owner beside that comment, for a knob only this file ever sets. Both pragmas are
 * > connection settings that take effect when set on an open handle, so re-running them here
 * > is a genuine override and costs production nothing.
 *
 * `mmap_size = 0` is the interesting one. With mmap on, a cold read is a PAGE FAULT inside a
 * synchronous `bun:sqlite` call -- and because the render path is single-threaded, that fault
 * stalls the whole server rather than one request. Turning it off makes the same read a
 * `pread`, which is no faster but is at least accounted for in `/proc/self/io`.
 */
function openEngine(
  path: string,
  cfg: ReturnType<typeof loadConfig>,
  pragmas?: { mmap: number | null; cache: number | null },
): SearchEngine {
  const engine = new SearchEngine(path, cfg);
  if (pragmas?.mmap !== null && pragmas?.mmap !== undefined) {
    engine.rawDb.run(`pragma mmap_size = ${pragmas.mmap}`);
  }
  if (pragmas?.cache !== null && pragmas?.cache !== undefined) {
    engine.rawDb.run(`pragma cache_size = -${pragmas.cache}`);
  }
  // Without this the fuzzy tier silently does not load and `search.fuzzy` measures an absent
  // feature -- it comes back in microseconds because it finds nothing.
  engine.prepareFuzzy(() => {});
  return engine;
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const cfg = loadConfig();
  const scratch = args.scratch ?? join(process.cwd(), ".claude", "temp", "bench");
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
    const how = await cloneIndex(source, dbPath);
    const ms = (Bun.nanoseconds() - t0) / 1e6;
    console.log(`${ms.toFixed(0)} ms`);
    reportCloneMethod(how, ms);
  }
  const target = args.db ?? dbPath;
  assertNotLiveIndex(target);

  const profile = args.profile ? STORAGE_PROFILES[args.profile] : null;
  if (profile) {
    const drift = profileDrift(allIndexes());
    if (drift.missing.length > 0 || drift.extra.length > 0) {
      // Loud, and not fatal. A profile that has fallen behind `INDEXES` still produces a
      // usable number for every OTHER index -- what it cannot do is be quoted without this
      // caveat, so the caveat is printed where the number is.
      console.log(
        `# !! PROFILE DRIFT -- missing: ${drift.missing.join(",") || "none"} extra: ${drift.extra.join(",") || "none"}`,
      );
    }
    console.log(`# profile: ${profile.name} -- ${profile.what}`);
    reindex(target, profile.indexes ?? allIndexes());
  } else if (args.reindex) {
    reindex(target);
  }

  const stamp = hostStamp(target);
  console.log(
    `# host: ${stamp.host} ${stamp.platform}/${stamp.arch} ${stamp.cpus}cpu ` +
      `ram=${stamp.totalMemMb}MB pagecache=${stamp.pageCacheMb ?? "?"}MB bun=${stamp.bun}`,
  );
  console.log(
    `# index: ${((stamp.indexBytes as number) / 1e6).toFixed(0)} MB  ` +
      `mmap=${args.mmap ?? "default"} cache=${args.cache ? `${args.cache}KiB` : "default"} ` +
      `cold-runs=${args.coldRuns} prefault=${args.prefault}`,
  );

  const engine = openEngine(target, cfg, args);
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
    await Bun.write(
      args.json,
      JSON.stringify(
        {
          // The label is what a matrix column is titled. Defaulted rather than required, so a
          // run without one is still comparable -- an unlabelled cell that silently collides
          // with another is worse than an ugly name.
          label: args.label ?? `${stamp.host}/${profile?.name ?? "as-is"}${args.prefault ? "/pf" : ""}`,
          stamp,
          profile: profile?.name ?? null,
          pragmas: { mmap: args.mmap, cache: args.cache },
          prefault: args.prefault,
          coldRuns: args.coldRuns,
          meta,
          fixtures,
          runs: args.runs,
          results,
        },
        null,
        2,
      ),
    );
    console.log(`\nwrote ${args.json}`);
  }
  engine.close();
  if (!args.db && !args.keep) {
    // With `--scratch` the directory is usually a MOUNT POINT, which cannot be unlinked --
    // removing it threw EACCES at the very end of an otherwise complete NAS run and made a
    // successful measurement exit non-zero. Clear the contents and leave the directory.
    if (args.scratch) {
      for (const f of new Bun.Glob("*.db").scanSync(scratch)) rmSync(join(scratch, f), { force: true });
    } else {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
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

    > [!IMPORTANT] Reflink cold is REAL cold, on both filesystems, and the reason is the same
    > A reflink shares physical extents with the source but is a new INODE, and both APFS's
    > UBC and Linux's page cache are keyed on the inode. So the pages must be fetched from the
    > device again even though identical bytes are cached under the original file. That is
    > what makes a per-scenario cold measurement affordable rather than requiring a reboot or
    > a `drop_caches` between every single one.

    ONE SAMPLE IS NOT A MEASUREMENT ON A SPINNING ARRAY. Cold cost there is dominated by where
    the heads happen to be, and the spread across identical runs is hundreds of milliseconds
    to seconds. `--cold-runs` takes N samples against N fresh clones and reports the median
    with its min and max, so a comparison between two machines is not a comparison of luck.
  */
  const coldTimes: number[] = [];
  let coldIo: number | null = null;
  let prefaultMs: number | null = null;
  if (!args.db) {
    for (let i = 0; i < args.coldRuns; i++) {
      const coldPath = join(scratch, `cold-${s.id.replace(/[^a-z0-9]/gi, "-")}-${i}.db`);
      const tc = Bun.nanoseconds();
      reportCloneMethod(await cloneIndex(target, coldPath), (Bun.nanoseconds() - tc) / 1e6);
      // The PREFAULTED cell: the file pulled into the page cache sequentially first, which is
      // the state a production container is in seconds after boot. Neither cold nor warm
      // describes it, and it is the state most reads actually happen in.
      if (args.prefault) {
        const p = await prefault(coldPath);
        prefaultMs = p.ms;
      }
      const coldEngine = openEngine(coldPath, cfg, args);
      const io0 = ioReadBytes();
      const t0 = Bun.nanoseconds();
      s.run(coldEngine);
      coldTimes.push((Bun.nanoseconds() - t0) / 1e6);
      const io1 = ioReadBytes();
      // Only the FIRST sample's I/O is kept. Later ones read the same extents through a
      // different inode, and whether the device served them from its own cache is not
      // something this process can see -- so averaging them would blend two different
      // questions. The first is the honest one.
      if (i === 0 && io0 !== null && io1 !== null) coldIo = io1 - io0;
      coldEngine.close();
      rmSync(coldPath, { force: true });
    }
  }
  coldTimes.sort((a, b) => a - b);
  const cold = quantile(coldTimes, 0.5);

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
    max: times[times.length - 1] ?? 0,
    cold,
    coldMin: coldTimes[0] ?? 0,
    coldMax: coldTimes[coldTimes.length - 1] ?? 0,
    coldIo,
    prefaultMs,
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
  const anyIo = results.some((r) => r.coldIo !== null);
  console.log(
    `${"scenario".padEnd(26)}${"p50".padStart(9)}${"p99".padStart(9)}${"max".padStart(9)}` +
      `${"cold".padStart(10)}${"coldMin".padStart(10)}${"coldMax".padStart(10)}` +
      `${anyIo ? "coldIO".padStart(11) : ""}${"rows".padStart(7)}  flags`,
  );
  console.log("-".repeat(anyIo ? 108 : 97));
  for (const r of sorted) {
    const flags = [r.sorts > 0 ? `SORT x${r.sorts}` : "", r.scans > 0 ? `SCAN x${r.scans}` : ""]
      .filter(Boolean)
      .join(" ");
    const io = anyIo ? (r.coldIo === null ? "-" : `${(r.coldIo / 1e6).toFixed(1)}MB`).padStart(11) : "";
    console.log(
      `${r.id.padEnd(26)}${r.p50.toFixed(2).padStart(9)}${r.p99.toFixed(2).padStart(9)}` +
        `${r.max.toFixed(2).padStart(9)}${r.cold.toFixed(1).padStart(10)}` +
        `${r.coldMin.toFixed(1).padStart(10)}${r.coldMax.toFixed(1).padStart(10)}` +
        `${io}${String(r.rows).padStart(7)}  ${flags}`,
    );
  }

  // The whole point of the exercise, in two numbers: what a page pays with a cache and
  // without one. A ratio near 1 means the storage is irrelevant to this workload.
  const sumP50 = results.reduce((a, r) => a + r.p50, 0);
  const sumCold = results.reduce((a, r) => a + r.cold, 0);
  console.log(
    `\nsuite total: warm ${sumP50.toFixed(1)} ms | cold ${sumCold.toFixed(1)} ms ` +
      `| cold/warm ${sumP50 > 0 ? (sumCold / sumP50).toFixed(0) : "?"}x`,
  );
  const pf = results.find((r) => r.prefaultMs !== null)?.prefaultMs;
  if (pf !== null && pf !== undefined) {
    console.log(`prefault: ${(pf / 1000).toFixed(2)}s to read the file sequentially, per cold sample`);
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
