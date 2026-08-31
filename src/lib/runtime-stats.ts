/**
 * Runtime resource telemetry: what this process is doing to the machine.
 *
 * This exists because on 2026-08-30 finderr sat at 20% of a core and 94% of its
 * memory limit while completely idle, and nothing in the logs said so. The only
 * signal the app emitted was "1371 movies mirrored" once a minute. Answering "why"
 * took a manual dig through `/sys/fs/cgroup` and the per-thread `stat` files under
 * `/proc/<pid>/task` -- data
 * the process could have been reporting about itself all along.
 *
 * Three rules this module follows, because they are what made the dig necessary:
 *
 *  - REPORT THE LIMIT, NOT JUST THE USAGE. "1.4 GB of heap" is meaningless; "1.4 GB
 *    against a 1.5 GB cgroup ceiling" is the whole diagnosis. A number without its
 *    ceiling cannot be triaged from a log line.
 *  - REPORT GC SEPARATELY FROM WORK. JSC does its marking on `HeapHelper` threads, so
 *    process-wide CPU hides the split. Two HeapHelpers at 14.5% next to a main thread
 *    at 2.9% says "garbage collector"; a single "29%" says nothing.
 *  - ASKING MUST NOT DO THE WORK. Every reader here is a plain read of /proc or
 *    /sys. Nothing allocates a pool, forces a collection, or touches the network --
 *    same rule `FacetResolver.outstanding()` follows.
 *
 * Everything is Linux-specific and every reader degrades to `null` off Linux, so the
 * same code runs on the Mac dev box and in the container without a branch at a call site.
 */

import { readdirSync, readFileSync } from "node:fs";

const isLinux = process.platform === "linux";

/** Kernel clock ticks per second. Effectively always 100 on Linux. */
const HZ = 100;

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function firstNumber(path: string): number | null {
  const raw = readOrNull(path);
  if (raw === null) return null;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isNaN(n) ? null : n;
}

// ---------------------------------------------------------------------------
// cgroup: the ceiling this process is actually judged against
// ---------------------------------------------------------------------------

export interface CgroupMemory {
  /** Bytes charged to this container right now. */
  current: number;
  /** The hard ceiling. `null` when unlimited (`max`). */
  limit: number | null;
  /** `current / limit`, 0-1. `null` when unlimited. */
  ratio: number | null;
  /** Anonymous memory -- the JS heap. This is the number that matters. */
  anon: number | null;
  /** Page cache. Squeezed toward zero when anon grows, which is how a big heap
   *  starves SQLite of the index cache and turns reads into disk I/O. */
  file: number | null;
  /**
   * How many times the container has hit its ceiling and been forced into direct
   * reclaim. A non-zero and RISING value is the single clearest "the limit is too
   * low, or the heap is too big" signal there is.
   */
  maxEvents: number | null;
  /** File pages evicted and immediately faulted back in -- cache thrashing. */
  refaultFile: number | null;
}

export function cgroupMemory(): CgroupMemory | null {
  if (!isLinux) return null;
  const current = firstNumber("/sys/fs/cgroup/memory.current");
  if (current === null) return null;

  const rawMax = readOrNull("/sys/fs/cgroup/memory.max")?.trim();
  const limit = rawMax && rawMax !== "max" ? Number.parseInt(rawMax, 10) : null;

  const stat = readOrNull("/sys/fs/cgroup/memory.stat") ?? "";
  const field = (name: string): number | null => {
    const m = stat.match(new RegExp(`^${name} (\\d+)$`, "m"));
    return m ? Number.parseInt(m[1], 10) : null;
  };

  const events = readOrNull("/sys/fs/cgroup/memory.events") ?? "";
  const maxMatch = events.match(/^max (\d+)$/m);

  return {
    current,
    limit,
    ratio: limit ? current / limit : null,
    anon: field("anon"),
    file: field("file"),
    maxEvents: maxMatch ? Number.parseInt(maxMatch[1], 10) : null,
    refaultFile: field("workingset_refault_file"),
  };
}

// ---------------------------------------------------------------------------
// Threads: where the CPU actually goes
// ---------------------------------------------------------------------------

export interface ThreadCpu {
  tid: number;
  name: string;
  /** Cumulative CPU seconds (user + system) for this thread. */
  seconds: number;
}

/**
 * Per-thread cumulative CPU.
 *
 * The point is the thread NAMES. JSC marks on threads called `HeapHelper`, so a
 * caller can attribute cost to garbage collection without a profiler -- which is
 * exactly the question process-wide CPU cannot answer.
 */
export function threadCpu(): ThreadCpu[] | null {
  if (!isLinux) return null;
  let tids: string[];
  try {
    tids = readdirSync("/proc/self/task");
  } catch {
    return null;
  }
  const out: ThreadCpu[] = [];
  for (const tid of tids) {
    const stat = readOrNull(`/proc/self/task/${tid}/stat`);
    if (!stat) continue;
    // Field 2 is `(comm)` and may contain spaces, so split after the closing paren.
    const close = stat.lastIndexOf(")");
    const name = stat.slice(stat.indexOf("(") + 1, close);
    const rest = stat.slice(close + 2).split(" ");
    // After comm and state, field 14 (utime) is index 11, field 15 (stime) is 12.
    const utime = Number(rest[11] ?? 0);
    const stime = Number(rest[12] ?? 0);
    out.push({ tid: Number(tid), name, seconds: (utime + stime) / HZ });
  }
  return out;
}

/** Cumulative CPU seconds spent on JSC's GC marking threads. */
export function gcThreadSeconds(threads: ThreadCpu[] | null): number | null {
  if (!threads) return null;
  return threads
    .filter((t) => /heaphelper|marking|collector/i.test(t.name))
    .reduce((n, t) => n + t.seconds, 0);
}

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

export interface RuntimeSnapshot {
  uptimeSeconds: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  cgroup: CgroupMemory | null;
  /** Cumulative process CPU seconds, and the GC share of it. */
  cpu: { totalSeconds: number; gcSeconds: number | null; threads: ThreadCpu[] | null };
}

export function snapshot(): RuntimeSnapshot {
  const mem = process.memoryUsage();
  const threads = threadCpu();
  const usage = process.cpuUsage();
  return {
    uptimeSeconds: process.uptime(),
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    cgroup: cgroupMemory(),
    cpu: {
      totalSeconds: (usage.user + usage.system) / 1e6,
      gcSeconds: gcThreadSeconds(threads),
      threads,
    },
  };
}

// ---------------------------------------------------------------------------
// The periodic log line
// ---------------------------------------------------------------------------

const mb = (n: number) => `${(n / 1048576).toFixed(0)}MB`;
const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

/**
 * A monitor that logs a one-line resource summary on an interval, reporting RATES
 * rather than the cumulative counters /proc hands out.
 *
 * Rates are the whole point: "cpu 20% (gc 15%)" is triageable at a glance, whereas
 * "utime 378008" requires two samples and arithmetic, which is what nobody does at
 * 2am. The line is deliberately one line and deliberately boring, so a human
 * scrolling `docker logs` sees the shape change even when they are not looking for it.
 */
export class ResourceMonitor {
  private prev: RuntimeSnapshot | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private log: (m: string) => void,
    private extra: () => string = () => "",
  ) {}

  /** One line describing the interval since the previous call. */
  line(): string {
    const now = snapshot();
    const prev = this.prev;
    this.prev = now;

    const parts: string[] = [];

    if (prev) {
      const dt = now.uptimeSeconds - prev.uptimeSeconds;
      if (dt > 0) {
        const cpu = (now.cpu.totalSeconds - prev.cpu.totalSeconds) / dt;
        const gc =
          now.cpu.gcSeconds !== null && prev.cpu.gcSeconds !== null
            ? (now.cpu.gcSeconds - prev.cpu.gcSeconds) / dt
            : null;
        parts.push(gc !== null ? `cpu ${pct(cpu)} (gc ${pct(gc)})` : `cpu ${pct(cpu)}`);
      }
    }

    parts.push(`rss ${mb(now.rss)}`, `heap ${mb(now.heapUsed)}`);

    const cg = now.cgroup;
    if (cg) {
      // The ceiling travels with the usage -- a bare byte count cannot be triaged.
      parts.push(
        cg.limit
          ? `cgroup ${mb(cg.current)}/${mb(cg.limit)} ${pct(cg.ratio ?? 0)}`
          : `cgroup ${mb(cg.current)}`,
      );
      if (cg.anon !== null && cg.file !== null) parts.push(`anon ${mb(cg.anon)} file ${mb(cg.file)}`);
      // Rising `max` events mean the container keeps hitting its ceiling. Print the
      // DELTA, because the cumulative number looks alarming forever after one spike.
      if (cg.maxEvents !== null) {
        const d = prev?.cgroup?.maxEvents != null ? cg.maxEvents - prev.cgroup.maxEvents : cg.maxEvents;
        if (d > 0) parts.push(`AT-LIMIT x${d}`);
      }
    }

    const extra = this.extra();
    if (extra) parts.push(extra);

    return `resources: ${parts.join("  ")}`;
  }

  start(everyMs: number): void {
    if (this.timer) return;
    this.line(); // prime `prev` so the first logged line carries a real rate
    this.timer = setInterval(() => this.log(this.line()), everyMs);
    // Never hold the process open for a log line.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
