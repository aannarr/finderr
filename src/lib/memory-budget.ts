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
 * So the threshold is on RETENTION, not on fit, and it sits between 54% and 79%. **0.7 is chosen
 * inside that band and deliberately toward the low end**, because the two errors are wildly
 * asymmetric: prefaulting when it will not pay wastes one background sequential read that no
 * user waits on, while NOT prefaulting when it would have paid costs 16x on every first query a
 * real person makes. Err toward reading.
 *
 * Retention is approximated as `budget / index` -- what fraction of the file the budget can hold
 * at all. That is what the cgroup measured at every rung, to within the process's own ~25 MB.
 */
const PREFAULT_MIN_RETENTION = 0.7;

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
    MMAP: sized to the index, capped at the budget, never a constant.

    A map larger than the file is only address space and costs nothing -- but stating 2 GB inside
    a 1.5 GB container is a claim that cannot be honoured, and it is what made the old default
    read as deliberate when it was merely stale. Sizing it to the file says what is meant, and
    capping at the budget means the number is never a lie.
  */
  let mmapMb = opts.mmapMbOverride ?? Math.min(Math.max(indexMb, 64), budget.mb);
  if (opts.mmapMbOverride != null) {
    notes.push(`mmap ${mmapMb} MB (FINDERR_SQLITE_MMAP_MB)`);
  } else {
    notes.push(`mmap ${mmapMb} MB (index size, capped at the budget)`);
  }
  if (mmapMb < 0) mmapMb = 0;

  /*
    CACHE: small, because it duplicates what mmap already maps.

    5% of the budget, clamped. At 1.5 GB that is 75 MB against the 256 MB that used to ship, and
    the 32 MB cell measured equal-or-better than 256 MB on both machines -- so this is the
    cautious end of the evidence rather than the aggressive one.
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
          "where reading it stopped paying for itself. It costs one full sequential read per boot " +
          "and per index swap, and measured no faster than not doing it. Harmless, just not free.",
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
