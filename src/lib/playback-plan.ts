/**
 * Deciding what ffmpeg has to DO to make one file playable in one browser.
 *
 * Entirely pure: streams in, a plan and an argv out. No spawn, no filesystem, no clock.
 * `media-probe.ts` produces the input and `transcode-session.ts` runs the output, and
 * keeping the decision away from both is what makes the interesting half testable against
 * a hundred stream layouts in milliseconds.
 *
 * ## What the library actually needs, measured 2026-09-08
 *
 * From an ffprobe sample of the real movie library, and it is the reason this file is
 * shaped the way it is:
 *
 * | | |
 * |---|---|
 * | containers | **1135 mkv vs 38 mp4** -- so remux is needed for ~97% of titles |
 * | video | 54% hevc, 46% h264 |
 * | first audio track | 47% eac3, 22% ac3, 8% truehd, 7% dts, 14% aac |
 *
 * **So the expensive-sounding problem is the cheap one.** Video mostly does NOT need
 * re-encoding: h264 plays everywhere and hevc plays in Safari and hardware-decode Chrome.
 * What fails is AUDIO -- 86% of primary tracks are Dolby or DTS, which Chromium ships no
 * licence for and Firefox will not play. Transcoding one audio track to AAC costs under 5%
 * of a core; re-encoding 4K video on the deployment target (a Celeron J4125) costs most of
 * the machine. The whole point of this module is to reach for the first and avoid the
 * second.
 *
 * > [!IMPORTANT] CAPABILITIES COME FROM THE BROWSER, NEVER FROM A USER-AGENT STRING
 * > `MediaSource.isTypeSupported` answers exactly this question, in the only place that
 * > actually knows: HEVC in Chrome depends on the machine's hardware decoder, not on the
 * > version. Sniffing a UA would be a guess about somebody else's GPU, and it would be
 * > wrong in both directions -- transcoding for a client that could have direct-played, and
 * > direct-playing to one that shows a black rectangle.
 * >
 * > A client that offers nothing gets `CONSERVATIVE_CLIENT`, which is the floor every
 * > browser has met for a decade. Failing toward "transcode" is right: it costs CPU and it
 * > works, where failing the other way produces a player that spins forever.
 */

/** What the browser told us it can decode. Codec names are ffmpeg's, lowercased. */
export interface ClientCapabilities {
  /** e.g. `["h264", "hevc"]`. */
  video: readonly string[];
  /** e.g. `["aac", "eac3"]`. */
  audio: readonly string[];
}

/**
 * What every browser has played for a decade, and what a client that declares nothing gets.
 *
 * Deliberately excludes hevc and every Dolby codec: those are exactly the two axes real
 * clients disagree on, so assuming them is how a plan produces silence or a black frame.
 */
export const CONSERVATIVE_CLIENT: ClientCapabilities = { video: ["h264"], audio: ["aac"] };

/** One stream out of the probe, narrowed to what a decision reads. */
export interface ProbedStream {
  index: number;
  codec_type: "video" | "audio" | "subtitle" | string;
  codec_name?: string;
  /** Present on audio. */
  channels?: number;
  /** BCP-47-ish, as the container tagged it. */
  language?: string;
  width?: number;
  height?: number;
  /** 1 when the container marks the stream default. */
  isDefault?: boolean;
}

export interface ProbedMedia {
  streams: ProbedStream[];
  /** Seconds, from the container. `null` when the container does not say. */
  durationSec: number | null;
  /** The container's own name, e.g. `matroska,webm`. */
  formatName: string | null;
}

export type StreamAction = "copy" | "transcode";
export type SubtitleAction = "none" | "extract" | "burn";

export interface PlaybackPlan {
  video: { action: StreamAction; sourceIndex: number | null; codec: string };
  audio: { action: StreamAction; sourceIndex: number | null; codec: string };
  subtitles: { action: SubtitleAction; sourceIndex: number | null };
  /**
   * Every decision in words, in order.
   *
   * Not decoration: the admin player draws it, and it is the only thing that answers "why
   * is this one pinning the CPU" without reading a log on the NAS.
   */
  reasons: string[];
}

/**
 * Subtitle codecs that are BITMAPS, so the only way to show them is to draw them onto the
 * video -- which forces a full video re-encode even when the video would otherwise copy.
 *
 * This is the single most expensive decision in the file, which is why the list is closed
 * and explicit rather than an "is it not text" test: a codec nobody recognises should fall
 * through to "no subtitles" rather than silently triggering the costly path.
 */
const BITMAP_SUBTITLES = new Set(["hdmv_pgs_subtitle", "pgssub", "dvd_subtitle", "dvdsub", "xsub"]);

/** Text subtitle codecs ffmpeg can convert to WebVTT for effectively nothing. */
const TEXT_SUBTITLES = new Set(["subrip", "srt", "ass", "ssa", "mov_text", "webvtt", "text"]);

/** What we re-encode TO when we must. Not configurable: these are the universal floor. */
const TARGET_VIDEO = "h264";
const TARGET_AUDIO = "aac";

function firstOfType(streams: readonly ProbedStream[], type: string): ProbedStream | null {
  const of = streams.filter((s) => s.codec_type === type);
  if (of.length === 0) return null;
  return of.find((s) => s.isDefault) ?? of[0] ?? null;
}

/**
 * Pick the subtitle track to use, or none.
 *
 * **Preferring a TEXT track over a bitmap one is a performance decision, not a cosmetic
 * one.** A file carrying both PGS and SRT can be served with the video copied if the SRT is
 * chosen and needs a full re-encode if the PGS is. So text wins whenever both exist, and a
 * default flag only breaks ties within a kind.
 */
function pickSubtitle(
  streams: readonly ProbedStream[],
): { stream: ProbedStream; action: SubtitleAction } | null {
  const subs = streams.filter((s) => s.codec_type === "subtitle");
  const text = subs.filter((s) => TEXT_SUBTITLES.has((s.codec_name ?? "").toLowerCase()));
  if (text.length > 0) {
    return { stream: text.find((s) => s.isDefault) ?? (text[0] as ProbedStream), action: "extract" };
  }
  const bitmap = subs.filter((s) => BITMAP_SUBTITLES.has((s.codec_name ?? "").toLowerCase()));
  if (bitmap.length > 0) {
    return { stream: bitmap.find((s) => s.isDefault) ?? (bitmap[0] as ProbedStream), action: "burn" };
  }
  return null;
}

/**
 * Decide the plan.
 *
 * `wantSubtitles` defaults to FALSE, and that default is the expensive one inverted on
 * purpose: a reader who has not asked for subtitles must never silently buy a full video
 * re-encode because the file happens to carry a PGS track. Asking for them is a choice with
 * a cost, and the cost is named in `reasons`.
 */
export function planPlayback(
  probe: ProbedMedia,
  client: ClientCapabilities = CONSERVATIVE_CLIENT,
  opts: { wantSubtitles?: boolean } = {},
): PlaybackPlan {
  const reasons: string[] = [];
  const video = firstOfType(probe.streams, "video");
  const audio = firstOfType(probe.streams, "audio");

  const videoCodec = (video?.codec_name ?? "").toLowerCase();
  const audioCodec = (audio?.codec_name ?? "").toLowerCase();
  const canVideo = client.video.map((c) => c.toLowerCase());
  const canAudio = client.audio.map((c) => c.toLowerCase());

  // --- subtitles first: a burn-in forces the video decision, so it cannot be decided after
  const picked = opts.wantSubtitles ? pickSubtitle(probe.streams) : null;
  const subtitleAction: SubtitleAction = picked?.action ?? "none";
  if (picked?.action === "burn") {
    reasons.push(
      `subtitles are ${picked.stream.codec_name} (a bitmap), so they must be burned in -- this forces a full video re-encode`,
    );
  } else if (picked?.action === "extract") {
    reasons.push(`subtitles are ${picked.stream.codec_name}, converted to WebVTT at no cost`);
  }

  // --- video
  let videoAction: StreamAction;
  if (!video) {
    videoAction = "copy";
    reasons.push("no video stream");
  } else if (subtitleAction === "burn") {
    videoAction = "transcode";
  } else if (canVideo.includes(videoCodec)) {
    videoAction = "copy";
    reasons.push(`video is ${videoCodec}, which this browser decodes -- copied`);
  } else {
    videoAction = "transcode";
    reasons.push(`video is ${videoCodec}, which this browser cannot decode -- re-encoded to ${TARGET_VIDEO}`);
  }

  // --- audio
  let audioAction: StreamAction;
  if (!audio) {
    audioAction = "copy";
    reasons.push("no audio stream");
  } else if (canAudio.includes(audioCodec)) {
    audioAction = "copy";
    reasons.push(`audio is ${audioCodec}, which this browser decodes -- copied`);
  } else {
    audioAction = "transcode";
    reasons.push(`audio is ${audioCodec}, which this browser cannot decode -- re-encoded to ${TARGET_AUDIO}`);
  }

  // The container is ALWAYS rewritten and it is worth saying so: 97% of this library is
  // Matroska, which no browser plays, and a reader looking at a plan whose every stream
  // says "copied" would otherwise wonder what ffmpeg is for.
  if (probe.formatName && !probe.formatName.includes("mp4")) {
    reasons.push(`container is ${probe.formatName}, repackaged as fragmented MP4 (no re-encode)`);
  }

  return {
    video: {
      action: videoAction,
      sourceIndex: video?.index ?? null,
      codec: videoAction === "copy" ? videoCodec : TARGET_VIDEO,
    },
    audio: {
      action: audioAction,
      sourceIndex: audio?.index ?? null,
      codec: audioAction === "copy" ? audioCodec : TARGET_AUDIO,
    },
    subtitles: { action: subtitleAction, sourceIndex: picked?.stream.index ?? null },
    reasons,
  };
}

/** True when this plan re-encodes video -- the only expensive outcome, and worth metering. */
export function isExpensive(plan: PlaybackPlan): boolean {
  return plan.video.action === "transcode";
}

export interface FfmpegOpts {
  input: string;
  /** Directory the HLS playlist and segments are written into. */
  outDir: string;
  /** Seconds to seek to before the first frame. 0 starts at the beginning. */
  seekSec?: number;
  /** `/dev/dri/renderD128` when QuickSync is available, else undefined for software. */
  vaapiDevice?: string;
  /** Seconds per segment. */
  segmentSec?: number;
  /**
   * How many seconds of input to burst-read before throttling to realtime.
   *
   * Undefined, zero, or an ffmpeg too old for the flag all fall back to plain `-re`. See
   * the pacing block in `ffmpegArgs` for why this is gated rather than assumed.
   */
  readrateBurstSec?: number;
}

/**
 * The argv, derived from the plan.
 *
 * Separate from `planPlayback` so the DECISION can be asserted without reading flags, and
 * so the flags can be asserted without re-deriving the decision.
 *
 * > [!IMPORTANT] `-ss` GOES BEFORE `-i`, and the difference is minutes
 * > Before the input it is an INPUT seek -- ffmpeg jumps the demuxer to the nearest
 * > keyframe and starts there. After the input it is an OUTPUT seek, which decodes and
 * > discards everything from the start of the file, so seeking two hours into a film reads
 * > two hours of video before emitting a frame. Both spellings "work"; only one returns.
 *
 * > [!IMPORTANT] Fragmented MP4 segments, never MPEG-TS
 * > `hls_segment_type: fmp4` is what lets HEVC and AAC be COPIED into the segments. Plain
 * > TS cannot carry HEVC in any way Safari accepts, so the default segment type would
 * > silently force a video re-encode on the 54% of this library that is HEVC -- the exact
 * > cost this module exists to avoid.
 */
export function ffmpegArgs(plan: PlaybackPlan, opts: FfmpegOpts): string[] {
  const segment = opts.segmentSec ?? 4;
  const args: string[] = ["-hide_banner", "-loglevel", "error", "-nostdin"];

  // Hardware decode is only wired up when we are also encoding: decoding to a VAAPI surface
  // and then copying the stream is pure overhead, and it breaks the copy path outright.
  const hw = opts.vaapiDevice && plan.video.action === "transcode";
  if (hw)
    args.push(
      "-hwaccel",
      "vaapi",
      "-hwaccel_output_format",
      "vaapi",
      "-vaapi_device",
      opts.vaapiDevice as string,
    );

  if (opts.seekSec && opts.seekSec > 0) args.push("-ss", String(opts.seekSec));

  /*
    PACE THE READ, or one viewer owns the machine.

    ffmpeg has no reason to pace itself: told to transcode a 93-minute film it encodes as
    fast as the hardware allows and stops when the film is done. Measured on an M1 Max
    2026-09-08 -- ONE software 4K HEVC-to-h264 session sat at **344% CPU** and pushed the
    load average past 30, producing an hour of video for somebody who had watched nine
    seconds of it. On the deployment target, a four-thread Celeron, that is the whole box.

    Head to head on the same 1080p HEVC re-encode, 15 seconds of wall clock:

    | | CPU | video produced |
    |---|---|---|
    | unpaced | 214.7% | 32 s |
    | `-readrate 1` | 87.4% | 8 s |

    **BURST FIRST, THEN THROTTLE**, which is better than either extreme and is what
    `readrateBurstSec` buys. Flat realtime keeps the player permanently one segment from
    starving, so any hiccup is a stall; bursting a buffer and then settling gives an instant
    start AND a bounded steady state. `-readrate_catchup` lets it briefly exceed realtime if
    it falls behind, which is the recovery the flat form has no way to express.

    The flags are gated on `readrateBurstSec` because they are NOT universal --
    `-readrate_initial_burst` arrived in ffmpeg 6.1 and `-readrate_catchup` in 7.1, and an
    unknown option is a hard error rather than a warning, so guessing would turn an older
    container into a server where nothing plays. The caller probes once at boot, the same
    shape as `vaapiDevice`, and passing nothing falls back to plain `-re`, which every
    ffmpeg worth running has had for a decade.

    The cost, already paid before this existed: the player cannot buffer the whole film, so
    seeking past the buffer needs a new session rather than a scrub. Seeking already works
    that way here -- the offset is part of the session key.
  */
  if (opts.readrateBurstSec && opts.readrateBurstSec > 0) {
    args.push(
      "-readrate",
      "1",
      "-readrate_initial_burst",
      String(opts.readrateBurstSec),
      "-readrate_catchup",
      "2",
    );
  } else {
    args.push("-re");
  }
  args.push("-i", opts.input);

  if (plan.video.sourceIndex !== null) args.push("-map", `0:${plan.video.sourceIndex}`);
  if (plan.audio.sourceIndex !== null) args.push("-map", `0:${plan.audio.sourceIndex}`);

  if (plan.video.action === "copy") {
    args.push("-c:v", "copy");
  } else if (hw) {
    args.push("-c:v", "h264_vaapi", "-b:v", "6M");
  } else {
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "21");
  }

  args.push("-c:a", plan.audio.action === "copy" ? "copy" : "aac");
  if (plan.audio.action === "transcode") args.push("-ac", "2", "-b:a", "192k");

  args.push(
    "-f",
    "hls",
    "-hls_time",
    String(segment),
    "-hls_playlist_type",
    "event",
    "-hls_segment_type",
    "fmp4",
    "-hls_flags",
    "independent_segments",
    // RELATIVE segment names, which is what lets a client retarget them at a different
    // endpoint per segment. An absolute base here would weld every segment to one address
    // and make multi-homed playback impossible without rewriting the playlist.
    "-hls_fmp4_init_filename",
    "init.mp4",
    "-hls_segment_filename",
    `${opts.outDir}/seg%05d.m4s`,
    `${opts.outDir}/index.m3u8`,
  );
  return args;
}
