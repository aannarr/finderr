/**
 * Turning a window of playback cost into numbers a reader and a chart can both use.
 *
 * Everything here is pure and unit-free of React, so the rules that decide what a bar MEANS are
 * assertable without rendering anything -- the same split `episode-scores.ts` keeps from
 * `EpisodeScores.tsx`, which is this tree's only other chart.
 *
 * ## Two derived units, and both are chosen so a number answers a question
 *
 * A slice holds totals -- bytes handed out, milliseconds burned -- and totals are not
 * comparable to anything. **BYTES BECOME A RATE** (`B/s`), which is what "is this saturating the
 * link" is asked in, and **MILLISECONDS BECOME CORES** (`cpuMs / elapsed`), which is what the
 * NAS question is asked in: the deployment box is a four-core Celeron J4125, and "1.25 cores"
 * says immediately what "37,500 ms" does not.
 */

import { formatBytes } from "./units";

/** One bar of the chart, in the SVG's own coordinate space. */
export interface Bar {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Bytes handed out per second inside a slice that covers `seconds`. */
export function bytesPerSecond(bytes: number, seconds: number): number {
  return seconds > 0 ? bytes / seconds : 0;
}

/**
 * How many whole cores `cpuMs` of CPU amounts to over `seconds` of wall clock.
 *
 * One over a period is "this used one core solidly". Above one means several children ran at
 * once, which is the case the NAS deploy cares about and the one a single hand measurement at
 * deploy time cannot catch.
 */
export function coresUsed(cpuMs: number, seconds: number): number {
  return seconds > 0 ? cpuMs / 1000 / seconds : 0;
}

/** The largest value in a series, or zero for an empty or all-zero one. */
export function peak(values: readonly number[]): number {
  let most = 0;
  for (const v of values) if (v > most) most = v;
  return most;
}

/**
 * Lay a series out as adjacent bars filling the box, oldest at the left.
 *
 * NO GAP between them, deliberately: at two hours of thirty-second slices there are 240, so a
 * gap would be most of the picture. Adjacent they read as a filled area over time, which is what
 * a rate is.
 *
 * > [!IMPORTANT] A NON-ZERO VALUE IS NEVER DRAWN AS ZERO HEIGHT
 * > A slice holding a single small segment against a peak two orders of magnitude higher rounds
 * > to nothing, and a chart that draws "a little" identically to "none" is a chart that lies in
 * > the one direction an operator would act on. So anything above zero gets at least a pixel.
 *
 * `max` is passed in rather than derived, so two charts can be drawn against a shared scale if
 * a caller ever wants that, and so a caller that has already computed the peak for a label does
 * not compute it twice.
 */
export function bars(values: readonly number[], box: { width: number; height: number; max: number }): Bar[] {
  const width = values.length > 0 ? box.width / values.length : 0;
  return values.map((value, i) => {
    const scaled = box.max > 0 ? (value / box.max) * box.height : 0;
    const height = value > 0 ? Math.max(1, scaled) : 0;
    return { x: i * width, y: box.height - height, width, height };
  });
}

/**
 * The whole series as ONE filled SVG path: a step area across the top of the bars.
 *
 * One element rather than 240 `<rect>`s, and that is a readability decision before it is a
 * performance one -- a list of shapes keyed by their position in the window is a list whose key
 * carries no meaning, and every reviewer of it has to work out that the index really is the
 * identity. A path has no keys to explain.
 *
 * It walks the floor at the left, steps along the top of each bar, and closes back along the
 * floor -- so an empty stretch is genuinely flat rather than absent.
 */
export function barsPath(drawn: readonly Bar[], height: number): string {
  if (drawn.length === 0) return "";
  const steps = drawn.map(
    (b) => `L${b.x.toFixed(2)},${b.y.toFixed(2)} L${(b.x + b.width).toFixed(2)},${b.y.toFixed(2)}`,
  );
  const right = (drawn[drawn.length - 1]?.x ?? 0) + (drawn[drawn.length - 1]?.width ?? 0);
  return `M0,${height} ${steps.join(" ")} L${right.toFixed(2)},${height} Z`;
}

/** `12 MB/s`. The `/s` is part of the value, because a rate without it is a size. */
export function formatRate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

/**
 * `1.25 cores`, or `none` when nothing transcoded.
 *
 * Two decimals below ten, because the interesting range is fractions of one core -- `0.70` is
 * the measured cost of a single 720p re-encode on the J4125, and rounding it to `1` would erase
 * the whole scale the number exists to show.
 */
export function formatCores(cores: number): string {
  if (!(cores > 0)) return "none";
  if (cores < 0.01) return "<0.01 cores";
  return `${cores < 10 ? cores.toFixed(2) : Math.round(cores)} cores`;
}

/**
 * `12.4 s of CPU`, `3.5 min of CPU` -- what ONE session has burned in total.
 *
 * A TOTAL rather than the `formatCores` rate the charts use, and the difference is the question.
 * A chart slice covers a known stretch of wall clock, so a rate is meaningful there; a session
 * has been running for a length nobody asked about, and dividing by it would answer "how hard
 * was this session working on average" -- which is a smaller number for a long quiet playback
 * than for a short furious one, and reads as the opposite of what it is.
 */
export function formatCpuTime(cpuMs: number): string {
  if (!(cpuMs > 0)) return "no CPU";
  if (cpuMs < 1000) return "<1 s of CPU";
  if (cpuMs < 90_000) return `${(cpuMs / 1000).toFixed(1)} s of CPU`;
  return `${(cpuMs / 60_000).toFixed(1)} min of CPU`;
}

/** `2 hours`, `30 minutes` -- how far back a window reaches, to one unit. */
export function windowLength(seconds: number): string {
  const hours = seconds / 3600;
  if (hours >= 1) return hours === 1 ? "1 hour" : `${Math.round(hours)} hours`;
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}
