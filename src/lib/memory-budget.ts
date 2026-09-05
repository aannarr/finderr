/**
 * How much memory this process may actually use, and what to tune from it.
 *
 * > [!IMPORTANT] THIS FILE EXISTS BECAUSE SQLITE CANNOT SEE A CONTAINER'S MEMORY LIMIT
 * > Measured on the live deployment 2026-09-05. The container ran under a **1.5 GB** cgroup cap
 * > while serving an **1,892 MB** index, and was configured with `mmap_size = 2 GB` and
 * > `cache_size = 256 MB` -- told to map more than the whole container could hold, plus a pager
 * > cache worth 17% of the total budget. The cgroup at the time held `cache 898 MB`, `rss 75 MB`:
 * > **only ~47% of the index resident.** The prefault logged *"1892 MB into the page cache"* and
 * > roughly half of it was reclaimed behind the log line.
 * >
 * > Nothing inside SQLite or Bun reads a cgroup limit. `os.totalmem()` reports the HOST's RAM --
 * > 19.8 GB on that machine -- so every default derived from it was wrong by more than 10x. The
 * > fix is not a bigger constant; it is to go and read the limit, which is one file.
 *
 * ## What is derived, and the evidence for each
 *
 * All three come from the 12-cell sweep in `.claude/docs/2026-09-05-storage-profiles-nvme-vs-hdd.md`,
 * run on NVMe and on a nine-disk RAID5 array with the identical index:
 *
 * - **`mmap`**: keep it ON and size it to the budget rather than to a constant. Disabling mmap
 *   measured **41x less block I/O and 2.6x SLOWER** on the array -- the readahead it triggers is
 *   prefetching, not waste -- and **33% slower warm** on NVMe. There is no configuration in which
 *   turning it off won.
 * - **`cache`**: SMALL. 32 MB measured equal-or-better than 256 MB on both machines, and 256 MB is
 *   17% of a 1.5 GB budget spent duplicating pages the mmap already maps.
 * - **`prefault`**: worth up to **32x** on a container's first queries, and it keeps paying LONG
 *   past the point where the index stops fitting -- see `PREFAULT_MIN_RETENTION` below, which is
 *   the one number in this file that a ladder had to be run to find.
 */

import { readFileSync } from "node:fs";
import { totalmem } from "node:os";

/** Where the budget came from, so a log line can explain itself rather than assert a number. */
export type BudgetSource = "cgroup-v2" | "cgroup-v1" | "host-ram" | "configured";

export interface MemoryBudget {
  mb: number;
  source: BudgetSource;
}

/**
 * A cgroup limit expressed as "no limit".
 *
 * cgroup v1 writes a huge sentinel (commonly 2^63-1 rounded to the page size) and v2 writes the
 * literal string `max`. Both mean unlimited, and a naive parse of the v1 sentinel yields ~8
 * exabytes -- which would sail through any plausible sanity check and produce a budget more
 * absurd than the host-RAM answer it replaced. Anything at or above this is treated as absent.
 */
const NO_LIMIT_MB = 1 << 30; // 1 PiB in MB; every real limit is far below this

function readLimitMb(path: string): number | null {
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (raw === "max") return null;
    const bytes = Number(raw);
    if (!Number.isFinite(bytes) || bytes <= 0) return null;
    const mb = Math.floor(bytes / 1024 / 1024);
    return mb >= NO_LIMIT_MB ? null : mb;
  } catch {
    return null;
  }
}

/**
 * The memory ceiling this process is really under.
 *
 * Order matters: cgroup v2, then v1, then the host. A machine running v2 usually still has the v1
 * paths present but empty or meaningless, so asking v1 first can read a stale answer on a modern
 * host. The host RAM fallback is correct for a bare-metal run and is the WRONG answer inside a
 * capped container -- which is exactly why it is last and why the source travels with the number.
 */
export function detectMemoryBudget(override?: number | null): MemoryBudget {
  if (override && override > 0) return { mb: Math.floor(override), source: "configured" };
  const v2 = readLimitMb("/sys/fs/cgroup/memory.max");
  if (v2 !== null) return { mb: v2, source: "cgroup-v2" };
  const v1 = readLimitMb("/sys/fs/cgroup/memory/memory.limit_in_bytes");
  if (v1 !== null) return { mb: v1, source: "cgroup-v1" };
  return { mb: Math.floor(totalmem() / 1024 / 1024), source: "host-ram" };
}

/**
 * What is ACTUALLY resident right now, as the kernel sees it.
 *
 * > [!IMPORTANT] `docker stats` cannot answer this and neither can anything in the process
 * > `docker stats` subtracts `inactive_file` from its usage figure, which is precisely the
 * > page-cache pages the prefault exists to create -- so a container holding 900 MB of index
 * > in cache reports ~75 MB and looks idle. And inside the process, `process.memoryUsage()`
 * > sees only the JS heap and the RSS, never the page cache, which is where the index lives.
 * > The cgroup files are the only place the number exists.
 *
 * The two cgroup generations name the same two quantities differently and both spellings are
 * read: v2 says `file`/`anon` in `memory.stat`, v1 says `cache`/`rss`. Everything is `null`
 * where the kernel does not expose it -- notably PSI, which neither Docker Desktop's VM nor
 * the DSM 4.4 kernel surfaces inside a container. A `0` there would read as "no pressure"
 * when the truth is "cannot see", the same rule `coldIo` follows on macOS.
 */
export interface MemoryUsage {
  /** Total charged to the cgroup: page cache plus anonymous. */
  currentMb: number | null;
  /** Page cache. THE number: how much of the index is actually resident. */
  cacheMb: number | null;
  /** Anonymous memory -- the JS heap and SQLite's own pager cache. */
  rssMb: number | null;
  /** Times an allocation hit the ceiling. Non-zero means the cap is binding, not decorative. */
  failcnt: number | null;
  swapMb: number | null;
  /** `some avg10` from PSI, in percent of wall time stalled on memory. */
  pressureSome10: number | null;
  source: "cgroup-v2" | "cgroup-v1" | null;
}

function readNum(path: string): number | null {
  try {
    const n = Number(readFileSync(path, "utf8").trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function readStat(path: string): Map<string, number> | null {
  try {
    const out = new Map<string, number>();
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const [k, v] = line.split(/\s+/);
      if (k && v !== undefined) out.set(k, Number(v));
    }
    return out;
  } catch {
    return null;
  }
}

/** `some avg10=1.23 ...` -> 1.23. Absent on both kernels that matter here; read anyway. */
function readPressure(path: string): number | null {
  try {
    const m = readFileSync(path, "utf8").match(/^some\s+avg10=([\d.]+)/m);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

const MB = 1024 * 1024;
const toMb = (n: number | undefined | null): number | null =>
  n === undefined || n === null ? null : Math.round(n / MB);

export function readMemoryUsage(): MemoryUsage {
  const v2 = readStat("/sys/fs/cgroup/memory.stat");
  if (v2?.has("file")) {
    const events = readStat("/sys/fs/cgroup/memory.events");
    return {
      currentMb: toMb(readNum("/sys/fs/cgroup/memory.current")),
      cacheMb: toMb(v2.get("file")),
      rssMb: toMb(v2.get("anon")),
      // v2 has no `failcnt`; `memory.events`' `max` counts the same event -- an allocation
      // that reached the ceiling and forced reclaim.
      failcnt: events?.get("max") ?? null,
      swapMb: toMb(readNum("/sys/fs/cgroup/memory.swap.current")),
      pressureSome10: readPressure("/sys/fs/cgroup/memory.pressure"),
      source: "cgroup-v2",
    };
  }
  const v1 = readStat("/sys/fs/cgroup/memory/memory.stat");
  if (v1?.has("cache")) {
    const usage = readNum("/sys/fs/cgroup/memory/memory.usage_in_bytes");
    const memsw = readNum("/sys/fs/cgroup/memory/memory.memsw.usage_in_bytes");
    return {
      currentMb: toMb(usage),
      cacheMb: toMb(v1.get("cache")),
      rssMb: toMb(v1.get("rss")),
      failcnt: readNum("/sys/fs/cgroup/memory/memory.failcnt"),
      // v1 reports memory+swap as one figure, so swap is the difference. Negative is
      // impossible but clamps anyway -- the two files are read a microsecond apart.
      swapMb: memsw !== null && usage !== null ? Math.max(0, toMb(memsw - usage) ?? 0) : null,
      pressureSome10: null,
      source: "cgroup-v1",
    };
  }
  return {
    currentMb: null,
    cacheMb: null,
    rssMb: null,
    failcnt: null,
    swapMb: null,
    pressureSome10: null,
    source: null,
  };
}

/** The resolved read-side settings, and the reasoning, so boot can print both. */
export interface StorageTuning {
  budgetMb: number;
  budgetSource: BudgetSource;
  /** `pragma mmap_size`, in bytes. */
  mmapBytes: number;
  /** `pragma cache_size` magnitude, in KiB (written negative into the pragma). */
  cacheKib: number;
  prefault: boolean;
  /** Human-readable lines explaining every choice, logged once at boot. */
  notes: string[];
}

/**
 * How much of the index must survive the prefault for the prefault to be worth doing.
 *
 * > [!CAUTION] THIS REPLACES A RULE THAT WAS WRONG IN THE DIRECTION NOBODY CHECKED
 * > It was `indexMb <= budgetMb * 0.75` -- "only prefault if the index fits with headroom" --
 * > which demanded a budget **1.33x the index**. It was a guess, it was never measured, and the
 * > ladder refuted it at exactly the case it was written for: at a 1500 MB budget against an
 * > 1,868 MB index (**125% of the budget**, so plainly not fitting) the prefault was still worth
 * > **16x** on a container's first queries. The old rule would have switched it off there.
 * >
 * > The mistake was treating "fits" as the question. A prefault of a file larger than the budget
 * > does not fail -- it fills the budget to the brim and the queries land on whatever survived.
 * > Partial residency is worth almost as much as full residency, right up until it abruptly is
 * > not.
 *
 * ## The measurement
 *
 * One clone, one prefault, then all 29 render-path queries once in order -- the shape a
 * container's first seconds actually have. Nine-disk RAID5 array, 1,868 MB index, and the same
 * crossover reproduced on NVMe at the same ratios:
 *
 * | budget | index/budget | resident after the prefault | first-touch, prefault on | prefault off |
 * |---|---|---|---|---|
 * | 3072 MB | 61% | 99% | 224 ms | 7,195 ms |
 * | 1500 MB | 125% | **79%** | **480 ms** | 7,858 ms |
 * | 1024 MB | 182% | **54%** | 7,865 ms | 7,573 ms |
 *
 * ## Where the knee actually is, and why it is not where the first draft put it
 *
 * Rungs were then run between those two points. The transition is not a slope, it is a **cliff
 * between 79% and 69% retention**, and it reproduced under two different pragma configurations
 * measured hours apart:
 *
 * | retention | budget | first-touch (256 MB pager cache) | first-touch (derived pager cache) |
 * |---|---|---|---|
 * | **79%** | 1500 MB | **342 ms** | **1,106 ms** |
 * | **69%** | 1308 MB | **11,087 ms** | **12,046 ms** |
 * | 64% | 1214 MB | 14,305 ms | 16,656 ms |
 * | 54% | 1024 MB | -- | 20,124 ms |
 * | 33% | 640 MB | -- | 23,780 ms |
 *
 * **0.75, because 0.70 was on the WRONG SIDE of that cliff.** At 0.69 retention the prefault costs
 * 11-12 seconds; a threshold of 0.70 admits exactly that case. 0.75 puts 0.79 on the prefault side
 * and 0.69 on the skip side, which is the whole of the justification and all it needs to be.
 *
 * > [!CAUTION] THE FINE STRUCTURE BELOW THE KNEE IS NOISE. Do not read the last three rows as a trend.
 * > A four-cell sweep varying only `cache_size` at a 1024 MB budget -- 256 / 128 / 50 / 8 MB --
 * > returned **12,483 / 11,925 / 12,532 / 12,695 ms**, flat within 6% across a 32x range. Useful in
 * > itself (see the `cache` note below), but the important part is what it says about repeatability:
 * > `nas3-1024-cache50` and `nas2-1024-pf` are the SAME configuration and measured **12,532 ms and
 * > 20,124 ms**. Six measurements of that one cell span **7,865 to 20,124 ms**.
 * >
 * > So the sub-knee regime carries roughly +-40% run-to-run variance on this array, and the
 * > apparent monotonic decline from 1308 down to 640 sits inside it. **An earlier revision of this
 * > comment claimed prefaulting below the knee is "1.65x SLOWER" than not prefaulting, from a
 * > single pair at each of two budgets. That does not survive the variance and is retracted.**
 * > What is established below the knee: the prefault costs a full sequential read and buys nothing
 * > measurable. Whether it actively hurts is unresolved and would need n>=3 per side.
 * >
 * > The KNEE ITSELF is not in doubt -- 342/1,106 ms against 11,087/12,046 ms is a 10-30x step,
 * > reproduced in two independent runs, an order of magnitude outside that band.
 *
 * Retention is approximated as `budget / index` -- what fraction of the file the budget can hold
 * at all. That is what the cgroup measured at every rung, to within the process's own ~25 MB.
 */
const PREFAULT_MIN_RETENTION = 0.75;

/** Clamp bounds for the pager cache. Below 8 MB SQLite thrashes; above 256 MB nothing improved. */
const CACHE_MIN_MB = 8;
const CACHE_MAX_MB = 256;

/**
 * Resolve every storage setting from the budget and the index size.
 *
 * `indexBytes` may be 0 on a first install, where no index exists yet. That is not a problem to
 * guard around: with no file there is nothing to prefault and nothing to size a map to, and the
 * settings are recomputed when one is adopted.
 */
export function resolveTuning(opts: {
  budget: MemoryBudget;
  indexBytes: number;
  mmapMbOverride?: number | null;
  cacheMbOverride?: number | null;
  prefaultOverride?: boolean | null;
}): StorageTuning {
  const { budget, indexBytes } = opts;
  const indexMb = Math.round(indexBytes / 1e6);
  const notes: string[] = [];
  notes.push(`memory budget ${budget.mb} MB (${budget.source}); index ${indexMb} MB`);

  /*
    MMAP: sized to the WHOLE INDEX, and deliberately NOT capped at the memory budget.

    > [!CAUTION] Capping the map at the budget is a bug, and it is an easy one to talk yourself into
    > This was written as `min(indexMb, budget.mb)` on the reasoning that "stating 2 GB inside a
    > 1.5 GB container is a claim that cannot be honoured". That reasoning confuses two different
    > things. `mmap_size` is ADDRESS SPACE, not memory: the kernel charges a page to the cgroup
    > when it is faulted in, not when it is mapped, and it charges it identically whether it
    > arrived through a mapping or through a `read()`. A 1,868 MB map inside a 512 MB container
    > is not a lie -- it simply means at most 512 MB of it is resident at a time, which was going
    > to be true anyway.
    >
    > What the cap DOES do is real and bad: SQLite reads only the first `mmap_size` bytes through
    > the mapping and falls back to `pread` for everything past it. So a budget-capped map
    > partially disables mmap on exactly the machines that can least afford it -- and turning
    > mmap off entirely measured **2.6x SLOWER cold on a spinning array** and 33% slower warm on
    > NVMe. The cap would have bought nothing and paid a fraction of that penalty.
    >
    > It also gets the memory question backwards: SQLite does NOT copy a mapped page into its own
    > pager cache, so mapping more of the file uses LESS memory, not more.

    The floor of 64 MB is for a fixture or a first install, where the file is a few KB and a map
    sized to it would be pointless. There is no ceiling.
  */
  const mmapMb = Math.max(opts.mmapMbOverride ?? indexMb, opts.mmapMbOverride != null ? 0 : 64);
  notes.push(
    opts.mmapMbOverride != null
      ? `mmap ${mmapMb} MB (FINDERR_SQLITE_MMAP_MB)`
      : `mmap ${mmapMb} MB (the whole index; a map is address space, not resident memory)`,
  );

  /*
    CACHE: small, because it duplicates what mmap already maps -- and now measured under pressure.

    5% of the budget, clamped. The original evidence for a small cache was taken PREFAULTED IN AN
    UNLIMITED CONTAINER, where the whole file is in the page cache and SQLite's own pager cache is
    obviously redundant. That is exactly the condition under which the result was least likely to
    generalise, so it was re-measured where it might not have: a 1024 MB budget against an 1,868 MB
    index, which holds barely half the file.

    | pager cache | first-touch suite |
    |---|---|
    | 256 MB | 12,483 ms |
    | 128 MB | 11,925 ms |
    | 50 MB  | 12,532 ms |
    | 8 MB   | 12,695 ms |

    **Flat within 6% across a 32x range**, under real memory pressure. The finding generalises, and
    every megabyte not spent here is a megabyte holding index pages instead. Note this also makes
    the pager cache a NON-lever for a small deployment: shrinking it further buys nothing.
  */
  const derivedCacheMb = Math.min(CACHE_MAX_MB, Math.max(CACHE_MIN_MB, Math.round(budget.mb * 0.05)));
  const cacheMb = opts.cacheMbOverride ?? derivedCacheMb;
  notes.push(
    opts.cacheMbOverride != null
      ? `cache ${cacheMb} MB (FINDERR_SQLITE_CACHE_MB)`
      : `cache ${cacheMb} MB (5% of budget, clamped to ${CACHE_MIN_MB}-${CACHE_MAX_MB})`,
  );

  /*
    PREFAULT: whenever enough of the file will still be there afterwards.

    NOT "whenever it fits". See `PREFAULT_MIN_RETENTION` -- an index at 125% of the budget still
    retains 79% of itself and the prefault is still worth 16x there. The question is how much
    survives, and the answer stops being useful well below 100%.
  */
  const retention = indexMb === 0 ? 1 : Math.min(1, budget.mb / indexMb);
  const worthIt = retention >= PREFAULT_MIN_RETENTION;
  const prefault = opts.prefaultOverride ?? worthIt;
  const pct = (n: number): string => `${Math.round(n * 100)}%`;
  if (opts.prefaultOverride != null) {
    notes.push(`prefault ${prefault} (FINDERR_INDEX_PREFAULT)`);
    if (prefault && !worthIt) {
      notes.push(
        `  NOTE: prefault forced ON with a ${budget.mb} MB budget against a ${indexMb} MB index, ` +
          `so about ${pct(retention)} of it can stay resident -- below the ${pct(PREFAULT_MIN_RETENTION)} ` +
          "where it stops paying for itself. It costs one full sequential read per boot and per " +
          "index swap and measured no faster than skipping it. Whether it is actively slower is " +
          "unresolved: the measurements below that line carry about +-40% run-to-run variance.",
      );
    }
  } else if (worthIt) {
    notes.push(
      `prefault on: ~${pct(retention)} of the index can stay resident -- worth up to 32x on the ` +
        "first queries after a boot or an index swap",
    );
  } else {
    notes.push(
      `prefault OFF: a ${budget.mb} MB budget holds only ~${pct(retention)} of a ${indexMb} MB index, ` +
        `below the ${pct(PREFAULT_MIN_RETENTION)} where reading it whole stops paying for itself. ` +
        "Pages fault in on demand instead; the steady state is unaffected and the first minute " +
        "after a restart is slower. Raise the memory limit to restore it, or force it with " +
        "FINDERR_INDEX_PREFAULT=true to spend the I/O anyway.",
    );
  }

  return {
    budgetMb: budget.mb,
    budgetSource: budget.source,
    mmapBytes: mmapMb * 1024 * 1024,
    cacheKib: cacheMb * 1024,
    prefault,
    notes,
  };
}
