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
  type CutFinding,
  type CutLookup,
  type CutPointCache,
  cutTimeline,
  findCutPoints,
  keyframeProbeArgs,
  MAX_PROBE_POINTS,
  parseKeyframeTimes,
  probeCutPoints,
  probePoints,
} from "./keyframes";
import type { RangeReader } from "./matroska-cues";
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

/** A file that cannot be opened at all: a share that went away, or a path that never existed. */
const NO_FILE = () => Promise.resolve(null);

/**
 * A file of a given size whose bytes are never touched.
 *
 * Reading it THROWS on purpose: opening is a stat, and every test below that expects a cache
 * hit is also asserting that the hit cost no read of the file it stands in for.
 */
const sizedFile = (size: number) => (): Promise<RangeReader> =>
  Promise.resolve({
    size,
    read: () => Promise.reject(new Error("this test must not read the file")),
  });

/** A container index that answers with these cut points, or with nothing. */
const indexOf = (cuts: number[] | null) => () => Promise.resolve(cuts);

/** The cache, as a Map -- the interface is the seam, so no database is involved. */
class MapCache implements CutPointCache {
  readonly entries = new Map<string, CutFinding>();

  lookup(path: string, size: number): CutLookup {
    const key = `${path}:${size}`;
    return this.entries.has(key)
      ? { known: true, finding: this.entries.get(key) as CutFinding }
      : { known: false };
  }

  remember(path: string, size: number, finding: CutFinding): void {
    this.entries.set(`${path}:${size}`, finding);
  }
}

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
      open: NO_FILE,
    });
    expect(source).toBe("uniform");
    expect(timeline.starts).toEqual([0, 6, 12, 18, 24, 30, 36, 42, 48, 54]);
    expect(run.calls).toHaveLength(0);
  });

  test("a copy follows the source's own keyframes", async () => {
    const { timeline, source } = await cutTimeline("/a.mkv", 60, 6, {
      copiesVideo: true,
      run: runner(SIXTY_FIVE_CSV),
      open: NO_FILE,
    });
    expect(source).toBe("probe");
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
      open: NO_FILE,
    });
    expect(source).toBe("uniform");
    expect(segmentCount(timeline)).toBe(10);
  });

  test("a copy of a file with a readable index never runs ffprobe at all", async () => {
    const run = runner(SIXTY_FIVE_CSV) as ProbeRunner & { calls: string[][] };
    const { timeline, source, cached } = await cutTimeline("/a.mkv", 60, 6, {
      copiesVideo: true,
      run,
      open: sizedFile(1000),
      readIndex: indexOf([12, 30]),
    });
    expect(source).toBe("container");
    expect(cached).toBe(false);
    expect(timeline.starts).toEqual([0, 12, 30]);
    expect(run.calls).toHaveLength(0);
  });
});

describe("findCutPoints walks the three ways in cost order", () => {
  test("the container's own index comes first, and nothing else is asked", async () => {
    const run = runner(SIXTY_FIVE_CSV) as ProbeRunner & { calls: string[][] };
    const found = await findCutPoints("/a.mkv", 60, 6, {
      run,
      open: sizedFile(1000),
      readIndex: indexOf([12, 30]),
    });
    expect(found).toEqual({ cuts: [12, 30], origin: "container", cached: false });
    expect(run.calls).toHaveLength(0);
  });

  /** An MP4, or a Matroska whose Cues we cannot make sense of. */
  test("a file with no readable index falls through to the probe", async () => {
    const found = await findCutPoints("/a.mp4", 60, 6, {
      run: runner(SIXTY_FIVE_CSV),
      open: sizedFile(4096),
      readIndex: indexOf(null),
    });
    expect(found.origin).toBe("probe");
    expect(found.cuts).toEqual([1.001, 11.011, 21.021, 31.031, 35.994, 46.004, 56.014]);
  });

  /** An index that answered nothing is the same disappointment as no index at all. */
  test("an empty index is not an answer", async () => {
    const found = await findCutPoints("/a.mkv", 60, 6, {
      run: runner(SIXTY_FIVE_CSV),
      open: sizedFile(4096),
      readIndex: indexOf([]),
    });
    expect(found.origin).toBe("probe");
  });

  test("a file nothing can open is neither cached nor refused", async () => {
    const cache = new MapCache();
    const found = await findCutPoints("/gone.mkv", 60, 6, {
      run: runner(SIXTY_FIVE_CSV),
      open: NO_FILE,
      cache,
    });
    expect(found.origin).toBe("probe");
    expect(cache.entries.size).toBe(0);
  });

  test("an open that throws is a fallback, not a failed playback", async () => {
    const found = await findCutPoints("/a.mkv", 60, 6, {
      run: runner(SIXTY_FIVE_CSV),
      open: () => Promise.reject(new Error("EIO")),
    });
    expect(found.origin).toBe("probe");
  });
});

describe("the cache remembers what a file answered", () => {
  /** `sizedFile` throws on any read, so a hit that touched the file would fail here. */
  test("a second play reads the answer instead of the file", async () => {
    const cache = new MapCache();
    const first = await findCutPoints("/a.mkv", 60, 6, {
      open: sizedFile(1000),
      readIndex: indexOf([12, 30]),
      cache,
    });
    expect(first).toEqual({ cuts: [12, 30], origin: "container", cached: false });

    const second = await findCutPoints("/a.mkv", 60, 6, {
      open: sizedFile(1000),
      readIndex: (reader) => reader.read(0, 1).then(() => null),
      cache,
    });
    expect(second).toEqual({ cuts: [12, 30], origin: "container", cached: true });
  });

  /** Re-running a 30 s probe timeout on every play of the same title is the same waste twice. */
  test("finding nothing is remembered too", async () => {
    const cache = new MapCache();
    const run = runner("", false) as ProbeRunner & { calls: string[][] };
    const deps = { run, open: sizedFile(4096), readIndex: indexOf(null), cache };
    expect((await findCutPoints("/a.mp4", 60, 6, deps)).cuts).toBeNull();

    expect(await findCutPoints("/a.mp4", 60, 6, deps)).toEqual({ cuts: null, origin: null, cached: true });
    expect(run.calls).toHaveLength(1);
  });

  /**
   * The arr stack replaces a file in place -- download the better release, verify, delete -- so
   * a boundary remembered from the old one would be a boundary the new file cannot honour.
   */
  test("a file that changed size is a miss, not a stale answer", async () => {
    const cache = new MapCache();
    await findCutPoints("/a.mkv", 60, 6, { open: sizedFile(1000), readIndex: indexOf([12, 30]), cache });
    const after = await findCutPoints("/a.mkv", 60, 6, {
      open: sizedFile(2000),
      readIndex: indexOf([18, 42]),
      cache,
    });
    expect(after).toEqual({ cuts: [18, 42], origin: "container", cached: false });
  });
});
