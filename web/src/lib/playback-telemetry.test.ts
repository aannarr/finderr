/**
 * The browser half of the stats panel.
 *
 * The property worth the most is that a STALL is legible: a player sitting at a hole has
 * buffered ranges either side of a position it cannot advance through, and reporting the
 * nearest range's length would read as "12 seconds buffered" while nothing moved.
 */

import { describe, expect, test } from "bun:test";
import { PlaybackTelemetry, type PlayheadSource, readyStateLabel } from "./playback-telemetry";

/** A `<video>` with the buffered ranges spelled out as pairs. */
function video(over: Partial<PlayheadSource> & { ranges?: [number, number][] } = {}): PlayheadSource {
  const ranges = over.ranges ?? [];
  return {
    readyState: over.readyState ?? 4,
    currentTime: over.currentTime ?? 0,
    buffered: {
      length: ranges.length,
      start: (i: number) => ranges[i]?.[0] ?? 0,
      end: (i: number) => ranges[i]?.[1] ?? 0,
    },
    getVideoPlaybackQuality: over.getVideoPlaybackQuality,
    error: over.error,
  };
}

describe("how much is buffered ahead", () => {
  test("the range the playhead is inside, measured from the playhead", () => {
    const stats = new PlaybackTelemetry().read(video({ currentTime: 12, ranges: [[0, 30]] }), null);
    expect(stats.bufferedAheadSec).toBe(18);
    expect(stats.positionSec).toBe(12);
  });

  test("nothing buffered is zero ahead rather than unknown", () => {
    expect(new PlaybackTelemetry().read(video(), null).bufferedAheadSec).toBe(0);
  });

  /**
   * THE STALL. Segments landed on both sides of a hole the player cannot decode through, and
   * "18 seconds buffered" would be a true statement about the wrong range.
   */
  test("a playhead sitting in a hole is zero ahead, not the next range's length", () => {
    const stalled = video({
      currentTime: 30.2,
      ranges: [
        [0, 30],
        [30.5, 48],
      ],
    });
    expect(new PlaybackTelemetry().read(stalled, null).bufferedAheadSec).toBe(0);
  });
});

describe("frames and throughput", () => {
  test("dropped frames are reported when the browser counts them", () => {
    const counting = video({
      getVideoPlaybackQuality: () => ({ droppedVideoFrames: 7, totalVideoFrames: 1500 }),
    });
    const stats = new PlaybackTelemetry().read(counting, 4_200_000);
    expect(stats.droppedFrames).toBe(7);
    expect(stats.totalFrames).toBe(1500);
    expect(stats.bandwidthBps).toBe(4_200_000);
  });

  /** A browser without the API reports NOTHING, never a confident zero. */
  test("a browser that cannot count frames reports null rather than zero", () => {
    const stats = new PlaybackTelemetry().read(video(), null);
    expect(stats.droppedFrames).toBeNull();
    expect(stats.totalFrames).toBeNull();
    expect(stats.bandwidthBps).toBeNull();
  });

  test("an unusable bandwidth estimate is null rather than NaN on the screen", () => {
    expect(new PlaybackTelemetry().read(video(), Number.NaN).bandwidthBps).toBeNull();
  });
});

describe("what the player last did and last failed at", () => {
  test("the newest fragment load replaces the one before it", () => {
    const t = new PlaybackTelemetry();
    t.fragmentLoaded({ index: 0, track: "main", loadMs: 90, bytes: 1_100_000 });
    t.fragmentLoaded({ index: 1, track: "main", loadMs: 74, bytes: 1_050_000 });
    expect(t.read(video(), null).lastFragment).toEqual({
      index: 1,
      track: "main",
      loadMs: 74,
      bytes: 1_050_000,
    });
  });

  test("nothing fetched yet is null, which the panel draws as a dash", () => {
    expect(new PlaybackTelemetry().read(video(), null).lastFragment).toBeNull();
    expect(new PlaybackTelemetry().read(video(), null).lastError).toBeNull();
  });

  test("a reported failure survives until a newer one replaces it", () => {
    const t = new PlaybackTelemetry();
    t.failed("fragLoadError (fatal)");
    expect(t.read(video(), null).lastError).toBe("fragLoadError (fatal)");
  });

  /**
   * The native-HLS path has no hls.js to report a cause, and `error.code 4` with an empty
   * console is exactly the failure that cost this subsystem a working player once already.
   */
  test("the element's own error is reported when there is no player error to report", () => {
    const broken = video({ readyState: 0, error: { code: 4 } });
    expect(new PlaybackTelemetry().read(broken, null).lastError).toBe("media element error 4");
  });

  test("a player error wins over the element's, because it names the cause", () => {
    const t = new PlaybackTelemetry();
    t.failed("manifestLoadError (fatal)");
    expect(t.read(video({ error: { code: 4 } }), null).lastError).toBe("manifestLoadError (fatal)");
  });
});

describe("readyState in words", () => {
  test("every state the spec defines has a phrase", () => {
    expect(readyStateLabel(0)).toContain("nothing");
    expect(readyStateLabel(4)).toContain("finish");
  });

  test("a state nobody has heard of still prints its number", () => {
    expect(readyStateLabel(9)).toBe("9 - unknown");
  });
});
