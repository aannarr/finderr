/**
 * The four filesystem primitives every benchmark in this repo needs, owned once.
 *
 * Split out of `../jobs/bench-index.ts` when `../jobs/bench-memory.ts` became the second
 * caller. It could not simply be imported from there: that file calls `main()` at module
 * scope, so an import of it RUNS a benchmark. Each of these carries a trap that was paid for
 * on real hardware, and a second copy of any of them would be a second place to relearn it.
 */

import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

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
        "Point it at a copy. With no explicit target the harness clones data/titles.db for you.",
    );
  }
}

/**
 * A copy-on-write clone where the filesystem has one, a real copy where it does not.
 *
 * > [!IMPORTANT] The reflink is what makes a per-scenario COLD measurement affordable
 * > Cold is measured against a fresh clone -- a new inode the page cache has never read.
 * > At 730 MB to 2.3 GB each, a real copy would mean tens of gigabytes of writes per run,
 * > and the copying would dwarf what is being measured. A reflink is instant and costs no
 * > space until something writes to it.
 *
 * BOTH spellings are tried, because the two filesystems that matter here disagree: macOS
 * APFS takes `cp -c`, and the deployment's btrfs takes `cp --reflink`. Trying only the Mac's
 * spelling meant the array fell silently through to copying the whole file per scenario, onto
 * the slowest storage in the system.
 *
 * `--reflink=always` rather than `auto` on purpose: `auto` falls back to a full copy INSIDE
 * `cp` and reports success, so the slow path would be taken with nothing to show for it.
 */
export async function cloneIndex(src: string, dest: string): Promise<"reflink" | "copy"> {
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
 * Bytes this process has actually pulled off the BLOCK DEVICE, or null where unknowable.
 *
 * `/proc/self/io`'s `read_bytes` counts what went to the storage layer, so it is zero for a
 * read served from the page cache and non-zero only for real I/O. That is the single most
 * direct answer to "did this query touch the disk?".
 *
 * **Linux only, and deliberately null rather than 0 on macOS.** A zero would read as "no I/O
 * happened", which is the opposite of "we cannot see".
 *
 * It is also PER PROCESS and cumulative, so only a delta across a measured section means
 * anything, and a concurrent read elsewhere in this process would pollute it. Every harness
 * here is single-threaded and does nothing else while measuring.
 */
export function ioReadBytes(): number | null {
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
 * The same thing `warmPageCache` does in `../server/live-index.ts` -- streamed rather than
 * read whole, because `arrayBuffer()` would hold the entire index in the JS heap at once,
 * which is the failure mode the whole prefault exists to avoid re-creating.
 *
 * Reproduced rather than imported from the holder, which is a private method on a class that
 * owns a live index and would drag the whole holder into a bench process.
 */
export async function prefaultFile(path: string): Promise<{ mb: number; ms: number }> {
  const t0 = Bun.nanoseconds();
  let bytes = 0;
  for await (const chunk of Bun.file(path).stream()) bytes += chunk.length;
  return { mb: bytes / 1e6, ms: (Bun.nanoseconds() - t0) / 1e6 };
}
