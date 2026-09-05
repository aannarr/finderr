/**
 * Run the whole settings matrix, strictly one cell at a time, in one process.
 *
 * ```bash
 * bun src/jobs/bench-sweep.ts --source /bench/titles.db --out /bench/results \
 *     --scratch /bench/scratch --prefix nas --cells base-cold,base-pf,mmap0-pf
 * bun src/jobs/bench-sweep.ts --list          # what cells exist and what each varies
 * ```
 *
 * > [!CAUTION] THE WHOLE POINT IS THAT NOTHING RUNS CONCURRENTLY. This was paid for.
 * > On 2026-09-05 two `bench-index` runs were launched against the same NAS minutes apart.
 * > They contended for one spinning array -- which alone invalidates both sets of numbers --
 * > and, far worse, they shared one `--scratch`, so both were reading and WRITING
 * > `scratch/titles.db`: two connections on one SQLite file, which is exactly how this
 * > project has corrupted a database twice before. Both runs were discarded.
 * >
 * > A benchmark is not a thing you can helpfully parallelise. This runner exists so the
 * > serialisation is a property of the CODE rather than of whoever is driving it, and it
 * > takes a lock to make that true even across two people typing.
 *
 * ## Resumable, because the full matrix is hours on a Celeron
 *
 * A cell whose output JSON already exists is SKIPPED. So an interrupted sweep is restarted
 * with the same command and picks up where it stopped, and a single cell is re-measured by
 * deleting its one file. That matters more than it sounds: the temptation on a run this long
 * is to shorten the suite, and a resumable runner removes the reason to.
 *
 * ## One factor at a time, around a prefaulted baseline
 *
 * Not a full cross product -- that is 100+ cells and days of Celeron time, and it answers a
 * question nobody asked. Each cell moves ONE knob off a fixed baseline, which is what
 * "which setting matters?" actually needs. The cold twins exist because several of these
 * knobs are expected to matter ONLY before the page cache is warm, and averaging that away
 * is how a real effect gets reported as noise.
 */

import { existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

/**
 * Refuse to start while another sweep holds the scratch directory.
 *
 * `wx` is an EXCLUSIVE create -- it fails if the file exists, atomically, so two sweeps racing
 * cannot both believe they won. That atomicity is the whole mechanism; a `existsSync` check
 * followed by a write has a window between them and would not have prevented the 2026-09-05
 * collision it is here to prevent.
 *
 * The lock records who holds it, because the useful failure message is "pid 4127 on studio since
 * 14:02", not "locked". A STALE lock (the holder was killed) is broken by deleting the file --
 * printed in the error rather than auto-detected, because guessing that a holder is dead is how
 * a lock starts permitting exactly the thing it forbids.
 */
function takeLock(scratch: string): () => void {
  mkdirSync(scratch, { recursive: true });
  const path = join(scratch, "sweep.lock");
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch {
    const held = existsSync(path) ? readFileSync(path, "utf8").trim() : "(unreadable)";
    throw new Error(
      `ANOTHER SWEEP HOLDS ${path}\n  ${held}\n` +
        "Two benchmarks on one array invalidate each other, and a shared scratch means two " +
        "writers on one SQLite file. Wait for it, or delete the lock if that holder is gone.",
    );
  }
  writeSync(fd, `pid ${process.pid} on ${hostname()} since ${new Date().toISOString()}\n`);
  const release = (): void => rmSync(path, { force: true });
  // Ctrl-C and SIGTERM included: a lock that survives its holder is worse than no lock, because
  // the next run is blocked by a process that no longer exists.
  process.on("exit", release);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      release();
      process.exit(130);
    });
  }
  return release;
}

/**
 * One measured configuration.
 *
 * `args` are appended to `bench-index.ts` verbatim, so a cell is exactly reproducible by
 * hand from the report -- which is the property that makes a surprising number checkable
 * instead of merely doubted.
 */
interface Cell {
  name: string;
  what: string;
  args: string[];
  /** Rebuild the source at this SQLite page size first. Null uses the file as given. */
  pageSize: number | null;
}

const PREFAULT = "--prefault";

export const CELLS: Cell[] = [
  {
    name: "base-cold",
    what: "BASELINE, cold: shipped indexes, mmap 2G, cache 256M, page 4K",
    args: ["--profile", "shipped"],
    pageSize: null,
  },
  {
    name: "base-pf",
    what: "BASELINE, prefaulted -- the state production is actually in",
    args: ["--profile", "shipped", PREFAULT],
    pageSize: null,
  },
  {
    name: "mmap0-cold",
    what: "mmap_size=0, cold -- does mmap drive the 1 MB readahead amplification?",
    args: ["--profile", "shipped", "--mmap", "0"],
    pageSize: null,
  },
  {
    name: "mmap0-pf",
    what: "mmap_size=0, prefaulted -- is mmap still worth it once cached?",
    args: ["--profile", "shipped", "--mmap", "0", PREFAULT],
    pageSize: null,
  },
  {
    name: "cache32-pf",
    what: "cache_size 32M instead of 256M -- is the pager cache redundant under mmap?",
    args: ["--profile", "shipped", "--cache", "32768", PREFAULT],
    pageSize: null,
  },
  {
    // THE CONTROL, and the sweep is not interpretable without it. `VACUUM INTO` both changes
    // the page size AND perfectly defragments the file and drops the freelist. So a 16K
    // variant beating the source could be the page size or could be the vacuum. This cell is
    // vacuumed at the SAME 4K the source already uses, which isolates one from the other:
    // compare page16k-cold against THIS, never against base-cold.
    name: "page4k-vacuum-cold",
    what: "CONTROL: vacuumed at the existing 4K -- separates the vacuum from the page size",
    args: ["--profile", "shipped"],
    pageSize: 4096,
  },
  {
    name: "page16k-cold",
    what: "page_size 16K, cold -- the array's minimum useful I/O is 64K, ours is 4K",
    args: ["--profile", "shipped"],
    pageSize: 16384,
  },
  {
    name: "page16k-pf",
    what: "page_size 16K, prefaulted -- fanout and file size, with I/O taken out",
    args: ["--profile", "shipped", PREFAULT],
    pageSize: 16384,
  },
  {
    name: "page32k-cold",
    what: "page_size 32K, cold -- half the array's 64K minimum",
    args: ["--profile", "shipped"],
    pageSize: 32768,
  },
  {
    name: "page64k-cold",
    what: "page_size 64K, cold -- exactly the RAID chunk, SQLite's maximum",
    args: ["--profile", "shipped"],
    pageSize: 65536,
  },
  {
    name: "slimpayload-pf",
    what: "285 MB smaller index, prefaulted -- footprint, which is what a memory cap punishes",
    args: ["--profile", "slimPayload", PREFAULT],
    pageSize: null,
  },
  {
    name: "slimpayload-cold",
    what: "285 MB smaller index, cold -- fewer bytes to fault in",
    args: ["--profile", "slimPayload"],
    pageSize: null,
  },
];

interface Args {
  source: string;
  out: string;
  scratch: string;
  prefix: string;
  cells: string[];
  runs: number;
  coldRuns: number;
  /** Refuse to run unless the runtime is exactly this. See `assertRuntime`. */
  expectBun: string | null;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    source: "",
    out: "",
    scratch: "",
    prefix: "run",
    cells: CELLS.map((c) => c.name),
    runs: 20,
    coldRuns: 2,
    expectBun: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--source") out.source = argv[++i] ?? "";
    else if (a === "--out") out.out = argv[++i] ?? "";
    else if (a === "--scratch") out.scratch = argv[++i] ?? "";
    else if (a === "--prefix") out.prefix = argv[++i] ?? "run";
    else if (a === "--cells") out.cells = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (a === "--runs") out.runs = Number(argv[++i]);
    else if (a === "--cold-runs") out.coldRuns = Number(argv[++i]);
    else if (a === "--expect-bun") out.expectBun = argv[++i] ?? null;
  }
  for (const name of out.cells) {
    if (!CELLS.some((c) => c.name === name)) {
      throw new Error(`unknown cell ${name}; have ${CELLS.map((c) => c.name).join(", ")}`);
    }
  }
  return out;
}

/**
 * Refuse to measure on a runtime that is not the one being reasoned about.
 *
 * aannarr, 2026-09-05: *"important we run the same bun runtime for tests"*. He is right and it
 * is not a formality -- Bun ships its own SQLite build, and `bun:sqlite`'s pragma handling,
 * page cache behaviour and mmap defaults are exactly what this sweep is measuring. Two cells
 * compared across two Bun versions are two experiments, not one.
 *
 * The bench IMAGE inherits `FROM` the production image for the same reason, so it carries the
 * identical Bun and the identical compiled spellfix1 rather than a fresh install that merely
 * ought to match. This check is the belt to that braces: it makes a drift a refusal at second
 * zero instead of a footnote discovered after a three-hour run.
 */
function assertRuntime(expect: string | null): void {
  console.log(`# runtime: bun ${Bun.version} (${process.platform}/${process.arch})`);
  if (expect && Bun.version !== expect) {
    throw new Error(
      `RUNTIME MISMATCH: this is bun ${Bun.version}, the sweep was told to expect ${expect}.\n` +
        "Numbers from two runtimes are not comparable -- rebuild the bench image from the " +
        "same base as the other side, or drop --expect-bun if the change is deliberate.",
    );
  }
}

/**
 * Produce a copy of the index at a different SQLite page size, once, and cache it.
 *
 * `page_size` cannot be changed in place on an existing database -- it is fixed when the first
 * table is created. `VACUUM INTO` is the supported way to rewrite one at a new size, and it
 * also produces a perfectly defragmented, freelist-free file, which is a confound worth naming:
 * a page-size variant compared against a source that has NOT been vacuumed may be winning on
 * the vacuum rather than on the page size. That is what the `page4k-vacuum-cold` cell is for --
 * read the comment on it before interpreting any page-size number.
 *
 * Minutes per variant on a Celeron, and ~2 GB of disk each, so it is done once and reused.
 */
async function pageSizeVariant(source: string, dir: string, pageSize: number): Promise<string> {
  const dest = join(dir, `page-${pageSize}.db`);
  if (existsSync(dest)) {
    console.log(`# page ${pageSize}: reusing ${dest} (${(statSync(dest).size / 1e6).toFixed(0)} MB)`);
    return dest;
  }
  mkdirSync(dir, { recursive: true });
  console.log(`# page ${pageSize}: building variant with VACUUM INTO ...`);
  const t0 = Bun.nanoseconds();
  const { Database } = await import("bun:sqlite");
  const db = new Database(source, { readonly: true });
  // `page_size` must be set on THIS connection before VACUUM INTO -- the target file inherits
  // it. Setting it after, or on the target, silently does nothing and you measure 4K twice.
  db.run(`pragma page_size = ${pageSize}`);
  db.run("vacuum into ?", [dest] as never[]);
  db.close();
  const check = new Database(dest, { readonly: true });
  const got = (check.query("pragma page_size").get() as { page_size: number }).page_size;
  check.close();
  if (got !== pageSize) throw new Error(`asked for page_size ${pageSize}, got ${got}`);
  console.log(
    `# page ${pageSize}: ${(statSync(dest).size / 1e6).toFixed(0)} MB in ` +
      `${((Bun.nanoseconds() - t0) / 1e9).toFixed(1)}s`,
  );
  return dest;
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  if (Bun.argv.includes("--list")) {
    for (const c of CELLS) console.log(`${c.name.padEnd(18)} ${c.what}`);
    return;
  }
  if (!args.source || !args.out || !args.scratch) {
    throw new Error("--source, --out and --scratch are all required");
  }
  assertRuntime(args.expectBun);
  takeLock(args.scratch);
  mkdirSync(args.out, { recursive: true });
  const variantDir = join(args.scratch, "variants");

  const chosen = CELLS.filter((c) => args.cells.includes(c.name));
  console.log(`# sweep: ${chosen.length} cell(s), prefix=${args.prefix}\n`);

  const started = Date.now();
  for (const [i, cell] of chosen.entries()) {
    const label = `${args.prefix}-${cell.name}`;
    const json = join(args.out, `${label}.json`);
    if (existsSync(json)) {
      console.log(`[${i + 1}/${chosen.length}] ${label}: SKIP (already measured)`);
      continue;
    }
    const source = cell.pageSize
      ? await pageSizeVariant(args.source, variantDir, cell.pageSize)
      : args.source;
    console.log(`\n[${i + 1}/${chosen.length}] ${label} -- ${cell.what}`);

    const argv = [
      "bun",
      new URL("./bench-index.ts", import.meta.url).pathname,
      "--source",
      source,
      // Each cell gets its OWN scratch directory. Two cells cannot collide even if somebody
      // runs two sweeps, which is the failure this whole file exists to prevent.
      "--scratch",
      join(args.scratch, label),
      "--label",
      label,
      "--runs",
      String(args.runs),
      "--cold-runs",
      String(args.coldRuns),
      "--json",
      json,
      ...cell.args,
    ];
    const t0 = Date.now();
    const proc = Bun.spawnSync(argv, { stdout: "inherit", stderr: "inherit" });
    if (proc.exitCode !== 0) {
      // Loud, and it does NOT abort the sweep: one bad cell should not cost the other ten
      // hours of measurement, and a missing JSON already means `bench-compare` omits it.
      console.log(`!! ${label} FAILED (exit ${proc.exitCode}) -- continuing with the next cell`);
      continue;
    }
    console.log(`   ${label}: ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  console.log(`\n# sweep finished in ${((Date.now() - started) / 60000).toFixed(1)} min`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
