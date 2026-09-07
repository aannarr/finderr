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
 * module never scans. It asks ffprobe for ONE packet at each of a few hundred points, in a
 * single process, and each answer is a real keyframe near that point.
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

/** Where a timeline's boundaries came from. Reported to the reader, never used to decide. */
export type CutSource = "keyframes" | "uniform";

/**
 * The timeline for one file: the cheapest honest answer available for it.
 *
 * Three cases, and they are the whole decision:
 *
 * - **A re-encode gets a uniform grid.** It makes its own keyframes, so every boundary on
 *   the grid is a place it can genuinely start, and no probe is needed at all.
 * - **A copy gets the probed keyframes**, because they are the only places it can be cut.
 * - **A copy whose probe found nothing falls back to the grid**, and that degrades rather
 *   than breaks. A copy-mode seek already lands at the container's index granularity BEFORE
 *   where it was asked to, never after, so a segment produced for a grid boundary covers its
 *   whole declared range and some of the one before it. The player resolves the overlap; the
 *   cost is re-reading a few seconds per segment. Refusing to play would be the worse trade.
 */
export async function cutTimeline(
  path: string,
  durationSec: number,
  segmentSec: number,
  opts: { copiesVideo: boolean; run?: ProbeRunner; timeoutMs?: number },
): Promise<{ timeline: Timeline; source: CutSource }> {
  if (!opts.copiesVideo) {
    return { timeline: uniformTimeline(durationSec, segmentSec), source: "uniform" };
  }
  const cuts = await probeCutPoints(path, durationSec, segmentSec, opts.run, opts.timeoutMs);
  if (!cuts) return { timeline: uniformTimeline(durationSec, segmentSec), source: "uniform" };
  return { timeline: timelineFrom(durationSec, segmentSec, cuts), source: "keyframes" };
}
