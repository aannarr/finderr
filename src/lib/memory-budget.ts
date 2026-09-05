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
 * - **`prefault`**: worth **205x** cold when the budget can hold the file, and actively wasteful
 *   when it cannot -- reading 1.9 GB into a 512 MB cgroup evicts as it goes and ends with an
 *   arbitrary last-512-MB resident. So it is a decision, not a constant.
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
 * How much of the budget the index may occupy before a full prefault stops being a good idea.
 *
 * The process needs headroom for the JS heap, the app database, the poster cache and the
 * request path -- measured at ~75 MB RSS on the live deployment, but a spike during a facet warm
 * is larger. Prefaulting right up to the ceiling means the last pages read evict the first ones,
 * so the read completes, reports success, and leaves an arbitrary subset resident.
 *
 * 0.75 is a judgement, not a measurement, and it is deliberately conservative: the cost of
 * prefaulting when it does not fit is wasted I/O and a misleading log line, while the cost of
 * NOT prefaulting when it would have fitted is bounded and visible. `FINDERR_INDEX_PREFAULT`
 * overrides it in either direction.
 */
const PREFAULT_BUDGET_FRACTION = 0.75;

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
    PREFAULT: only when the file can actually stay resident.

    This is the setting the whole file exists for. Reading 1.9 GB into a container that can hold
    1.1 GB of it does not warm the cache, it churns it -- and the warm loop's own log line would
    still say "1892 MB into the page cache", which is how the live deployment looked healthy
    while serving half its index off the array.
  */
  const fits = indexMb === 0 || indexMb <= budget.mb * PREFAULT_BUDGET_FRACTION;
  const prefault = opts.prefaultOverride ?? fits;
  if (opts.prefaultOverride != null) {
    notes.push(`prefault ${prefault} (FINDERR_INDEX_PREFAULT)`);
    if (prefault && !fits) {
      notes.push(
        `  WARNING: prefault forced ON but the index (${indexMb} MB) exceeds ` +
          `${Math.round(PREFAULT_BUDGET_FRACTION * 100)}% of the ${budget.mb} MB budget -- ` +
          "it will read the whole file and evict most of it. Expect wasted I/O, not a warm cache.",
      );
    }
  } else if (fits) {
    notes.push(`prefault on (index fits the budget) -- worth ~205x on first reads from a slow disk`);
  } else {
    notes.push(
      `prefault OFF: the index (${indexMb} MB) does not fit ` +
        `${Math.round(PREFAULT_BUDGET_FRACTION * 100)}% of the ${budget.mb} MB budget. ` +
        "Reads will fault pages in on demand. Raise the container memory limit to restore it.",
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
