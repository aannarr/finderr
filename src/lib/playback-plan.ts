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

import { type EncoderChoice, SOFTWARE } from "./encoder";
import { RUN_INIT_NAME, SEGMENT_FILE_PATTERN } from "./hls-timeline";

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
  /** Directory this run writes its playlist, init segment and media segment into. */
  outDir: string;
  /** Which segment of the timeline to produce, and the range it covers. */
  segment: { index: number; startSec: number; endSec: number };
  /**
   * Which encoder to use when the video must be re-encoded.
   *
   * Comes from `chooseEncoder` (`./encoder.ts`), probed once at boot. Absent means
   * software, which is always correct and always slow.
   */
  encoder?: EncoderChoice;
}

/**
 * How far PAST the segment's end a COPY reads, so the muxer can close the segment.
 *
 * > [!CAUTION] THE MUXER CUTS THE SEGMENT, `-to` ONLY STOPS THE READ, and the difference
 * > shows up as a stutter
 * > `-to` is not a frame-accurate cut for a stream copy: it stops on decode order, and with
 * > B-frames the last packets written have presentation times PAST it. Measured 2026-09-08
 * > on a 1080p h264 file, `-to 2416.414` produced video running to 2416.581 -- four frames
 * > long. hls.js sizes a fragment from the samples it received, so those four frames made
 * > every fragment 0.167 s longer than its `#EXTINF`; hls.js then placed the next fragment
 * > that much further along, and Chromium's buffer ended up with a ~0.29 s HOLE at every
 * > boundary, reported as `bufferStalledError` and `bufferSeekOverHole` once per segment.
 * >
 * > The HLS muxer, told `-hls_time` equal to the segment's own length, cuts exactly at the
 * > next keyframe -- which IS the next boundary -- and writes an `#EXTINF` matching ours to
 * > the microsecond. So the muxer does the cutting and the read simply has to outlast it:
 * > this is how much further it reads so the muxer sees that keyframe and closes. Whatever
 * > the run writes past the segment we asked for is dropped with its working directory.
 */
const SEGMENT_TAIL_SLACK_SEC = 2;

/**
 * How far PAST a copy-mode boundary to ask ffmpeg to seek, so that it lands ON it.
 *
 * > [!CAUTION] ffmpeg's `-ss` DELIBERATELY UNDERSHOOTS, and without this the segment is wrong
 * > `ffmpeg.c` subtracts `3/23` of a second -- about 130 ms -- from a seek target on any input
 * > whose video has a reorder delay, to be safe about DTS. On a container seeking by index
 * > that is not a small imprecision: it drops the search below the index entry you asked for
 * > and lands on the PREVIOUS one. Measured 2026-09-08 on a 2160p HEVC file, `-ss 3969.382`
 * > -- an exact index entry -- produced a segment starting at 3962.876, **6.5 s early**, while
 * > `-ss 3969.582` produced one starting at 3969.382 exactly.
 * >
 * > That 6.5 s is not a cosmetic overshoot. hls.js re-times a fragment from the media it
 * > actually received, so a segment longer than its `#EXTINF` stretches the timeline, and the
 * > buffer ends up with a hole at every boundary -- measured in Chromium as ~1.3 s gaps and a
 * > steady stream of `bufferAppendNoProgress`.
 * >
 * > 200 ms is comfortably more than 130 and comfortably less than the gap between two index
 * > entries, which is a cluster -- seconds. It applies ONLY to a copy: a re-encode decodes
 * > from the previous keyframe and discards, so it starts exactly where it was asked to and a
 * > nudge would make it skip 200 ms of film.
 */
const SEEK_NUDGE_SEC = 0.2;

/**
 * The argv that produces ONE segment, derived from the plan.
 *
 * Separate from `planPlayback` so the DECISION can be asserted without reading flags, and
 * so the flags can be asserted without re-deriving the decision.
 *
 * > [!IMPORTANT] ONE RUN PER SEGMENT, and it is what makes the scrub bar work
 * > The alternative is one long ffmpeg writing a playlist as it goes -- which offers a
 * > timeline only as long as what it has already encoded, so there is nothing at 01:20:00 to
 * > seek to. Here the server states the whole timeline up front (`hls-timeline.ts`) and this
 * > argv makes whichever segment the player asks for. Measured on the NAS over the array
 * > 2026-09-08: **0.07-0.08 s to produce one ten-second copy-mode segment**, deep into a
 * > 3.4 GB file, which is what makes an on-demand segment affordable at all.
 * >
 * > It also deletes a cost rather than adding one. A long run has to be PACED or it encodes
 * > the whole film for somebody who watched nine seconds; a run bounded by one segment stops
 * > on its own, and a viewer who pauses stops buying frames immediately. So there is no
 * > `-re` and no `-readrate` here, and adding one would be actively wrong: it would make
 * > every six-second segment take six seconds of wall clock.
 *
 * > [!IMPORTANT] `-ss` GOES BEFORE `-i`, and the difference is minutes
 * > Before the input it is an INPUT seek -- ffmpeg jumps the demuxer to the nearest
 * > keyframe and starts there. After the input it is an OUTPUT seek, which decodes and
 * > discards everything from the start of the file, so seeking two hours into a film reads
 * > two hours of video before emitting a frame. Both spellings "work"; only one returns.
 *
 * > [!CAUTION] `-copyts` IS WHAT PLACES THE SEGMENT ON THE TIMELINE, and `-to` depends on it
 * > Independently produced segments have to carry the source's own timestamps, or every one
 * > of them claims to start at zero and the player has no way to assemble them. `-copyts`
 * > keeps them; `-avoid_negative_ts disabled` stops the muxer helpfully shifting them back
 * > to zero again. With `-copyts` in force `-to` is read in the INPUT's timeline, so it is
 * > an absolute position in the film rather than a duration -- which is exactly what a
 * > segment boundary is. Measured 2026-09-08: the same request spelled `-t <duration>`
 * > produced 18.35 s of media instead of 10.34 s, because `-t` counts from the seek TARGET
 * > while the copy actually begins at the container index granularity before it.
 *
 * > [!IMPORTANT] Fragmented MP4 segments, never MPEG-TS
 * > `hls_segment_type: fmp4` is what lets HEVC and AAC be COPIED into the segments. Plain
 * > TS cannot carry HEVC in any way Safari accepts, so the default segment type would
 * > silently force a video re-encode on the 54% of this library that is HEVC -- the exact
 * > cost this module exists to avoid.
 */
export function ffmpegArgs(plan: PlaybackPlan, opts: FfmpegOpts): string[] {
  const args: string[] = ["-hide_banner", "-loglevel", "error", "-nostdin"];

  /*
    Hardware acceleration is wired up ONLY when there is an encode to accelerate.

    Decoding into a hardware surface and then COPYING the stream is pure overhead, and for
    VAAPI it breaks the copy path outright -- the frames end up somewhere `-c:v copy` cannot
    reach. So a remux stays entirely software whatever the machine can do, which costs
    nothing: a remux never touches a pixel.
  */
  const enc = plan.video.action === "transcode" ? (opts.encoder ?? SOFTWARE) : SOFTWARE;
  const hw = enc.hardware;
  if (hw && enc.hwaccel) {
    args.push("-hwaccel", enc.hwaccel);
    // Only VAAPI keeps its frames on the GPU and needs its device named. VideoToolbox and
    // NVENC take the accelerator alone, and handing them an output format they do not
    // expect is a spawn error rather than an ignored flag.
    if (enc.vaapiDevice) {
      args.push("-hwaccel_output_format", "vaapi", "-vaapi_device", enc.vaapiDevice);
    }
  }

  const copying = plan.video.action === "copy";
  if (opts.segment.startSec > 0) {
    if (copying) {
      // See SEEK_NUDGE_SEC. `-noaccurate_seek` is the other half: without it ffmpeg discards
      // everything before the nudged target, and since every AUDIO packet is a key packet it
      // discards those happily -- leaving a nudge-sized hole in the sound at every boundary
      // while the video, which can only start at a keyframe, starts in the right place.
      args.push("-noaccurate_seek", "-ss", (opts.segment.startSec + SEEK_NUDGE_SEC).toFixed(6));
    } else {
      // A re-encode decodes from the previous keyframe and discards, so it starts exactly
      // where it is asked to and needs neither the nudge nor the slack below.
      args.push("-ss", opts.segment.startSec.toFixed(6));
    }
  }
  args.push("-i", opts.input);
  const readUntil = opts.segment.endSec + (copying ? SEGMENT_TAIL_SLACK_SEC : 0);
  args.push("-copyts", "-avoid_negative_ts", "disabled", "-to", readUntil.toFixed(6));

  if (plan.video.sourceIndex !== null) args.push("-map", `0:${plan.video.sourceIndex}`);
  if (plan.audio.sourceIndex !== null) args.push("-map", `0:${plan.audio.sourceIndex}`);

  // A re-encode needs no `-force_key_frames`: a fresh encoder emits an IDR on its first
  // frame, and every segment is a fresh encoder. The segment is independently decodable by
  // construction, which is the property `EXT-X-INDEPENDENT-SEGMENTS` promises.
  if (plan.video.action === "copy") {
    args.push("-c:v", "copy");
  } else if (hw) {
    // Hardware encoders take a BITRATE rather than a quality target: none of the three
    // implements `-crf`, and passing it is a spawn error rather than an ignored flag.
    args.push("-c:v", enc.encoder, "-b:v", "6M");
  } else {
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "21");
  }

  args.push("-c:a", plan.audio.action === "copy" ? "copy" : "aac");
  if (plan.audio.action === "transcode") args.push("-ac", "2", "-b:a", "192k");

  args.push(
    "-f",
    "hls",
    // The segment's own length, so the muxer's cutting rule -- the first keyframe at or past
    // this -- lands on the NEXT boundary, which is a keyframe by construction.
    "-hls_time",
    (opts.segment.endSec - opts.segment.startSec).toFixed(6),
    "-hls_playlist_type",
    "vod",
    "-hls_segment_type",
    "fmp4",
    "-hls_flags",
    "independent_segments",
    // `-start_number` names the file after its place in the WHOLE film rather than after
    // this run's position in it, so a run started at segment 400 writes seg00400.m4s and the
    // playlist the client already holds points straight at it.
    "-start_number",
    String(opts.segment.index),
    // `hls_fmp4_init_filename` is resolved against the PLAYLIST's directory, not the working
    // directory, so both must name the same place or ffmpeg fails at header-write time with
    // "Failed to open segment".
    "-hls_fmp4_init_filename",
    RUN_INIT_NAME,
    "-hls_segment_filename",
    `${opts.outDir}/${SEGMENT_FILE_PATTERN}`,
    // ffmpeg insists on a playlist output. Nothing reads this one -- the client is served
    // `hls-timeline.ts`'s complete VOD playlist, which knows about every segment rather than
    // only the one this run made.
    `${opts.outDir}/produced.m3u8`,
  );
  return args;
}
