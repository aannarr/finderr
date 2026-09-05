/**
 * What happens to the index as the memory budget shrinks below it.
 *
 * ```bash
 * bun src/jobs/bench-memory.ts --source /bench/titles.db --scratch /bench/mem/512-pf \
 *     --label nas-512-pf --prefault --json /bench/results/nas-512-pf.json
 * ```
 *
 * ## Why this is a second harness and not another `bench-index` flag
 *
 * `bench-index.ts` measures a scenario cold by giving it **its own fresh reflink clone**, so a
 * 29-scenario suite makes 58 clones and, with `--prefault`, performs 58 separate whole-file
 * reads. That is exactly right for its question -- *what does one query cost against a
 * never-read inode* -- and it is exactly wrong for this one.
 *
 * Production reads ONE file. It prefaults it ONCE and then serves everything from whatever
 * survived. Under a cap smaller than the index, "whatever survived" is the entire subject:
 * the pages a query wants may or may not still be there, the kernel evicts on its own policy,
 * and a **later query benefits from what an earlier one faulted in**. A per-scenario fresh
 * clone destroys all three effects -- every scenario starts from an identical, arbitrary,
 * last-N-MB-of-the-file residency and nothing accumulates.
 *
 * So this harness has one clone, one prefault, and one pass over the suite in order. Each
 * scenario's FIRST-TOUCH time and I/O are recorded as it happens, which makes the pass a
 * ledger of a container's first seconds rather than 29 independent coin flips. The warm loop
 * runs afterwards, over the same handle, and answers the other half: once the working set has
 * been touched, does the cap still cost anything?
 *
 * ## Read `firstTouch` and `warm` as two different questions
 *
 * - `firstTouch` is the boot experience. It is where a too-small cap shows up as real I/O.
 * - `warm` is the steady state. A cap that hurts here is evicting the WORKING SET, which is a
 *   far more serious finding than a slow first minute -- it means every user pays forever.
 *
 * `residency` is sampled at four points, because the interesting number is not any one of
 * them but the DROP from `afterPrefault` to `afterSuite`: that is the page cache being
 * reclaimed under the cap, and it is the mechanism nothing in the deployment reported.
 */

import { rmSync, statSync } from "node:fs";
import { hostname, totalmem } from "node:os";
import { join } from "node:path";
import { assertNotLiveIndex, cloneIndex, ioReadBytes, prefaultFile } from "../lib/bench-io";
import { type BenchFixtures, type Scenario, scenarios } from "../lib/bench-scenarios";
import { loadConfig } from "../lib/config";
import { detectMemoryBudget, type MemoryUsage, readMemoryUsage } from "../lib/memory-budget";
import { SearchEngine } from "../lib/search";

interface Args {
  source: string;
  scratch: string;
  label: string;
  json: string | null;
  runs: number;
  prefault: boolean;
  mmap: number | null;
  cache: number | null;
  keep: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    source: "",
    scratch: "",
    label: "",
    json: null,
    runs: 20,
    prefault: false,
    mmap: null,
    cache: null,
    keep: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--source") out.source = argv[++i] ?? "";
    else if (a === "--scratch") out.scratch = argv[++i] ?? "";
    else if (a === "--label") out.label = argv[++i] ?? "";
    else if (a === "--json") out.json = argv[++i] ?? null;
    else if (a === "--runs") out.runs = Number(argv[++i]);
    else if (a === "--prefault") out.prefault = true;
    else if (a === "--mmap") out.mmap = Number(argv[++i]);
    else if (a === "--cache") out.cache = Number(argv[++i]);
    else if (a === "--keep") out.keep = true;
  }
  if (!out.source || !out.scratch) throw new Error("--source and --scratch are required");
  if (!out.label) out.label = `${hostname()}${out.prefault ? "-pf" : "-cold"}`;
  return out;
}

function openEngine(path: string, cfg: ReturnType<typeof loadConfig>, args: Args): SearchEngine {
  const engine = new SearchEngine(path, cfg);
  if (args.mmap !== null) engine.rawDb.run(`pragma mmap_size = ${args.mmap}`);
  if (args.cache !== null) engine.rawDb.run(`pragma cache_size = -${args.cache}`);
  engine.prepareFuzzy(() => {});
  return engine;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
}

interface Row {
  id: string;
  surface: string;
  /** The very first execution against this file, in order. The boot experience.  */
  firstTouchMs: number;
  /** Bytes off the device during that first touch. The column that explains the time. */
  firstTouchIo: number | null;
  p50: number;
  p99: number;
  max: number;
  rows: number;
}

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

function fmtUsage(u: MemoryUsage): string {
  const n = (v: number | null, unit = "MB"): string => (v === null ? "?" : `${v}${unit}`);
  return `cache=${n(u.cacheMb)} rss=${n(u.rssMb)} total=${n(u.currentMb)} swap=${n(u.swapMb)} failcnt=${n(u.failcnt, "")}`;
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const cfg = loadConfig();
  const budget = detectMemoryBudget();
  const dbPath = join(args.scratch, "titles.db");
  assertNotLiveIndex(dbPath);

  console.log(`# label: ${args.label}`);
  console.log(
    `# host: ${hostname()} ${process.platform}/${process.arch} ${navigator.hardwareConcurrency}cpu ` +
      `hostram=${Math.round(totalmem() / 1e6)}MB bun=${Bun.version}`,
  );
  console.log(`# budget: ${budget.mb} MB (${budget.source})`);

  process.stdout.write(`# cloning ${args.source} ... `);
  const t0 = Bun.nanoseconds();
  const how = await cloneIndex(args.source, dbPath);
  console.log(`${how}, ${((Bun.nanoseconds() - t0) / 1e6).toFixed(0)} ms`);
  const indexMb = Math.round(statSync(dbPath).size / 1e6);
  console.log(`# index: ${indexMb} MB  ratio index/budget = ${(indexMb / budget.mb).toFixed(2)}`);

  const residency: Record<string, MemoryUsage> = { atStart: readMemoryUsage() };
  console.log(`# residency atStart:       ${fmtUsage(residency.atStart)}`);

  /*
    THE PREFAULT, ONCE, exactly as `warmPageCache` does it at boot -- a streaming read of the
    whole file with the chunks discarded. `readMb` is what the loop counted, and it is
    DELIBERATELY reported beside the residency that follows it: the live deployment's log line
    said "1892 MB into the page cache" while roughly half of it had already been reclaimed
    behind the line, and the two numbers side by side are the whole point of this harness.
  */
  let prefaultMs: number | null = null;
  let prefaultReadMb: number | null = null;
  let prefaultIo: number | null = null;
  if (args.prefault) {
    const io0 = ioReadBytes();
    const p = await prefaultFile(dbPath);
    prefaultMs = p.ms;
    prefaultReadMb = p.mb;
    const io1 = ioReadBytes();
    if (io0 !== null && io1 !== null) prefaultIo = io1 - io0;
    console.log(
      `# prefault: read ${prefaultReadMb.toFixed(0)} MB in ${(prefaultMs / 1000).toFixed(2)}s ` +
        `(${(prefaultReadMb / (prefaultMs / 1000)).toFixed(0)} MB/s)` +
        (prefaultIo === null ? "" : `, ${(prefaultIo / 1e6).toFixed(0)} MB off the device`),
    );
    residency.afterPrefault = readMemoryUsage();
    console.log(`# residency afterPrefault: ${fmtUsage(residency.afterPrefault)}`);
    /*
      HOW MUCH OF WHAT WE READ IS STILL THERE. This single ratio is the finding the whole
      exercise turns on: a prefault under a cap smaller than the index does not fail, it
      succeeds and is then partly undone, and nothing in the process can tell.
    */
    const kept = residency.afterPrefault.cacheMb;
    if (kept !== null) {
      console.log(
        `# prefault RETENTION: ${kept} MB of ${prefaultReadMb.toFixed(0)} MB still resident ` +
          `(${((kept / prefaultReadMb) * 100).toFixed(0)}%)`,
      );
    }
  }

  const engine = openEngine(dbPath, cfg, args);
  const meta = engine.meta();

  /*
    FIXTURES COME OFF THE SOURCE FILE, NOT OFF THE CLONE, and that is not fussiness.

    Resolving them needs four real queries -- `topRated`, a `browse`, a `personPage`, a
    `topGenres` -- and running those against the clone would fault their pages in BEFORE the
    first-touch pass that is supposed to be measuring exactly that. Three scenarios
    (`discover.topRated`, `discover.topGenres`, `person.page`) would report a warm number in a
    column labelled cold.

    The source is a different INODE, so its page cache is a different set of pages and reading
    it cannot warm the clone. It is opened read-only and closed immediately; nothing writes to
    a `titles.db` after it is promoted, so this is safe even against a live file.

    The runs on 2026-09-05 predate this and resolved fixtures from the clone. The flaw is a
    CONSTANT across every cell, so every comparison in that ladder stands -- but the absolute
    first-touch figure for those three scenarios is understated there.
  */
  const fx = new SearchEngine(args.source, cfg);
  const top = fx.topRated({ limit: 1 })[0];
  const series = fx.browse({ kind: "tvSeries", sort: "votes", limit: 1 }).rows[0];
  const fixtures: BenchFixtures = {
    tconst: top?.tconst ?? "tt0111161",
    seriesTconst: series?.tconst ?? "tt0944947",
    nconst: fx.personPage("nm0000138") ? "nm0000138" : "nm0000199",
    genre: fx.topGenres(1)[0] ?? "Drama",
  };
  fx.close();
  residency.afterOpen = readMemoryUsage();

  /*
    PASS ONE: every scenario ONCE, in order, first touch. Nothing is discarded and nothing is
    repeated -- this is a ledger of the first seconds of a container's life, and re-running a
    scenario before recording it would warm the very pages being measured.
  */
  const all: Scenario[] = scenarios(fixtures);
  const rows: Row[] = [];
  const firstTouch: { id: string; ms: number; io: number | null }[] = [];
  for (const s of all) {
    const i0 = ioReadBytes();
    const t = Bun.nanoseconds();
    s.run(engine);
    const ms = (Bun.nanoseconds() - t) / 1e6;
    const i1 = ioReadBytes();
    firstTouch.push({ id: s.id, ms, io: i0 !== null && i1 !== null ? i1 - i0 : null });
  }
  residency.afterFirstTouch = readMemoryUsage();

  // PASS TWO: the warm loop, same handle, same order. The steady state.
  for (const [i, s] of all.entries()) {
    const times: number[] = [];
    let last: unknown;
    for (let r = 0; r < args.runs; r++) {
      const t = Bun.nanoseconds();
      last = s.run(engine);
      times.push((Bun.nanoseconds() - t) / 1e6);
    }
    times.sort((a, b) => a - b);
    const ft = firstTouch[i];
    rows.push({
      id: s.id,
      surface: s.surface,
      firstTouchMs: ft?.ms ?? 0,
      firstTouchIo: ft?.io ?? null,
      p50: quantile(times, 0.5),
      p99: quantile(times, 0.99),
      max: times[times.length - 1] ?? 0,
      rows: countRows(last),
    });
  }
  residency.afterSuite = readMemoryUsage();

  report(rows, residency, args, indexMb, budget.mb);

  if (args.json) {
    await Bun.write(
      args.json,
      JSON.stringify(
        {
          label: args.label,
          stamp: {
            host: hostname(),
            platform: process.platform,
            arch: process.arch,
            cpus: navigator.hardwareConcurrency,
            hostMemMb: Math.round(totalmem() / 1e6),
            bun: Bun.version,
            indexMb,
          },
          budgetMb: budget.mb,
          budgetSource: budget.source,
          pragmas: { mmap: args.mmap, cache: args.cache },
          prefault: args.prefault,
          prefaultMs,
          prefaultReadMb,
          prefaultIo,
          residency,
          meta,
          fixtures,
          runs: args.runs,
          results: rows,
        },
        null,
        2,
      ),
    );
    console.log(`\nwrote ${args.json}`);
  }
  engine.close();
  if (!args.keep) rmSync(dbPath, { force: true });
}

function report(
  rows: Row[],
  residency: Record<string, MemoryUsage>,
  args: Args,
  indexMb: number,
  budgetMb: number,
): void {
  const anyIo = rows.some((r) => r.firstTouchIo !== null);
  console.log(
    `\n${"scenario".padEnd(26)}${"first".padStart(11)}${anyIo ? "firstIO".padStart(11) : ""}` +
      `${"p50".padStart(9)}${"p99".padStart(9)}${"max".padStart(9)}${"rows".padStart(7)}`,
  );
  console.log("-".repeat(anyIo ? 82 : 71));
  for (const r of [...rows].sort((a, b) => b.firstTouchMs - a.firstTouchMs)) {
    const io = anyIo
      ? (r.firstTouchIo === null ? "-" : `${(r.firstTouchIo / 1e6).toFixed(1)}MB`).padStart(11)
      : "";
    console.log(
      `${r.id.padEnd(26)}${r.firstTouchMs.toFixed(1).padStart(11)}${io}` +
        `${r.p50.toFixed(2).padStart(9)}${r.p99.toFixed(2).padStart(9)}${r.max.toFixed(2).padStart(9)}` +
        `${String(r.rows).padStart(7)}`,
    );
  }

  const sumFirst = rows.reduce((a, r) => a + r.firstTouchMs, 0);
  const sumWarm = rows.reduce((a, r) => a + r.p50, 0);
  const sumIo = rows.reduce((a, r) => a + (r.firstTouchIo ?? 0), 0);
  console.log(
    `\nSUITE  first-touch ${sumFirst.toFixed(0)} ms | warm ${sumWarm.toFixed(1)} ms` +
      (anyIo ? ` | first-touch I/O ${(sumIo / 1e6).toFixed(0)} MB` : ""),
  );
  console.log(
    `CELL   budget ${budgetMb} MB | index ${indexMb} MB (${((indexMb / budgetMb) * 100).toFixed(0)}% of budget) ` +
      `| prefault ${args.prefault}`,
  );
  console.log("\nresidency through the run:");
  for (const [phase, u] of Object.entries(residency)) console.log(`  ${phase.padEnd(16)} ${fmtUsage(u)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
