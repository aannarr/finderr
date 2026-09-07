/**
 * The timeline, against the two segmentation regimes that actually exist.
 *
 * The numbers in the copy-mode cases are REAL keyframe timestamps, read off two library files
 * on 2026-09-08 -- a 2160p HEVC file whose GOP is ten seconds and a 1080p h264 file whose
 * keyframes are two seconds apart. They are here rather than round invented numbers because
 * the property under test is precisely that the timeline does not round: a boundary that is
 * not a real cut point is a playlist that lies.
 */

import { describe, expect, test } from "bun:test";
import {
  INIT_FILE_NAME,
  SEGMENT_FILE_PATTERN,
  SEGMENT_TARGET_SEC,
  segmentCount,
  segmentFileName,
  segmentRange,
  type Timeline,
  timelineFrom,
  uniformTimeline,
  vodPlaylist,
} from "./hls-timeline";

/** `65 (2023)`: a ten-second GOP with scene cuts in between, from ffprobe. */
const LONG_GOP = [1.001, 11.011, 21.021, 31.031, 35.994, 46.004, 56.014];

/** `80 for Brady (2023)`: keyframes every 2.002 s, from ffprobe. */
const SHORT_GOP = Array.from({ length: 30 }, (_, i) => (i + 1) * 2.002);

describe("a timeline is built only from places the file can be cut", () => {
  test("it starts at zero without being told to", () => {
    expect(timelineFrom(60, 6, []).starts).toEqual([0]);
  });

  /**
   * A ten-second GOP asked for six-second segments gets ten-second segments, and that is the
   * honest answer rather than a failure. Rounding to six would name boundaries the copy
   * cannot cut at.
   */
  test("a source coarser than the target yields the source's own boundaries", () => {
    const t = timelineFrom(60, 6, LONG_GOP);
    expect(t.starts).toEqual([0, 11.011, 21.021, 31.031, 46.004, 56.014]);
    expect(segmentRange(t, 1)).toEqual({ startSec: 11.011, endSec: 21.021 });
  });

  /**
   * 35.994 is a scene-cut keyframe 4.963 s after the previous boundary. Taking it would make
   * a segment shorter than asked for, so the greedy rule skips it and takes 46.004 -- which
   * is why the rule is "at least segmentSec" rather than "nearest".
   */
  test("a cut point closer than the target is skipped rather than taken", () => {
    expect(timelineFrom(60, 6, LONG_GOP).starts).not.toContain(35.994);
  });

  test("a source finer than the target is thinned to roughly the target", () => {
    const t = timelineFrom(60, 6, SHORT_GOP);
    for (let i = 0; i < segmentCount(t) - 1; i++) {
      const r = segmentRange(t, i) as { startSec: number; endSec: number };
      expect(r.endSec - r.startSec).toBeGreaterThanOrEqual(SEGMENT_TARGET_SEC);
      expect(r.endSec - r.startSec).toBeLessThan(SEGMENT_TARGET_SEC + 2.002);
    }
  });

  /**
   * A cut point a hair before the end would cost a whole ffmpeg run and a round trip to
   * deliver a few frames nobody can perceive.
   */
  test("a tail shorter than a second is folded into the segment before it", () => {
    const t = timelineFrom(56.5, 6, LONG_GOP);
    expect(t.starts).not.toContain(56.014);
    expect(segmentRange(t, segmentCount(t) - 1)?.endSec).toBe(56.5);
  });

  test("cut points past the end are dropped and unsorted input is sorted", () => {
    const t = timelineFrom(30, 6, [21.021, 999, 11.011, -4]);
    expect(t.starts).toEqual([0, 11.011, 21.021]);
  });

  test("the segments partition the whole runtime with no gap and no overlap", () => {
    const t = timelineFrom(120, 6, SHORT_GOP);
    let cursor = 0;
    for (let i = 0; i < segmentCount(t); i++) {
      const r = segmentRange(t, i) as { startSec: number; endSec: number };
      expect(r.startSec).toBe(cursor);
      cursor = r.endSec;
    }
    expect(cursor).toBe(t.endSec);
  });

  test("an index outside the timeline has no range", () => {
    const t = uniformTimeline(60, 6);
    expect(segmentRange(t, segmentCount(t))).toBeNull();
    expect(segmentRange(t, -1)).toBeNull();
  });

  test("a file with no stated length is one empty segment rather than a crash", () => {
    expect(timelineFrom(0, 6, SHORT_GOP)).toEqual({ starts: [0], endSec: 0 });
  });
});

/** A re-encode makes its own keyframes, so every point on the grid is a real cut point. */
describe("a re-encode gets an exact grid", () => {
  test("segments are the target length, and the last one is whatever is left", () => {
    const t = uniformTimeline(20, 6);
    expect(t.starts).toEqual([0, 6, 12, 18]);
    expect(segmentRange(t, 3)).toEqual({ startSec: 18, endSec: 20 });
  });

  test("a runtime shorter than one segment is a single segment", () => {
    expect(uniformTimeline(4, 6).starts).toEqual([0]);
  });
});

describe("the VOD playlist", () => {
  const t: Timeline = timelineFrom(60, 6, LONG_GOP);
  const text = vodPlaylist(t);

  /**
   * `EXT-X-ENDLIST` is what makes this VOD rather than live: the player stops polling, trusts
   * the total duration, and enables the whole scrub bar. Without it there is nothing at
   * 01:20:00 to seek to, which was the entire bug.
   */
  test("it ends the list, so the player trusts the whole timeline", () => {
    expect(text).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
    expect(text.trimEnd().endsWith("#EXT-X-ENDLIST")).toBe(true);
  });

  test("it names every segment before any of them exists", () => {
    for (let i = 0; i < segmentCount(t); i++) expect(text).toContain(segmentFileName(i));
  });

  test("the durations are the real ones, not the target", () => {
    expect(text).toContain("#EXTINF:11.011000,");
    expect(text).toContain("#EXTINF:10.010000,");
  });

  /** TARGETDURATION below an actual segment is a spec violation players do act on. */
  test("the target duration covers the longest segment", () => {
    const declared = Number(/#EXT-X-TARGETDURATION:(\d+)/.exec(text)?.[1]);
    for (let i = 0; i < segmentCount(t); i++) {
      const r = segmentRange(t, i) as { startSec: number; endSec: number };
      expect(declared).toBeGreaterThanOrEqual(r.endSec - r.startSec);
    }
  });

  test("one init segment covers the whole film", () => {
    expect(text.match(/#EXT-X-MAP/g)).toHaveLength(1);
    expect(text).toContain(`#EXT-X-MAP:URI="${INIT_FILE_NAME}"`);
  });

  /** Relative names are what let a client retarget the media at another endpoint. */
  test("nothing in it is an absolute URL", () => {
    expect(text).not.toContain("http");
    expect(text).not.toContain("/api/");
  });
});

/**
 * Two languages for one naming rule is the classic pair that drifts. ffmpeg's `%05d` and
 * `padStart(5, "0")` have to keep agreeing or a produced file is published under a name the
 * playlist never mentions.
 */
test("the ffmpeg template and the generated name are the same spelling", () => {
  expect(SEGMENT_FILE_PATTERN.replace("%05d", "00042")).toBe(segmentFileName(42));
});
