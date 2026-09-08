/**
 * The rules that decide what a bar MEANS, without rendering anything.
 *
 * The one worth the most is the minimum height: a chart that draws "a little" and "none" as the
 * same picture is wrong in the one direction an operator would act on, and it is invisible in a
 * screenshot -- which is exactly the kind of thing a test can hold and an eye cannot.
 */

import { describe, expect, test } from "bun:test";
import {
  bars,
  barsPath,
  bytesPerSecond,
  coresUsed,
  formatCores,
  formatCpuTime,
  formatRate,
  peak,
  windowLength,
} from "./cost-chart";

const BOX = { width: 100, height: 50, max: 10 };

describe("turning totals into rates", () => {
  test("bytes over a slice become bytes per second", () => {
    expect(bytesPerSecond(3_000, 30)).toBe(100);
  });

  test("a second of CPU over a second of wall clock is one core", () => {
    expect(coresUsed(1_000, 1)).toBe(1);
  });

  /** Above one is several children at once, which is the case a one-shot measurement misses. */
  test("more CPU than wall clock is more than one core", () => {
    expect(coresUsed(37_500, 30)).toBe(1.25);
  });

  test("a zero-length period is zero rather than infinity", () => {
    expect(bytesPerSecond(1_000, 0)).toBe(0);
    expect(coresUsed(1_000, 0)).toBe(0);
  });
});

describe("laying a series out as bars", () => {
  test("bars fill the box edge to edge, oldest at the left", () => {
    const drawn = bars([10, 10, 10, 10], BOX);
    expect(drawn).toHaveLength(4);
    expect(drawn[0]?.x).toBe(0);
    expect(drawn[0]?.width).toBe(25);
    expect(drawn[3]?.x).toBe(75);
    // No gap: the last bar's right edge is the box's right edge.
    expect((drawn[3]?.x ?? 0) + (drawn[3]?.width ?? 0)).toBe(BOX.width);
  });

  test("a bar is measured from the bottom, and the peak fills the height", () => {
    const [full, half] = bars([10, 5], BOX);
    expect(full).toMatchObject({ y: 0, height: 50 });
    expect(half).toMatchObject({ y: 25, height: 25 });
  });

  test("a zero slice draws nothing at all", () => {
    expect(bars([0], BOX)[0]).toMatchObject({ height: 0, y: 50 });
  });

  /**
   * A single small segment against a peak two orders of magnitude higher rounds to nothing, and
   * a chart that draws it identically to an idle minute is a chart that hides the one thing an
   * operator is looking for.
   */
  test("a value too small to round to a pixel is still drawn as one", () => {
    const [tiny] = bars([0.0001], BOX);
    expect(tiny?.height).toBe(1);
    expect(tiny?.y).toBe(49);
  });

  test("a series with nothing in it divides by nothing", () => {
    expect(bars([0, 0], { ...BOX, max: 0 }).every((b) => b.height === 0)).toBe(true);
    expect(bars([], BOX)).toEqual([]);
  });

  test("peak is the largest value, and zero for an empty series", () => {
    expect(peak([1, 9, 4])).toBe(9);
    expect(peak([])).toBe(0);
    expect(peak([0, 0])).toBe(0);
  });
});

describe("the series as one path", () => {
  test("it starts and ends on the floor, so the shape is closed", () => {
    const d = barsPath(bars([10, 0], BOX), BOX.height);
    expect(d.startsWith("M0,50 ")).toBe(true);
    expect(d.endsWith("L100.00,50 Z")).toBe(true);
  });

  test("each bar contributes a flat top: two points at the same height", () => {
    expect(barsPath(bars([10, 5], BOX), BOX.height)).toBe(
      "M0,50 L0.00,0.00 L50.00,0.00 L50.00,25.00 L100.00,25.00 L100.00,50 Z",
    );
  });

  test("an empty series draws nothing at all rather than a stray floor", () => {
    expect(barsPath([], BOX.height)).toBe("");
  });
});

describe("wording a measurement", () => {
  test("a rate carries its per-second, because a rate without it is a size", () => {
    expect(formatRate(12_000_000)).toBe("12 MB/s");
  });

  /**
   * Two decimals below ten: 0.70 is the measured cost of one 720p re-encode on the J4125, and
   * rounding it to 1 would erase the entire scale this number exists to show.
   */
  test("cores keep the fractions that matter and lose the ones that do not", () => {
    expect(formatCores(0.7)).toBe("0.70 cores");
    expect(formatCores(1.25)).toBe("1.25 cores");
    expect(formatCores(12.4)).toBe("12 cores");
  });

  test("no CPU at all says so rather than reading as a measured zero", () => {
    expect(formatCores(0)).toBe("none");
    expect(formatCores(0.0001)).toBe("<0.01 cores");
  });

  test("one session's CPU is a total, in the unit its size deserves", () => {
    expect(formatCpuTime(0)).toBe("no CPU");
    expect(formatCpuTime(400)).toBe("<1 s of CPU");
    expect(formatCpuTime(12_400)).toBe("12.4 s of CPU");
    expect(formatCpuTime(210_000)).toBe("3.5 min of CPU");
  });

  test("a window is stated to one unit", () => {
    expect(windowLength(7_200)).toBe("2 hours");
    expect(windowLength(3_600)).toBe("1 hour");
    expect(windowLength(1_800)).toBe("30 minutes");
    expect(windowLength(60)).toBe("1 minute");
  });
});
