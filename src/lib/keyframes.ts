/**
 * Where a file can be cut without re-encoding it, learned cheaply enough to do at click time.
 *
 * A copied video stream can only be split on a keyframe, so `hls-timeline.ts` needs to know
 * where the keyframes are before it can state an honest playlist. The obvious way to find
 * them is to enumerate every packet -- and that reads the whole file.
 *
 * ## MEASURED on the NAS, over the array, 2026-09-08
 *
 * | | full packet scan | sparse seek probe, 200 points |
 * |---|---|---|
 * | 3.4 GB 2160p HEVC | **13.4 s** | **0.08 s** |
 * | 6.9 GB 1080p h264 | **42.0 s** | -- |
 *
 * The full scan is I/O bound at roughly 165 MB/s and is simply not available to a click.
 * `ffmpeg -discard nokey` does not help: measured 10.1 s on the same file, because discarding
 * happens after the bytes have been read. What IS free is SEEKING, because every container
 * this library uses carries an index -- Matroska's Cues, MP4's sync sample table. So this
 * module never scans.
 *
 * ## THREE WAYS TO LEARN THE SAME FACT, IN COST ORDER -- see `findCutPoints`
 *
 * | | what it costs |
 * |---|---|
 * | the cache (`keyframe-cache.ts`) | one indexed read, and it is right until the file changes |
 * | the container's own index (`matroska-cues.ts`) | 4-53 ms, measured on files this library holds |
 * | the ffprobe seek probe, below | 0.47 s warm, **64.28 s cold**, against a 30 s timeout |
 *
 * The probe was the only one of the three until 2026-09-08, and it is still the fallback that
 * makes the other two optional: an MP4, a Matroska with no Cues, a file whose index we cannot
 * make sense of. It asks ffprobe for ONE packet at each of a few hundred points, in a single
 * process, and each answer is a real keyframe near that point.
 *
 * > [!CAUTION] THE COLD CASE IS NOT RARE AND THE CACHE DOES NOT COVER IT
 * > The 64 s / 0.47 s split above is cold-vs-warm PAGE CACHE rather than first-vs-later play,
 * > and this container is capped below the size of its own index, so a file read last night is
 * > cold again tonight. The cache makes the SECOND play free; only reading the container's own
 * > index makes the FIRST one cheap. Measure them separately or a green cache hides a broken
 * > reader.
 *
 * > [!IMPORTANT] THIS IS A SUBSET OF THE KEYFRAMES AND THAT IS DELIBERATE, NOT A SHORTCUT
 * > A probe every `spacingSec` finds the keyframe nearest each probe point and misses any
 * > others in between. That is harmless HERE and would be fatal in the other design: a
 * > server that runs one long ffmpeg has to PREDICT which keyframes the muxer will cut at,
 * > and a missing one desynchronises the rest of the film. Producing each segment from its
 * > own bounded ffmpeg run needs no prediction -- it only needs boundaries that are real,
 * > and every point this returns is real.
 *
 * > [!CAUTION] A COPY-MODE SEEK LANDS AT THE CONTAINER'S INDEX GRANULARITY, NOT THE KEYFRAME
 * > Measured on the same file: `ffmpeg -ss 3998.244` -- an exact keyframe timestamp --
 * > produced output starting at 3990.486, the beginning of the Matroska cluster holding it.
 * > ffprobe's own seek to the same timestamp lands exactly, because ffprobe discards the
 * > packets in between and a stream copy cannot. So these cut points make segments SHORTER
 * > and their coverage complete; they do not make the seek exact. A produced segment may
 * > begin earlier than its boundary, never later, which is why the design tolerates overlap.
 */

import { type Timeline, timelineFrom, uniformTimeline } from "./hls-timeline";
import { openFileRange, type RangeReader, readContainerCutPoints } from "./matroska-cues";
import { type ProbeRunner, spawnFfprobe } from "./media-probe";

/** How long the whole keyframe probe may take before the caller gives up on it. */
export const KEYFRAME_PROBE_TIMEOUT_MS = 30_000;

/**
 * The most points one probe will ask about.
 *
 * Each point is a seek, and seeks are cheap but not free. A three-hour film probed every six
 * seconds wants 1800 of them; this caps the work at a bounded number and widens the spacing
 * instead, which costs nothing but slightly longer segments on a very long title.
 */
export const MAX_PROBE_POINTS = 1200;

/**
 * The ffprobe invocation, as an argv.
 *
 * Exported so a test can assert the flags without spawning anything. `%+#1` reads exactly ONE
 * packet after seeking, which is what keeps this a seek rather than a read.
 */
export function keyframeProbeArgs(path: string, points: readonly number[]): string[] {
  return [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "packet=pts_time,flags",
    "-of",
    "csv=p=0",
    "-read_intervals",
    points.map((t) => `${t.toFixed(3)}%+#1`).join(","),
    path,
  ];
}

/**
 * The probe points: `spacingSec` apart, never more than `MAX_PROBE_POINTS` of them.
 *
 * Starts at one spacing in rather than at 0, because 0 is already a boundary by construction
 * and probing it would only ever return the first keyframe of the file.
 */
export function probePoints(durationSec: number, spacingSec: number): number[] {
  if (!(durationSec > 0) || !(spacingSec > 0)) return [];
  const step = Math.max(spacingSec, durationSec / MAX_PROBE_POINTS);
  const points: number[] = [];
  for (let t = step; t < durationSec; t += step) points.push(t);
  return points;
}

/**
 * Parse ffprobe's CSV into ascending, unique keyframe times.
 *
 * PURE and exported, because this is where the surprises are. A row without the `K` flag is
 * dropped rather than trusted: a seek landing on a non-key packet would be a cut point that
 * cannot be cut, and one bad boundary is worse than a coarser timeline.
 */
export function parseKeyframeTimes(csv: string): number[] {
  const seen = new Set<number>();
  for (const line of csv.split("\n")) {
    const [pts, flags] = line.trim().split(",");
    if (!pts || !flags?.includes("K")) continue;
    const t = Number(pts);
    if (Number.isFinite(t) && t > 0) seen.add(t);
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * Where this file can be cut, or null when we could not find out.
 *
 * Null is a first-class answer and the caller has a good move for it: a re-encode makes its
 * own keyframes, so a uniform grid is exactly right there. It is only a copy that needs this,
 * and a copy of a file with no usable index is rare enough to be worth degrading rather than
 * refusing.
 */
export async function probeCutPoints(
  path: string,
  durationSec: number,
  spacingSec: number,
  run: ProbeRunner = spawnFfprobe,
  timeoutMs: number = KEYFRAME_PROBE_TIMEOUT_MS,
): Promise<number[] | null> {
  const points = probePoints(durationSec, spacingSec);
  if (points.length === 0) return null;
  const res = await run(keyframeProbeArgs(path, points), timeoutMs);
  if (!res.ok) return null;
  const times = parseKeyframeTimes(res.stdout);
  return times.length > 0 ? times : null;
}

/**
 * How a file's cut points were found. Two ways, and they cost three orders of magnitude apart.
 *
 * - `container` -- the file's own index, read directly. Milliseconds, and it works cold.
 * - `probe` -- up to 1200 ffprobe seeks. Free on a warm file, a minute on a cold one, and the
 *   fallback for anything whose index we cannot read.
 */
export type CutOrigin = "container" | "probe";

/** Where a timeline's boundaries came from. Reported to the reader, never used to decide. */
export type CutSource = CutOrigin | "uniform";

/**
 * What was learned about one file: where it can be cut and how we found out, or nothing usable.
 *
 * Null is a real, cacheable answer -- see `CutPointCache`.
 */
export type CutFinding = { cuts: readonly number[]; origin: CutOrigin } | null;

/** What the cache had to say. `known: false` is a miss, which is not the same as "nothing there". */
export type CutLookup = { known: false } | { known: true; finding: CutFinding };

/**
 * Remembering what a file answered, so the next play of it costs nothing.
 *
 * DECLARED HERE, BY THE CONSUMER, and implemented in `keyframe-cache.ts`. This module has no
 * business knowing about SQLite, and the store has no business knowing what a cut point is
 * for; the interface is the seam, and it is what lets every test in this file run against a
 * Map instead of a database.
 *
 * **The key is `path` plus `size`**, and the size is what makes it correct: the arr stack's
 * rule is replacement-first -- download the better file, verify it, then delete -- so a title's
 * file being REPLACED is the normal case here rather than an edge, and a replacement is a
 * different size. A stale cut point is worse than none, because it puts a boundary in the
 * playlist that the file cannot honour, silently.
 */
export interface CutPointCache {
  lookup(path: string, size: number): CutLookup;
  remember(path: string, size: number, finding: CutFinding): void;
}

/** Everything the search for cut points needs from the world, so a test can supply all of it. */
export interface CutPointDeps {
  /** How ffprobe is run, when it comes to that. */
  run?: ProbeRunner;
  timeoutMs?: number;
  /**
   * How a file is opened. Null means it cannot be read at all.
   *
   * Opening is a STAT and nothing more, which matters: the size it yields is half the cache
   * key, so it has to be known before the cache can be asked -- and a cache hit must not have
   * cost a read of the file it is standing in for.
   */
  open?: (path: string) => Promise<RangeReader | null>;
  /** How the container's own index is read out of an open file. */
  readIndex?: (reader: RangeReader) => Promise<number[] | null>;
  /** Where answers are remembered. Absent means every play measures the file again. */
  cache?: CutPointCache;
}

/** What the search found, and how much it cost to find out. */
export interface CutPoints {
  cuts: number[] | null;
  /** Null when nothing usable was found, in which case the caller wants a uniform grid. */
  origin: CutOrigin | null;
  /** True when this came out of the cache. The reader is told, so a broken reader cannot hide. */
  cached: boolean;
}

/**
 * Where this file can be cut: remembered, then read out of the container, then probed.
 *
 * The three steps are in cost order and each one is hundreds of times cheaper than the next,
 * which is the whole design:
 *
 * 1. **The cache** answers in microseconds and is right until the file changes.
 * 2. **The container's own index** is a couple of reads -- measured at 4-53 ms on files whose
 *    ffprobe probe timed out at 30 s over the same transport.
 * 3. **The ffprobe probe** is the fallback for an MP4, a Matroska with no Cues, or anything
 *    else this cannot read. It is what shipped before and it still works.
 *
 * A file that cannot be opened at all skips straight to step 3 and is not cached: without a
 * size there is no honest key to cache it under, and a key that cannot notice a replacement is
 * how a stale index gets served.
 */
export async function findCutPoints(
  path: string,
  durationSec: number,
  spacingSec: number,
  deps: CutPointDeps = {},
): Promise<CutPoints> {
  const reader = await openQuietly(path, deps.open ?? openFileRange);
  // No file means no size, and no size means no honest cache key -- a key that cannot notice a
  // replaced release is how a stale cut point gets served.
  const cache = reader ? deps.cache : undefined;
  const size = reader?.size ?? 0;

  const hit = cache?.lookup(path, size);
  if (hit?.known) {
    const cuts = hit.finding ? [...hit.finding.cuts] : null;
    return { cuts, origin: hit.finding?.origin ?? null, cached: true };
  }

  const found = reader ? await (deps.readIndex ?? readContainerCutPoints)(reader) : null;
  if (found && found.length > 0) {
    cache?.remember(path, size, { cuts: found, origin: "container" });
    return { cuts: found, origin: "container", cached: false };
  }

  const probed = await probeCutPoints(path, durationSec, spacingSec, deps.run, deps.timeoutMs);
  cache?.remember(path, size, probed ? { cuts: probed, origin: "probe" } : null);
  return { cuts: probed, origin: probed ? "probe" : null, cached: false };
}

/** Opening a file is I/O, and a media share having a bad moment is not worth a stack trace. */
async function openQuietly(
  path: string,
  open: (path: string) => Promise<RangeReader | null>,
): Promise<RangeReader | null> {
  try {
    return await open(path);
  } catch {
    return null;
  }
}

/**
 * The timeline for one file: the cheapest honest answer available for it.
 *
 * Three cases, and they are the whole decision:
 *
 * - **A re-encode gets a uniform grid.** It makes its own keyframes, so every boundary on
 *   the grid is a place it can genuinely start, and nothing needs to be read at all.
 * - **A copy gets the file's real cut points**, because they are the only places it can be
 *   cut. `findCutPoints` decides how much it costs to learn them.
 * - **A copy whose search found nothing falls back to the grid**, and that degrades rather
 *   than breaks. A copy-mode seek already lands at the container's index granularity BEFORE
 *   where it was asked to, never after, so a segment produced for a grid boundary covers its
 *   whole declared range and some of the one before it. The player resolves the overlap; the
 *   cost is re-reading a few seconds per segment. Refusing to play would be the worse trade.
 */
export async function cutTimeline(
  path: string,
  durationSec: number,
  segmentSec: number,
  opts: CutPointDeps & { copiesVideo: boolean },
): Promise<{ timeline: Timeline; source: CutSource; cached: boolean }> {
  if (!opts.copiesVideo) {
    return { timeline: uniformTimeline(durationSec, segmentSec), source: "uniform", cached: false };
  }
  const found = await findCutPoints(path, durationSec, segmentSec, opts);
  if (!found.cuts || !found.origin) {
    return { timeline: uniformTimeline(durationSec, segmentSec), source: "uniform", cached: found.cached };
  }
  return {
    timeline: timelineFrom(durationSec, segmentSec, found.cuts),
    source: found.origin,
    cached: found.cached,
  };
}
