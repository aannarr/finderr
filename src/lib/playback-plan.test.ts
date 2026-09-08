/**
 * The playback decision, against ffprobe output RECORDED FROM REAL FILES.
 *
 * The two fixtures below are verbatim (narrowed) ffprobe output taken on 2026-09-08 from
 * files in the library this will actually serve, and they were chosen because between them
 * they cover the decision that matters:
 *
 * - `ANNA_AND_THE_KING` -- h264 + eac3 + subrip in matroska. **The common case**: video
 *   copies everywhere, audio has to be re-encoded for anything but Safari, subtitles are
 *   free. Cheap.
 * - `RANGO` -- hevc + eac3 + five PGS tracks in matroska. **The expensive case**: video
 *   copies only for a client that decodes HEVC, and asking for subtitles at all forces a
 *   full re-encode because every track is a bitmap.
 *
 * Recorded rather than invented on purpose: the shapes that break a parser are the ones
 * nobody would think to write down -- `tags.language` absent on the video stream,
 * `disposition.default` being 0/1 rather than a boolean, `duration` arriving as a string.
 * All three are in these fixtures and all three came from the disk.
 */

import { describe, expect, test } from "bun:test";
import { chooseEncoder, type EncoderChoice, SOFTWARE, VAAPI_DEVICE } from "./encoder";
import { RUN_INIT_NAME, segmentFilePattern } from "./hls-timeline";
import { parseProbe } from "./media-probe";
import {
  type ClientCapabilities,
  CONSERVATIVE_CLIENT,
  ffmpegArgs,
  isExpensive,
  MAX_TRANSCODE_WIDTH,
  planPlayback,
} from "./playback-plan";

const ANNA_AND_THE_KING = JSON.stringify({
  streams: [
    {
      index: 0,
      codec_type: "video",
      codec_name: "h264",
      width: 1920,
      height: 816,
      disposition: { default: 1 },
    },
    {
      index: 1,
      codec_type: "audio",
      codec_name: "eac3",
      channels: 2,
      tags: { language: "eng" },
      disposition: { default: 1 },
    },
    {
      index: 2,
      codec_type: "subtitle",
      codec_name: "subrip",
      tags: { language: "eng" },
      disposition: { default: 0 },
    },
  ],
  format: { duration: "8888.088000", format_name: "matroska,webm" },
});

const RANGO = JSON.stringify({
  streams: [
    { index: 0, codec_type: "video", codec_name: "hevc", disposition: { default: 1 } },
    {
      index: 1,
      codec_type: "audio",
      codec_name: "eac3",
      channels: 6,
      tags: { language: "eng" },
      disposition: { default: 1 },
    },
    {
      index: 2,
      codec_type: "subtitle",
      codec_name: "hdmv_pgs_subtitle",
      tags: { language: "dut" },
      disposition: { default: 0 },
    },
    {
      index: 3,
      codec_type: "subtitle",
      codec_name: "hdmv_pgs_subtitle",
      tags: { language: "eng" },
      disposition: { default: 0 },
    },
  ],
  format: { duration: "6710.080000", format_name: "matroska,webm" },
});

/**
 * The real file every measurement on this card was taken against: a 2.40:1 scope film at
 * 1920x800, HEVC Main 10, eac3. Both of the spawn failures fixed here reproduce on it, and
 * the odd height is the point -- a cap on width has to keep the aspect ratio rather than
 * assume 16:9.
 */
const SCOPE_HEVC_10BIT = JSON.stringify({
  streams: [
    {
      index: 0,
      codec_type: "video",
      codec_name: "hevc",
      width: 1920,
      height: 800,
      pix_fmt: "yuv420p10le",
      disposition: { default: 1 },
    },
    { index: 1, codec_type: "audio", codec_name: "eac3", channels: 6, disposition: { default: 1 } },
  ],
  format: { duration: "6034.000000", format_name: "matroska,webm" },
});

/** Already under the cap, so nothing should resize it upward. */
const SMALL_H264 = JSON.stringify({
  streams: [
    {
      index: 0,
      codec_type: "video",
      codec_name: "hevc",
      width: 720,
      height: 400,
      disposition: { default: 1 },
    },
    { index: 1, codec_type: "audio", codec_name: "aac", channels: 2, disposition: { default: 1 } },
  ],
  format: { duration: "3600.000000", format_name: "matroska,webm" },
});

/** What Safari reports: HEVC and the Dolby codecs. */
const SAFARI: ClientCapabilities = { video: ["h264", "hevc"], audio: ["aac", "ac3", "eac3"] };
/** What Chrome on a machine with an HEVC decoder reports -- note NO Dolby audio. */
const CHROME_HEVC: ClientCapabilities = { video: ["h264", "hevc"], audio: ["aac"] };
/** Firefox: h264 and aac, which is also the conservative floor. */
const FIREFOX: ClientCapabilities = { video: ["h264"], audio: ["aac"] };

/** The two hardware encoders that actually exist on the machines this runs on. */
const VAAPI: EncoderChoice = chooseEncoder({
  platform: "linux",
  available: ["h264_vaapi", "libx264"],
  hasDri: true,
  hasQsvRuntime: false,
});
const VIDEOTOOLBOX: EncoderChoice = chooseEncoder({
  platform: "darwin",
  available: ["h264_videotoolbox", "libx264"],
  hasDri: false,
  hasQsvRuntime: false,
});

describe("parseProbe reads what ffprobe actually emits", () => {
  test("narrows a real matroska document", () => {
    const p = parseProbe(ANNA_AND_THE_KING);
    expect(p.formatName).toBe("matroska,webm");
    expect(p.durationSec).toBeCloseTo(8888.088, 2);
    expect(p.streams).toHaveLength(3);
    expect(p.streams[0]).toMatchObject({
      index: 0,
      codec_type: "video",
      codec_name: "h264",
      isDefault: true,
    });
    expect(p.streams[2]).toMatchObject({
      codec_type: "subtitle",
      codec_name: "subrip",
      language: "eng",
      isDefault: false,
    });
  });

  test("a stream with no index or no type is dropped, because -map cannot address it", () => {
    const p = parseProbe(
      JSON.stringify({
        streams: [
          { codec_type: "video" },
          { index: 1 },
          { index: 2, codec_type: "audio", codec_name: "aac" },
        ],
      }),
    );
    expect(p.streams).toHaveLength(1);
    expect(p.streams[0]?.index).toBe(2);
  });

  test("a missing or unparseable duration is null rather than NaN or zero", () => {
    expect(parseProbe(JSON.stringify({ format: {} })).durationSec).toBeNull();
    expect(parseProbe(JSON.stringify({ format: { duration: "N/A" } })).durationSec).toBeNull();
    expect(parseProbe(JSON.stringify({})).durationSec).toBeNull();
  });

  test("output that is not JSON throws rather than yielding an empty plan", () => {
    expect(() => parseProbe("ffprobe: command not found")).toThrow();
  });
});

describe("the common case is cheap", () => {
  test("h264 + eac3 in Chrome: copy the video, re-encode only the audio", () => {
    const plan = planPlayback(parseProbe(ANNA_AND_THE_KING), CHROME_HEVC);
    expect(plan.video.action).toBe("copy");
    expect(plan.audio.action).toBe("transcode");
    expect(plan.audio.codec).toBe("aac");
    expect(isExpensive(plan)).toBe(false);
  });

  test("the same file in Safari copies BOTH streams -- a pure remux", () => {
    const plan = planPlayback(parseProbe(ANNA_AND_THE_KING), SAFARI);
    expect(plan.video.action).toBe("copy");
    expect(plan.audio.action).toBe("copy");
    expect(isExpensive(plan)).toBe(false);
  });

  test("it still says the container was rewritten, so a plan of all-copies is not confusing", () => {
    const plan = planPlayback(parseProbe(ANNA_AND_THE_KING), SAFARI);
    expect(plan.reasons.join(" ")).toContain("matroska");
  });
});

describe("the expensive case is named as expensive", () => {
  test("hevc in Firefox re-encodes the video", () => {
    const plan = planPlayback(parseProbe(RANGO), FIREFOX);
    expect(plan.video.action).toBe("transcode");
    expect(plan.video.codec).toBe("h264");
    expect(isExpensive(plan)).toBe(true);
  });

  test("hevc in a browser that decodes it copies the video", () => {
    const plan = planPlayback(parseProbe(RANGO), CHROME_HEVC);
    expect(plan.video.action).toBe("copy");
    expect(plan.audio.action).toBe("transcode");
    expect(isExpensive(plan)).toBe(false);
  });

  /**
   * THE DECISION THIS MODULE EXISTS FOR. Rango's video would copy in Safari; asking for its
   * bitmap subtitles turns that into a full 1080p re-encode. It must be a choice, and the
   * plan must say so in words.
   */
  test("asking for PGS subtitles forces a video re-encode, and says why", () => {
    const without = planPlayback(parseProbe(RANGO), SAFARI);
    expect(without.video.action).toBe("copy");
    expect(without.subtitles.action).toBe("none");

    const withSubs = planPlayback(parseProbe(RANGO), SAFARI, { wantSubtitles: true });
    expect(withSubs.subtitles.action).toBe("burn");
    expect(withSubs.video.action).toBe("transcode");
    expect(isExpensive(withSubs)).toBe(true);
    expect(withSubs.reasons.join(" ")).toContain("bitmap");
  });

  /**
   * The re-encode is made CHEAP as well as correct -- aannarr, 2026-09-08: *"run it at low
   * quality, low cpu"*. The decision lives here because this is the only place that has seen
   * the source's dimensions.
   */
  describe("a re-encode is capped at a width, and only ever downward", () => {
    test("a wide source is scaled down to the cap", () => {
      const plan = planPlayback(parseProbe(SCOPE_HEVC_10BIT), FIREFOX);
      expect(plan.video.action).toBe("transcode");
      expect(plan.video.scaleWidth).toBe(MAX_TRANSCODE_WIDTH);
      expect(plan.reasons.join(" ")).toContain("scaled down");
    });

    /** Upscaling would spend pixels to make the picture worse. */
    test("a source already under the cap is left alone", () => {
      const plan = planPlayback(parseProbe(SMALL_H264), FIREFOX);
      expect(plan.video.action).toBe("transcode");
      expect(plan.video.scaleWidth).toBeNull();
    });

    /** A guess about a dimension the container never stated is what stretches a frame. */
    test("a source with no stated width is left alone", () => {
      expect(planPlayback(parseProbe(RANGO), FIREFOX).video.scaleWidth).toBeNull();
    });

    test("a copy is never resized, however wide it is", () => {
      expect(planPlayback(parseProbe(SCOPE_HEVC_10BIT), SAFARI).video.scaleWidth).toBeNull();
    });
  });

  /** Subtitles are off by default so nobody buys that re-encode without asking. */
  test("subtitles are not requested by default", () => {
    expect(planPlayback(parseProbe(RANGO), SAFARI).subtitles.action).toBe("none");
    expect(planPlayback(parseProbe(ANNA_AND_THE_KING), SAFARI).subtitles.action).toBe("none");
  });

  test("a text subtitle track costs nothing and keeps the video copied", () => {
    const plan = planPlayback(parseProbe(ANNA_AND_THE_KING), SAFARI, { wantSubtitles: true });
    expect(plan.subtitles.action).toBe("extract");
    expect(plan.video.action).toBe("copy");
    expect(isExpensive(plan)).toBe(false);
  });

  /**
   * A file carrying BOTH kinds must choose the text one -- not for tidiness, but because
   * that choice is the difference between a copy and a full re-encode.
   */
  test("text wins over bitmap when a file has both", () => {
    const both = JSON.stringify({
      streams: [
        { index: 0, codec_type: "video", codec_name: "hevc", disposition: { default: 1 } },
        { index: 1, codec_type: "audio", codec_name: "aac", disposition: { default: 1 } },
        { index: 2, codec_type: "subtitle", codec_name: "hdmv_pgs_subtitle", disposition: { default: 1 } },
        { index: 3, codec_type: "subtitle", codec_name: "subrip", disposition: { default: 0 } },
      ],
      format: { format_name: "matroska,webm" },
    });
    const plan = planPlayback(parseProbe(both), SAFARI, { wantSubtitles: true });
    expect(plan.subtitles.action).toBe("extract");
    expect(plan.subtitles.sourceIndex).toBe(3);
    expect(plan.video.action).toBe("copy");
  });

  test("an unrecognised subtitle codec yields no subtitles rather than an expensive guess", () => {
    const weird = JSON.stringify({
      streams: [
        { index: 0, codec_type: "video", codec_name: "h264", disposition: { default: 1 } },
        { index: 1, codec_type: "subtitle", codec_name: "some_future_codec", disposition: { default: 1 } },
      ],
      format: { format_name: "matroska,webm" },
    });
    const plan = planPlayback(parseProbe(weird), SAFARI, { wantSubtitles: true });
    expect(plan.subtitles.action).toBe("none");
    expect(plan.video.action).toBe("copy");
  });
});

describe("a client that declares nothing gets the conservative floor", () => {
  test("hevc + eac3 is fully re-encoded for an unknown client", () => {
    const plan = planPlayback(parseProbe(RANGO));
    expect(plan.video.action).toBe("transcode");
    expect(plan.audio.action).toBe("transcode");
  });

  test("the floor excludes hevc and every Dolby codec, which is the point of it", () => {
    expect(CONSERVATIVE_CLIENT.video).not.toContain("hevc");
    expect(CONSERVATIVE_CLIENT.audio).not.toContain("eac3");
  });
});

describe("ffmpegArgs turns a plan into the flags that make ONE segment of ONE rendition", () => {
  const plan = planPlayback(parseProbe(ANNA_AND_THE_KING), CHROME_HEVC);
  /** Segment 7 of a six-second grid: past the start, so the seek flags are exercised. */
  const SEG7 = { index: 7, startSec: 42, endSec: 48 };
  const args = (p: typeof plan, opts: Partial<Parameters<typeof ffmpegArgs>[1]> = {}) =>
    ffmpegArgs(p, { input: "/plex/a.mkv", outDir: "/tmp/s1", track: "video", segment: SEG7, ...opts });

  test("copies the video and packages fragmented MP4", () => {
    const a = args(plan);
    expect(a.join(" ")).toContain("-c:v copy");
    expect(a.join(" ")).toContain("-hls_segment_type fmp4");
  });

  /**
   * ONE RUN, ONE TRACK, and the refusal is explicit rather than implied by the `-map`. A
   * rendition that quietly picked up the other stream would be a muxed segment again -- which
   * is the thing that drops ~60 ms of sound at every boundary.
   */
  test("a video run carries no audio and an audio run carries no video", () => {
    expect(args(plan)).toContain("-an");
    expect(args(plan)).not.toContain("-vn");

    const audio = args(plan, { track: "audio" });
    expect(audio).toContain("-vn");
    expect(audio).not.toContain("-an");
    expect(audio.join(" ")).toContain("-c:a aac");
    expect(audio.join(" ")).not.toContain("-c:v");
  });

  /**
   * `-ss` BEFORE `-i` is an input seek (instant); after `-i` it decodes and discards
   * everything from the start. Both spellings run; only one returns on a two-hour film.
   */
  test("the seek goes before the input, never after", () => {
    const a = args(plan);
    expect(a.indexOf("-ss")).toBeGreaterThan(-1);
    expect(a.indexOf("-ss")).toBeLessThan(a.indexOf("-i"));
  });

  /**
   * Independently produced segments have to carry the source's own timestamps or every one
   * of them claims to start at zero and nothing can assemble them. `-to` is then read in the
   * input's timeline, so it is an absolute position rather than a duration -- measured
   * 2026-09-08, the `-t <duration>` spelling produced 18.35 s of media instead of 10.34 s.
   */
  test("keeps the source timestamps and ends at an absolute position", () => {
    const a = args(plan).join(" ");
    expect(a).toContain("-copyts");
    expect(a).toContain("-avoid_negative_ts disabled");
    // Past the segment's own end, because the read has to outlast the muxer's cut -- see
    // SEGMENT_TAIL_SLACK_SEC. Absolute, not a duration: `-t` would count from the seek target.
    expect(a).toContain("-to 50.000000");
    expect(a).not.toContain("-t 6");
  });

  /**
   * A re-encode starts exactly where it is asked to and ends exactly where it is told, so it
   * needs neither the seek nudge nor the read slack -- and giving it either would skip 200 ms
   * of film or encode two seconds nobody asked for.
   */
  test("a re-encode gets the plain seek and stops at the boundary", () => {
    const a = args(planPlayback(parseProbe(RANGO), FIREFOX)).join(" ");
    expect(a).toContain("-ss 42.000000");
    expect(a).toContain("-to 48.000000");
    expect(a).not.toContain("-noaccurate_seek");
  });

  /**
   * ffmpeg's `-ss` subtracts 3/23 of a second on any input whose video has a reorder delay,
   * which on an index-seeking container drops it to the PREVIOUS entry -- measured 6.5 s
   * early on a 2160p file. `-noaccurate_seek` is the other half: it stops ffmpeg discarding
   * the audio between the nudged target and the boundary.
   */
  test("a copy is nudged past its boundary so the demuxer lands on it", () => {
    const a = args(plan);
    expect(a.join(" ")).toContain("-ss 42.200000");
    expect(a.indexOf("-noaccurate_seek")).toBeLessThan(a.indexOf("-i"));
  });

  /**
   * A run bounded by one segment needs no pacing, and pacing it would be a BUG: `-re` on a
   * six-second segment makes the request take six seconds of wall clock. The long-running
   * ffmpeg those flags existed for is what this design replaced.
   */
  test("never paces the read", () => {
    for (const p of [plan, planPlayback(parseProbe(RANGO), FIREFOX)]) {
      const a = args(p);
      expect(a).not.toContain("-re");
      expect(a.join(" ")).not.toContain("readrate");
    }
  });

  /**
   * The file name has to say where the segment sits in the WHOLE film, because the client is
   * holding a playlist that names every segment and asks for them by that number.
   */
  test("numbers the segment by its place in the timeline", () => {
    expect(args(plan).join(" ")).toContain("-start_number 7");
  });

  /**
   * SEGMENT ZERO SEEKS TOO, and this test used to assert the opposite.
   *
   * Omitting `-ss` at the start of the file looks like the honest spelling and stopped being
   * one when the segment's position moved into `tfdt`, which is UNSIGNED: a source's own
   * timeline opens before zero (AAC priming at -0.021 s), and with nothing seeked away the
   * first audio segment claimed to start 584 billion seconds in. An input seek discards what
   * is behind it, so seeking to zero is what keeps zero expressible.
   */
  test("segment zero seeks to its own boundary rather than skipping the seek", () => {
    const a = args(plan, { segment: { index: 0, startSec: 0, endSec: 6 } });
    expect(a.indexOf("-ss")).toBeGreaterThan(-1);
    expect(a.indexOf("-ss")).toBeLessThan(a.indexOf("-i"));
    expect(a.join(" ")).toContain("-start_number 0");

    // Audio and a re-encode ask for the boundary itself; a video copy still takes the nudge,
    // which lands on the same first keyframe and keeps ONE seek rule rather than two.
    expect(args(plan, { track: "audio", segment: { index: 0, startSec: 0, endSec: 6 } })).toContain(
      "0.000000",
    );
    expect(a.join(" ")).toContain("-ss 0.200000");
  });

  /**
   * THE MUXER DOES THE CUTTING, and telling it the segment's own length is what makes its cut
   * land on the next boundary -- which is a keyframe, so the cut is frame-exact. `-to` is not:
   * it stops on decode order and lets four frames of presentation past it, which hls.js then
   * turns into a hole at every boundary.
   */
  test("the muxer is told to cut at exactly this segment's length", () => {
    const a = args(plan);
    expect(a[a.indexOf("-hls_time") + 1]).toBe("6.000000");
    expect(a.join(" ")).toContain("-hls_playlist_type vod");
  });

  /**
   * Hardware DECODE while COPYING the video is pure overhead and breaks the copy path, so
   * the vaapi flags only appear when there is an encode to accelerate.
   */
  test("vaapi is wired up only when the video is actually re-encoded", () => {
    const copying = args(plan, { encoder: VAAPI });
    expect(copying).not.toContain("-hwaccel");
    expect(copying.join(" ")).toContain("-c:v copy");

    const encoding = planPlayback(parseProbe(RANGO), FIREFOX);
    const hw = args(encoding, { encoder: VAAPI });
    expect(hw).toContain("-hwaccel");
    expect(hw.join(" ")).toContain("h264_vaapi");
  });

  test("with no hardware it falls back to libx264 rather than failing", () => {
    const encoding = planPlayback(parseProbe(RANGO), FIREFOX);
    for (const encoder of [undefined, SOFTWARE]) {
      const sw = args(encoding, { encoder });
      expect(sw.join(" ")).toContain("libx264");
      expect(sw).not.toContain("-hwaccel");
    }
  });

  /**
   * VideoToolbox takes the accelerator alone. Handing it VAAPI's `-hwaccel_output_format`
   * and `-vaapi_device` is a SPAWN ERROR rather than an ignored flag, so the device-specific
   * half of the hardware setup has to be gated on the encoder that needs it.
   */
  test("VideoToolbox gets its accelerator and none of VAAPI's device flags", () => {
    const encoding = planPlayback(parseProbe(RANGO), FIREFOX);
    const a = args(encoding, { encoder: VIDEOTOOLBOX });
    expect(a.join(" ")).toContain("-hwaccel videotoolbox");
    expect(a.join(" ")).toContain("h264_videotoolbox");
    expect(a).not.toContain("-vaapi_device");
    expect(a).not.toContain("-hwaccel_output_format");
  });

  /** A hardware encoder has no `-crf`; passing one is an error, not an ignored flag. */
  test("a hardware encode asks for a bitrate and never a crf", () => {
    const encoding = planPlayback(parseProbe(RANGO), FIREFOX);
    for (const encoder of [VAAPI, VIDEOTOOLBOX]) {
      const a = args(encoding, { encoder });
      expect(a).toContain("-b:v");
      expect(a).not.toContain("-crf");
    }
  });

  /**
   * THE THREE FAILURES MEASURED ON THE SYNOLOGY, 2026-09-08, each of them a title that would
   * not play at all rather than one that played badly. All three passed every test that
   * existed before this block, because all three are facts about ffmpeg's spawn and output
   * rather than about the decision -- the plan correctly said "re-encoded to h264" each time.
   */
  describe("what a re-encode must hand ffmpeg on real hardware", () => {
    const encoding = planPlayback(parseProbe(SCOPE_HEVC_10BIT), FIREFOX);

    /**
     * `h264_vaapi` on UHD 600 encodes 8-bit only, and a 10-bit source decodes into a p010
     * surface. Without the conversion: `No usable encoding profile found`.
     */
    test("VAAPI converts to nv12, because it cannot be given -pix_fmt", () => {
      const a = args(encoding, { encoder: VAAPI }).join(" ");
      expect(a).toContain("format=nv12");
      expect(a).not.toContain("-pix_fmt");
    });

    /**
     * `libx264` follows its input, so a 10-bit source came out as h264 High 10 -- which no
     * browser decodes. The transcode existed to make the file playable and made it less so.
     */
    test("software pins yuv420p, so a 10-bit source cannot become High 10", () => {
      for (const encoder of [undefined, SOFTWARE]) {
        expect(args(encoding, { encoder }).join(" ")).toContain("-pix_fmt yuv420p");
      }
    });

    /** VideoToolbox and NVENC hand frames back to system memory, so they take the flag too. */
    test("a non-VAAPI hardware encode pins the pixel format as well", () => {
      expect(args(encoding, { encoder: VIDEOTOOLBOX }).join(" ")).toContain("-pix_fmt yuv420p");
    });

    /**
     * The GPU filter and the CPU one are not interchangeable: after
     * `-hwaccel_output_format vaapi` the frames never reach system memory, so plain `scale`
     * cannot see them.
     */
    test("the resize uses the filter that can reach the frames", () => {
      expect(args(encoding, { encoder: VAAPI }).join(" ")).toContain(
        `scale_vaapi=w=${MAX_TRANSCODE_WIDTH}:h=-2`,
      );
      expect(args(encoding, { encoder: SOFTWARE }).join(" ")).toContain(
        `-vf scale=${MAX_TRANSCODE_WIDTH}:-2`,
      );
    });
  });

  /** A copy has no frame to resize and no format to convert, whatever the machine can do. */
  test("a copy carries no filter at all", () => {
    const a = args(plan, { encoder: VAAPI });
    expect(a).not.toContain("-vf");
    expect(a).not.toContain("-pix_fmt");
  });

  test("VAAPI names its render node, because it is the one that needs it", () => {
    const encoding = planPlayback(parseProbe(RANGO), FIREFOX);
    expect(args(encoding, { encoder: VAAPI })).toContain(VAAPI_DEVICE);
  });

  test("maps the exact source stream this rendition is made of", () => {
    expect(args(plan).join(" ")).toContain("-map 0:0");
    expect(args(plan).join(" ")).not.toContain("-map 0:1");
    expect(args(plan, { track: "audio" }).join(" ")).toContain("-map 0:1");
  });

  /**
   * `hls_fmp4_init_filename` is resolved against the PLAYLIST's directory rather than the
   * working directory, so both have to name the same place. Getting that wrong is not a
   * subtle bug: ffmpeg fails at header-write time with "Failed to open segment" and produces
   * nothing at all.
   */
  test("everything a run writes lands in the working directory it was given", () => {
    const a = ffmpegArgs(plan, { input: "/a.mkv", outDir: "/tmp/w42", track: "video", segment: SEG7 });
    expect(a).toContain("/tmp/w42/produced.m3u8");
    expect(a.join(" ")).toContain(`/tmp/w42/${segmentFilePattern("video")}`);
    expect(a.join(" ")).toContain(`-hls_fmp4_init_filename ${RUN_INIT_NAME}`);
  });

  test("a run writes the file names its own rendition's playlist points at", () => {
    expect(args(plan, { track: "audio" }).join(" ")).toContain(`/${segmentFilePattern("audio")}`);
    expect(args(plan, { track: "audio" }).join(" ")).not.toContain(segmentFilePattern("video"));
  });

  /**
   * THE AUDIO RUN IS BOUNDED BY `-to` AND NOTHING ELSE, which is what closes the hole.
   *
   * Told a real `-hls_time`, the muxer cuts that far after the run's FIRST packet -- and a
   * copy seek lands at the container's index granularity BEFORE the boundary, so the cut lands
   * early by however much that was. Measured 2026-09-08 on a 1080p WEB-DL with 1.6 s clusters:
   * `-ss 2400 -hls_time 6` produced [2398.400, 2404.416) against a declared [2400, 2406), and
   * consecutive segments abutted only because that file's cluster spacing happened to divide
   * the grid. With no reachable cut the run writes what it read as one segment -- measured
   * [2398.400, 2406.016) then [2404.416, 2412.000), zero gap and 1.6 s of harmless overlap.
   */
  test("an audio run is given a cut point no film can reach", () => {
    const a = args(plan, { track: "audio" });
    expect(Number(a[a.indexOf("-hls_time") + 1])).toBeGreaterThan(24 * 60 * 60 - 1);
  });

  /**
   * The nudge and the slack both exist to survive the muxer cutting on a KEYFRAME, and an
   * audio run has no keyframes to wait for. Nudging it would drop 200 ms of sound, and reading
   * two seconds past the boundary would only widen the overlap.
   */
  test("an audio run asks for its boundary plainly and stops at the next one", () => {
    const a = args(plan, { track: "audio" });
    expect(a.join(" ")).toContain("-ss 42.000000");
    expect(a.join(" ")).toContain("-to 48.000000");
    expect(a).not.toContain("-noaccurate_seek");
  });

  /** An audio run never touches a pixel, so there is nothing for a GPU to accelerate. */
  test("an audio run wires up no hardware even when the video is being re-encoded", () => {
    const encoding = planPlayback(parseProbe(RANGO), FIREFOX);
    const a = args(encoding, { track: "audio", encoder: VAAPI });
    expect(a).not.toContain("-hwaccel");
    expect(a).not.toContain("-vaapi_device");
  });

  /**
   * WITHOUT THIS THE SEGMENT DOES NOT SAY WHERE IT BELONGS, and the browser drifts 0.083 s
   * further per fragment. The bytes those options produce are asserted below, against a
   * recorded segment; this only checks that the run still asks for them.
   */
  test("the nested fMP4 muxer is told to place the segment in the media", () => {
    for (const track of ["video", "audio"] as const) {
      for (const p of [plan, planPlayback(parseProbe(RANGO), FIREFOX)]) {
        const a = args(p, { track });
        const options = a[a.indexOf("-hls_segment_options") + 1] ?? "";
        expect(options).toContain("frag_discont");
        expect(options).toContain("negative_cts_offsets");
        expect(options).toContain("use_editlist=0");
      }
    }
  });
});

/**
 * WHAT THOSE MUXER OPTIONS ACTUALLY PRODUCE, from a segment recorded off disk.
 *
 * The argv tests above assert the request; these assert the answer, which is the half that
 * decides whether a browser can assemble the film. Recorded 2026-09-08 from a real ffmpeg
 * 9.0.1 run through `ffmpegArgs` itself, so the fixture cannot drift from the flags that made
 * it -- regenerate with a short h264 source carrying B-frames:
 *
 * ```
 * ffmpeg -f lavfi -i testsrc2=size=160x120:rate=24000/1001 -t 5 \
 *        -c:v libx264 -bf 2 -g 24 -preset ultrafast -pix_fmt yuv420p tiny.mkv
 * ```
 *
 * then produce segment 2 of a 1.001 s grid (`startSec: 2.002, endSec: 3.003`). Kept small on
 * purpose: the whole init, and the fragment's header through its `moof`, is all the timing
 * lives in, and 24 samples make a `trun` worth reading.
 *
 * **Before the options went in, the same run produced an `elst` with two entries and a `tfdt`
 * of 0** -- the segment's position lived in the init's edit list, which hls.js does not
 * implement. Two consecutive inits are now byte-identical (measured on segments 0 and 2 of a
 * 60 s source), which is what retires the reason `mediaPlaylist` gives one per segment.
 */
const RECORDED_INIT =
  "AAAAGGZ0eXBpc282AAACAGlzbzZtcDQxAAAC5m1vb3YAAABsbXZoZAAAAAAAAAAAAAAAAAAAA+gAAAAAAAEAAAEAAAAA" +
  "AAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAIAAAHpdHJhawAAAFx0a2hkAAAAAwAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAA" +
  "AAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAACgAAAAeAAAAAABhW1kaWEAAAAgbWRoZAAAAAAAAAAAAAAAAAAAPoAAAAAA" +
  "VcQAAAAAAC1oZGxyAAAAAAAAAAB2aWRlAAAAAAAAAAAAAAAAVmlkZW9IYW5kbGVyAAAAATBtaW5mAAAAFHZtaGQAAAAB" +
  "AAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAADwc3RibAAAAKRzdHNkAAAAAAAAAAEA" +
  "AACUYXZjMQAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAACgAHgASAAAAEgAAAAAAAAAARRMYXZjNjMuMS4xMDEgbGlieDI2" +
  "NAAAAAAAAAAAAAAAABj//wAAAC5hdmNDAU1AC//hABdnTUAL7KFCPy4CIAAAfSAAF3AB4oUywAEABGjOD8gAAAAQcGFz" +
  "cAAAAAEAAAABAAAAEHN0dHMAAAAAAAAAAAAAABBzdHNjAAAAAAAAAAAAAAAUc3RzegAAAAAAAAAAAAAAAAAAABBzdGNv" +
  "AAAAAAAAAAAAAAAobXZleAAAACB0cmV4AAAAAAAAAAEAAAABAAAAAAAAAAAAAAAAAAAAYXVkdGEAAABZbWV0YQAAAAAA" +
  "AAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAsaWxzdAAAACSpdG9vAAAAHGRhdGEAAAABAAAAAExhdmY2" +
  "My4xLjEwMQ==";

const RECORDED_FRAGMENT_HEADER =
  "AAAAGHN0eXBtc2RoAAAAAG1zZGhtc2l4AAAANHNpZHgBAAAAAAAAAQAAPoAAAAAAAAB9IAAAAAAAAAAAAAAAAQAAko8A" +
  "AD6AgAAAAAAAAYhtb29mAAAAEG1maGQAAAAAAAAAAQAAAXB0cmFmAAAAHHRmaGQAAgA4AAAAAQAAApAAABQXAQEAAAAA" +
  "ABR0ZmR0AQAAAAAAAAAAAH0gAAABOHRydW4BAAsFAAAAGAAAAZACAAAAAAACkAAAFBcAAAAAAAACoAAAB9gAAAVAAAAC" +
  "oAAAA23///1wAAACkAAAA4n///1gAAACoAAAByEAAAVAAAACoAAABAH///1wAAACoAAAA2D///1wAAACkAAACCQAAAUw" +
  "AAACoAAABBP///1wAAACoAAAA+X///1wAAACkAAABz4AAAVAAAACoAAABFH///1wAAACoAAAA3r///1wAAACoAAACEcA" +
  "AAVAAAACkAAAA8z///1gAAACoAAABBP///1wAAACoAAACIUAAAVAAAACkAAABE////1gAAACoAAABJH///1wAAACoAAA" +
  "CL0AAAVAAAACkAAABSD///1gAAACoAAABK////1wAAACoAAAB9oAAAKgAAACkAAABIL///1w";

/** The boundary the recorded segment declares, in seconds. Segment 2 of a 1.001 s grid. */
const RECORDED_SEGMENT_START_SEC = 2.002;

/** ISO-BMFF boxes that hold other boxes rather than fields. Enough to reach the timing. */
const BOX_CONTAINERS = new Set(["moov", "trak", "edts", "mdia", "minf", "stbl", "moof", "traf"]);

/** The body of the first box of this type, at any depth, or null when there is none. */
function findBox(bytes: Uint8Array, type: string): Uint8Array | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 0; at + 8 <= bytes.byteLength; ) {
    const size = view.getUint32(at);
    if (size < 8 || at + size > bytes.byteLength) return null;
    const name = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const body = bytes.subarray(at + 8, at + size);
    if (name === type) return body;
    if (BOX_CONTAINERS.has(name)) {
      const nested = findBox(body, type);
      if (nested) return nested;
    }
    at += size;
  }
  return null;
}

function bodyOf(bytes: Uint8Array, type: string): DataView {
  const body = findBox(bytes, type);
  if (!body) throw new Error(`no ${type} box`);
  return new DataView(body.buffer, body.byteOffset, body.byteLength);
}

/** Where a fragment says its media starts, in media timescale units, at either box width. */
function baseMediaDecodeTime(tfdt: DataView): number {
  return tfdt.getUint8(0) === 0 ? tfdt.getUint32(4) : Number(tfdt.getBigUint64(4));
}

/**
 * The composition offset of a `trun`'s first sample: how far its PRESENTATION time sits from
 * its decode time, in media timescale units. Zero means the fragment's first picture is shown
 * exactly where the fragment says it starts.
 *
 * Read through the flags rather than at a fixed index, because which per-sample fields are
 * present is exactly what `negative_cts_offsets` changes.
 */
function firstSampleCompositionOffset(trun: DataView): number {
  const flags = trun.getUint32(0) & 0xff_ff_ff;
  const HAS_DATA_OFFSET = 0x1;
  const HAS_FIRST_SAMPLE_FLAGS = 0x4;
  const HAS_DURATION = 0x100;
  const HAS_SIZE = 0x200;
  const HAS_FLAGS = 0x400;
  const HAS_COMPOSITION_OFFSET = 0x800;
  if (!(flags & HAS_COMPOSITION_OFFSET)) return 0;
  let at = 8;
  if (flags & HAS_DATA_OFFSET) at += 4;
  if (flags & HAS_FIRST_SAMPLE_FLAGS) at += 4;
  for (const present of [HAS_DURATION, HAS_SIZE, HAS_FLAGS]) if (flags & present) at += 4;
  // Signed from version 1 on, which is what lets the reorder delay live here at all.
  return trun.getUint8(0) === 0 ? trun.getUint32(at) : trun.getInt32(at);
}

describe("a produced segment carries its own position, so nothing has to infer it", () => {
  const init = Uint8Array.from(atob(RECORDED_INIT), (c) => c.charCodeAt(0));
  const fragment = Uint8Array.from(atob(RECORDED_FRAGMENT_HEADER), (c) => c.charCodeAt(0));

  /**
   * THE EDIT LIST IS THE DEFECT, not a detail of it. ffmpeg's default fMP4 output hides the
   * segment's position in an `elst` -- an empty edit whose duration is the start, plus an
   * entry trimming the B-frame reorder delay -- and hls.js implements no edit lists at all
   * (its source contains neither `elst` nor `edts`). A consumer that cannot read the placement
   * has to infer it, and inferring it is what drifted 0.083 s per fragment.
   */
  test("the initialisation segment carries no edit list to be ignored", () => {
    expect(findBox(init, "edts")).toBeNull();
    expect(findBox(init, "elst")).toBeNull();
  });

  test("the fragment's decode time IS its boundary, rather than zero", () => {
    const timescale = bodyOf(init, "mdhd").getUint32(12);
    const startsAt = baseMediaDecodeTime(bodyOf(fragment, "tfdt")) / timescale;
    expect(timescale).toBe(16_000);
    expect(startsAt).toBeCloseTo(RECORDED_SEGMENT_START_SEC, 6);
  });

  /**
   * The reorder delay has to go somewhere. It used to be a positive bias on every sample,
   * cancelled by an edit list entry nobody downstream read; `negative_cts_offsets` puts it in
   * the samples that actually need it, so the FIRST one presents exactly where it decodes and
   * a fragment's start needs no correction.
   */
  test("the first picture is presented exactly where the fragment starts", () => {
    expect(firstSampleCompositionOffset(bodyOf(fragment, "trun"))).toBe(0);
  });
});
