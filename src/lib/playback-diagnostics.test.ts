/**
 * The block the stats panel reads.
 *
 * The properties worth pinning are all about HONESTY under missing data, because that is the
 * shape this thing meets in production: an arr row imported before it was scanned, a
 * container that states no duration, a plan that uses no video stream at all. A panel that
 * printed `undefined` for any of those would be worse than one that was never built.
 */

import { describe, expect, test } from "bun:test";
import type { EncoderChoice } from "./encoder";
import type { MediaFileRow } from "./media-file";
import { NOT_AN_EPISODE } from "./media-file";
import { playbackDiagnostics, type SegmentingFacts } from "./playback-diagnostics";
import type { PlaybackPlan, ProbedMedia } from "./playback-plan";

const ROW: MediaFileRow = {
  imdb_id: "tt1375666",
  season: NOT_AN_EPISODE,
  episode: NOT_AN_EPISODE,
  service: "radarr",
  arr_file_id: 7,
  path: "/plex/films/Inception.mkv",
  size: 3_400_000_000,
  video_codec: "x265",
  video_depth: 10,
  video_range: "HDR",
  audio_codec: "DTS",
  audio_channels: 6,
  audio_langs: "eng",
  subtitle_langs: "eng",
  resolution: "3840x2160",
  runtime: "2:28:00",
};

const PROBE: ProbedMedia = {
  streams: [
    { index: 0, codec_type: "video", codec_name: "hevc", width: 3840, height: 2160 },
    { index: 1, codec_type: "audio", codec_name: "dts", channels: 6 },
  ],
  durationSec: 8880,
  formatName: "matroska,webm",
};

const PLAN: PlaybackPlan = {
  video: { action: "copy", sourceIndex: 0, codec: "hevc", scaleWidth: null },
  audio: { action: "transcode", sourceIndex: 1, codec: "aac" },
  subtitles: { action: "none", sourceIndex: null },
  reasons: [],
};

const SEGMENTING: SegmentingFacts = { source: "keyframes", targetSec: 6, count: 1480 };

const HARDWARE: EncoderChoice = {
  encoder: "h264_vaapi",
  hardware: true,
  hwaccel: "vaapi",
  vaapiDevice: "/dev/dri/renderD128",
  reason: "hardware (VAAPI, /dev/dri/renderD128)",
};

describe("what the server knows about a playback", () => {
  test("reports the source in ffmpeg's vocabulary, not the arr's release label", () => {
    const d = playbackDiagnostics({ row: ROW, probe: PROBE, plan: PLAN, segmenting: SEGMENTING });

    // `x265` is what the arr calls it and `hevc` is what actually decides anything.
    expect(d.source.videoCodec).toBe("hevc");
    expect(d.source.audioCodec).toBe("dts");
    expect(d.source.audioChannels).toBe(6);
    expect(d.source.container).toBe("matroska,webm");
    expect(d.source.durationSec).toBe(8880);
    expect(d.source.sizeBytes).toBe(3_400_000_000);
  });

  test("bit depth and dynamic range come from the arr, which is the only thing that scanned them", () => {
    const d = playbackDiagnostics({ row: ROW, probe: PROBE, plan: PLAN, segmenting: SEGMENTING });
    expect(d.source.bitDepth).toBe(10);
    expect(d.source.dynamicRange).toBe("HDR");
  });

  test("resolution is the PROBE's when it has one", () => {
    const arrIsWrong = { ...ROW, resolution: "1920x1080" };
    const d = playbackDiagnostics({ row: arrIsWrong, probe: PROBE, plan: PLAN, segmenting: SEGMENTING });
    expect(d.source.resolution).toBe("3840x2160");
  });

  test("resolution falls back to the arr's scan when the container states only one dimension", () => {
    const halfStated: ProbedMedia = {
      ...PROBE,
      streams: [{ index: 0, codec_type: "video", codec_name: "hevc", width: 3840 }],
    };
    const d = playbackDiagnostics({ row: ROW, probe: halfStated, plan: PLAN, segmenting: SEGMENTING });
    // Never `3840x?`, which reads as a measurement and is not one.
    expect(d.source.resolution).toBe("3840x2160");
  });

  /**
   * An arr that imported a file before it could scan it serves the path and no `mediaInfo` at
   * all -- and that file plays exactly as well as a scanned one, so the panel has to draw it.
   */
  test("an unscanned arr row yields nulls rather than undefined", () => {
    const unscanned: MediaFileRow = {
      ...ROW,
      size: null,
      video_depth: null,
      video_range: null,
      resolution: null,
    };
    const noDuration: ProbedMedia = { ...PROBE, durationSec: null, formatName: null };
    const d = playbackDiagnostics({
      row: unscanned,
      probe: noDuration,
      plan: PLAN,
      segmenting: { source: null, targetSec: 6, count: 0 },
    });

    for (const value of Object.values(d.source)) expect(value).not.toBeUndefined();
    expect(d.source.bitDepth).toBeNull();
    expect(d.source.durationSec).toBeNull();
    expect(d.segmenting.source).toBeNull();
  });

  test("a plan that uses no video stream reports no video codec rather than the first stream's", () => {
    const audioOnly: PlaybackPlan = {
      ...PLAN,
      video: { action: "copy", sourceIndex: null, codec: "", scaleWidth: null },
    };
    const d = playbackDiagnostics({ row: ROW, probe: PROBE, plan: audioOnly, segmenting: SEGMENTING });
    expect(d.source.videoCodec).toBeNull();
    expect(d.source.audioCodec).toBe("dts");
  });

  test("the encoder is reported even on a plan that copies video, because it is a fact about the box", () => {
    const d = playbackDiagnostics({
      row: ROW,
      probe: PROBE,
      plan: PLAN,
      segmenting: SEGMENTING,
      encoder: HARDWARE,
    });
    expect(d.encoder).toEqual({
      name: "h264_vaapi",
      hardware: true,
      reason: "hardware (VAAPI, /dev/dri/renderD128)",
    });
  });

  test("no probed encoder is null rather than an invented software claim", () => {
    const d = playbackDiagnostics({ row: ROW, probe: PROBE, plan: PLAN, segmenting: SEGMENTING });
    expect(d.encoder).toBeNull();
  });

  /**
   * The fallback grid is the difference between "this title stutters" and "this title fell
   * back to a uniform cut", and until this field existed the only answer was a log on the box.
   */
  test("the fallback grid is carried through by name", () => {
    const d = playbackDiagnostics({
      row: ROW,
      probe: PROBE,
      plan: PLAN,
      segmenting: { source: "uniform", targetSec: 6, count: 1480 },
    });
    expect(d.segmenting).toEqual({ source: "uniform", targetSec: 6, count: 1480 });
  });
});
