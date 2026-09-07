/**
 * The keyframe probe, against ffprobe output RECORDED FROM A REAL FILE.
 *
 * `SIXTY_FIVE_CSV` is verbatim output from `ffprobe -read_intervals` over
 * `65 (2023)` on the NAS on 2026-09-08, and its shapes are the ones that matter: a
 * DUPLICATE, because two neighbouring probe points landed on the same keyframe when the GOP
 * is longer than the spacing, and the `K__` flag spelling that is not simply `K`.
 */

import { describe, expect, test } from "bun:test";
import { segmentCount } from "./hls-timeline";
import {
  cutTimeline,
  keyframeProbeArgs,
  MAX_PROBE_POINTS,
  parseKeyframeTimes,
  probeCutPoints,
  probePoints,
} from "./keyframes";
import type { ProbeRunner } from "./media-probe";

const SIXTY_FIVE_CSV = [
  "0.000000,K__",
  "1.001000,K__",
  "11.011000,K__",
  "11.011000,K__",
  "21.021000,K__",
  "31.031000,K__",
  "35.994000,K__",
  "46.004000,K__",
  "56.014000,K__",
  "",
].join("\n");

const runner = (out: string, ok = true): ProbeRunner => {
  const calls: string[][] = [];
  const run: ProbeRunner = async (argv) => {
    calls.push(argv);
    return { ok, stdout: out, stderr: "" };
  };
  return Object.assign(run, { calls });
};

describe("the probe asks for one packet per point, which is what keeps it a seek", () => {
  test("every interval reads exactly one packet", () => {
    const a = keyframeProbeArgs("/plex/a.mkv", [10, 20]);
    expect(a[a.indexOf("-read_intervals") + 1]).toBe("10.000%+#1,20.000%+#1");
  });

  test("it looks at the first video stream and nothing else", () => {
    const a = keyframeProbeArgs("/plex/a.mkv", [10]).join(" ");
    expect(a).toContain("-select_streams v:0");
    expect(a).toContain("packet=pts_time,flags");
  });

  test("the path is the last argument, so a name starting with a dash is not a flag", () => {
    expect(keyframeProbeArgs("/plex/-weird.mkv", [1]).at(-1)).toBe("/plex/-weird.mkv");
  });
});

describe("the probe points", () => {
  test("they are one spacing apart and never include zero", () => {
    expect(probePoints(30, 6)).toEqual([6, 12, 18, 24]);
  });

  /** Each point is a seek. A long film gets coarser spacing rather than unbounded work. */
  test("a very long title widens the spacing instead of asking for more points", () => {
    const points = probePoints(40 * 60 * 60, 6);
    expect(points.length).toBeLessThanOrEqual(MAX_PROBE_POINTS);
    expect(points[1] - points[0]).toBeGreaterThan(6);
  });

  test("a title with no length has nothing to probe", () => {
    expect(probePoints(0, 6)).toEqual([]);
    expect(probePoints(60, 0)).toEqual([]);
  });
});

describe("parsing what ffprobe answered", () => {
  test("duplicates collapse and the result is ascending", () => {
    expect(parseKeyframeTimes(SIXTY_FIVE_CSV)).toEqual([
      1.001, 11.011, 21.021, 31.031, 35.994, 46.004, 56.014,
    ]);
  });

  /**
   * A seek that lands on a non-key packet would be a cut point that cannot be cut, and one
   * bad boundary is worse than a coarser timeline.
   */
  test("a packet that is not a keyframe is dropped rather than trusted", () => {
    expect(parseKeyframeTimes("12.000000,__\n24.000000,K__")).toEqual([24]);
  });

  test("blank lines and unparseable times are ignored", () => {
    expect(parseKeyframeTimes("\nN/A,K__\n\n8.000000,K__\n")).toEqual([8]);
  });

  test("nothing usable is an empty list rather than a throw", () => {
    expect(parseKeyframeTimes("")).toEqual([]);
  });
});

describe("probeCutPoints", () => {
  test("a failed ffprobe is null, not an empty list", async () => {
    expect(await probeCutPoints("/a.mkv", 60, 6, runner("", false))).toBeNull();
  });

  test("output with no keyframe in it is null too", async () => {
    expect(await probeCutPoints("/a.mkv", 60, 6, runner("12.0,__"))).toBeNull();
  });

  test("a title with no length is not probed at all", async () => {
    const run = runner(SIXTY_FIVE_CSV) as ProbeRunner & { calls: string[][] };
    expect(await probeCutPoints("/a.mkv", 0, 6, run)).toBeNull();
    expect(run.calls).toHaveLength(0);
  });
});

describe("cutTimeline picks the cheapest honest answer", () => {
  /** A re-encode makes its own keyframes, so probing the source would answer nothing. */
  test("a re-encode gets an exact grid and is never probed", async () => {
    const run = runner(SIXTY_FIVE_CSV) as ProbeRunner & { calls: string[][] };
    const { timeline, source } = await cutTimeline("/a.mkv", 60, 6, {
      copiesVideo: false,
      run,
    });
    expect(source).toBe("uniform");
    expect(timeline.starts).toEqual([0, 6, 12, 18, 24, 30, 36, 42, 48, 54]);
    expect(run.calls).toHaveLength(0);
  });

  test("a copy follows the source's own keyframes", async () => {
    const { timeline, source } = await cutTimeline("/a.mkv", 60, 6, {
      copiesVideo: true,
      run: runner(SIXTY_FIVE_CSV),
    });
    expect(source).toBe("keyframes");
    expect(timeline.starts).toEqual([0, 11.011, 21.021, 31.031, 46.004, 56.014]);
  });

  /**
   * A copy whose probe found nothing DEGRADES rather than refusing. A copy-mode seek already
   * lands before where it was asked to and never after, so a grid boundary still yields a
   * segment covering its whole declared range -- at the cost of re-reading a few seconds.
   */
  test("a copy whose probe failed falls back to the grid rather than refusing", async () => {
    const { timeline, source } = await cutTimeline("/a.mkv", 60, 6, {
      copiesVideo: true,
      run: runner("", false),
    });
    expect(source).toBe("uniform");
    expect(segmentCount(timeline)).toBe(10);
  });
});
