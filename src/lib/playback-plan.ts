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
import {
  RUN_INIT_NAME,
  segmentFileName,
  segmentFilePattern,
  type Track,
  type TrackKind,
  type TrackLabel,
} from "./hls-timeline";

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
  /**
   * The muxer's own human label for this stream -- `Commentary by the director`, `English SDH`.
   *
   * The BEST name there is when it exists, because it is the only one that knows why a track
   * is there. Absent on most scene releases, which is why `trackName` has two fallbacks.
   */
  title?: string;
  width?: number;
  height?: number;
  /** 1 when the container marks the stream default. */
  isDefault?: boolean;
  /**
   * The container's `forced` flag: a track carrying only the lines a viewer MUST read -- alien
   * dialogue, a sign -- rather than the whole script.
   *
   * Read only to LABEL the rendition. It is deliberately not turned into HLS's `FORCED=YES`,
   * which asks a player to display the track without being told to: that would produce ffmpeg
   * runs for a rendition nobody selected, which is the one property this design must keep.
   */
  forced?: boolean;
  /** The container's `hearing_impaired` flag: subtitles that transcribe sound as well as speech. */
  hearingImpaired?: boolean;
}

export interface ProbedMedia {
  streams: ProbedStream[];
  /** Seconds, from the container. `null` when the container does not say. */
  durationSec: number | null;
  /** The container's own name, e.g. `matroska,webm`. */
  formatName: string | null;
}

export type StreamAction = "copy" | "transcode";

/** What every published rendition has: one source stream, and the codec it carries. */
interface Rendition {
  /** The stream this rendition is made of. Never null -- a rendition with none is not published. */
  sourceIndex: number;
  /** ffmpeg's name for what the rendition ends up carrying. */
  codec: string;
}

/** The one video rendition. Null on `PlaybackPlan` when the file has no video stream at all. */
export interface VideoRendition extends Rendition {
  action: StreamAction;
  /**
   * Width to scale the re-encode down to, or `null` to leave the frame alone.
   *
   * Decided HERE rather than in the argv because it is the only place that has seen the
   * source's dimensions -- and because an unconditional filter would UPSCALE a 480p source,
   * which costs pixels to make the picture worse. Null on every copy, since a copy has no
   * frame to resize.
   */
  scaleWidth: number | null;
}

/** One audio rendition. Each carries its own copy/transcode answer, from its own codec. */
export interface AudioRendition extends Rendition {
  action: StreamAction;
  label: TrackLabel;
}

/**
 * One subtitle rendition, always extracted to WebVTT.
 *
 * There is no `action` and there used to be, spelled `"none" | "extract"`. With a LIST of
 * renditions "none" is the empty list, so the state cannot be represented twice -- and there
 * has never been another answer: a text track converts to WebVTT for effectively nothing, and
 * a BITMAP one is refused before it becomes a rendition at all.
 *
 * There was a third answer once. `burn` forced a full video re-encode -- drawing a bitmap onto
 * the picture is a pixel operation -- and then nothing burned anything, so asking for the PGS
 * tracks on a title bought the most expensive outcome in this module and returned a video with
 * no subtitles on it. The bitmap codecs are still RECOGNISED -- see `BITMAP_SUBTITLES` --
 * because a file whose only subtitles are bitmaps deserves to be told so in `reasons` rather
 * than silently given none.
 */
export interface SubtitleRendition extends Rendition {
  label: TrackLabel;
}

export interface PlaybackPlan {
  /** Null when the file has no video stream: an audio-only title has one thing to play. */
  video: VideoRendition | null;
  /**
   * Every audio track the file has, in OFFER order -- the container's own default first.
   *
   * All of them, rather than a chosen subset, and that is a decision rather than an oversight:
   * a rendition costs one manifest line and produces nothing until a viewer selects it, while
   * a rule for choosing between languages is a rule about who this server is for. 19% of the
   * sampled library carries more than one.
   */
  audio: readonly AudioRendition[];
  /** Every TEXT subtitle track, in source order. Empty when there is none we can show. */
  subtitles: readonly SubtitleRendition[];
  /**
   * Every decision in words, in order.
   *
   * Not decoration: the admin player draws it, and it is the only thing that answers "why
   * is this one pinning the CPU" without reading a log on the NAS.
   */
  reasons: string[];
}

/**
 * Subtitle codecs that are BITMAPS, so the only way to show them would be to draw them onto
 * the video -- which is a pixel operation and forces a full re-encode of a stream that would
 * otherwise be copied.
 *
 * **Nothing burns them in and the plan says so.** This list exists purely so the refusal can
 * NAME the codec: a viewer told "the only subtitles in this file are hdmv_pgs_subtitle, which
 * we cannot show" knows what to do about it, where a plan that silently reports none does not.
 * Closed and explicit rather than an "is it not text" test, so a codec nobody recognises falls
 * through to plain "no subtitles" rather than into a claim about what it is.
 */
const BITMAP_SUBTITLES = new Set(["hdmv_pgs_subtitle", "pgssub", "dvd_subtitle", "dvdsub", "xsub"]);

/** Text subtitle codecs ffmpeg can convert to WebVTT for effectively nothing. */
const TEXT_SUBTITLES = new Set(["subrip", "srt", "ass", "ssa", "mov_text", "webvtt", "text"]);

/** What we re-encode TO when we must. Not configurable: these are the universal floor. */
const TARGET_VIDEO = "h264";
const TARGET_AUDIO = "aac";

/**
 * The widest frame a re-encode will produce. Anything wider is scaled down to it.
 *
 * > [!IMPORTANT] LOW QUALITY IS THE REQUIREMENT HERE, not a compromise -- aannarr, 2026-09-08
 * > *"test the ffmpeg ideas and run it at low quality, low cpu :-).. transcoding should be
 * > low effort"*. The deployment target is a 10 W Celeron J4125 and every earlier number in
 * > this module was measured on an M1 Max, so nothing was carried over.
 * >
 * > A cap on WIDTH rather than on height, because it means the same thing for both shapes
 * > this library comes in: 1920x1080 becomes exactly 1280x720, and a 2.40:1 scope film at
 * > 1920x800 becomes 1280x534. Capping the height would leave a scope film at 1728 wide --
 * > more pixels than the 16:9 case it was meant to match.
 * >
 * > Measured on the J4125, 10 s of 1080p HEVC Main 10 to h264, 2026-09-08. The cap is worth
 * > roughly half the software path on its own:
 * >
 * > | path | CPU | wall | vs realtime |
 * > |---|---|---|---|
 * > | `libx264` veryfast crf 21 at 1920x800 | 24.67 s | 7.32 s | 1.37x |
 * > | `libx264` veryfast crf 23 at 1280x534 | 11.27 s | 4.12 s | 2.43x |
 * > | `h264_vaapi` at 1920x800, 6M | 1.13 s | 1.72 s | 5.8x |
 * > | `h264_vaapi` at 1280x534, 2500k | 0.98 s | 1.29 s | 7.8x |
 * >
 * > `superfast` was measured too and came out SLOWER than `veryfast` on this content (14.5 s
 * > against 11.0 s of CPU), so the preset ladder is not the lever here and the pixel count is.
 */
export const MAX_TRANSCODE_WIDTH = 1280;

/**
 * The target bitrate for a hardware re-encode, which takes a rate rather than a quality.
 *
 * 2500k at 1280 wide measured 2.3 Mbps of actual output on the J4125 -- VAAPI's rate control
 * tracks the target closely rather than undershooting it. The number it replaced was `6M`,
 * which produced a 6.99 MB ten-second segment: **8.9x the bytes `libx264` spent on the same
 * ten seconds at the same resolution**, because a bitrate target fills its budget whatever
 * the scene contains. That is bandwidth nobody asked for on a household's uplink.
 */
const HARDWARE_BITRATE = "2500k";

/**
 * The software quality target, and the preset that reaches it.
 *
 * `crf 23` rather than 21 under the low-quality instruction above. Software is the FALLBACK
 * and it is 11x the CPU of the hardware path even after the width cap, so the goal here is to
 * remain watchable rather than to compete with it.
 */
const SOFTWARE_PRESET = "veryfast";
const SOFTWARE_CRF = "23";

/**
 * The pixel format every non-VAAPI re-encode is pinned to.
 *
 * > [!CAUTION] WITHOUT THIS, A 10-BIT SOURCE PRODUCES h264 HIGH 10, WHICH NO BROWSER DECODES
 * > `libx264` follows its input's format, so a `yuv420p10le` source -- ordinary for the HEVC
 * > half of this library -- came out as `profile=High 10, pix_fmt=yuv420p10le`. Verified by
 * > probing the output on the Synology 2026-09-08. The transcode exists to make a file
 * > playable in a browser and was producing something LESS playable than the source, with
 * > every unit test green: the plan said "re-encoded to h264", and it was h264.
 * >
 * > VAAPI needs the same conversion and cannot take this flag -- its frames are GPU surfaces.
 * > It gets `format=nv12` inside `scale_vaapi` instead; see `videoFilter`.
 */
const SOFTWARE_PIXEL_FORMAT = "yuv420p";

/**
 * The format a VAAPI encode must be handed, whatever the source was.
 *
 * > [!CAUTION] `h264_vaapi` ON UHD 600 ENCODES 8-BIT ONLY, and a p010 surface is a hard failure
 * > A 10-bit HEVC source decodes into a p010 VAAPI surface, and handing that to `h264_vaapi`
 * > fails at encoder-open with `No usable encoding profile found` -- not a fallback, not a
 * > warning, a title that will not play. Measured on the J4125 2026-09-08 against a HEVC Main
 * > 10 film, which is an ordinary shape for the 54% of this library that is HEVC.
 * >
 * > Emitted unconditionally rather than only for 10-bit sources: an 8-bit source already
 * > decodes to nv12, so the conversion is a no-op there and one code path is worth more than
 * > a branch on a bit depth the plan would otherwise have to carry.
 */
const VAAPI_PIXEL_FORMAT = "nv12";

const codecOf = (s: ProbedStream) => (s.codec_name ?? "").toLowerCase();

/**
 * The audio tracks this file offers, in the order a viewer should meet them.
 *
 * The container's own default goes FIRST, and everything else keeps its source order. That
 * flag is the only preference expressed anywhere in the file about which track a viewer
 * wants, and putting it at position 0 means "which rendition plays by default" is a POSITION
 * rather than a second flag free to disagree with the order -- see `masterPlaylist`.
 */
function audioInOfferOrder(streams: readonly ProbedStream[]): ProbedStream[] {
  const audio = streams.filter((s) => s.codec_type === "audio");
  const defaultAt = audio.findIndex((s) => s.isDefault);
  if (defaultAt <= 0) return audio;
  return [audio[defaultAt] as ProbedStream, ...audio.filter((_, at) => at !== defaultAt)];
}

/**
 * The subtitle tracks this pipeline can actually publish, and -- when it can publish none --
 * the bitmap codec that was in the way.
 *
 * EVERY text track, in source order. On this library that is the whole point: **62 of 118
 * sampled films carry two or more TEXT subtitle tracks** (ffprobe over `/Volumes/plex/movie`,
 * 2026-09-08), and a single published track hands a viewer whichever one the muxer flagged --
 * frequently a forced-narrative track carrying four lines for the entire film.
 *
 * A file whose subtitles are ALL bitmaps yields nothing and a NAMED refusal, because showing
 * one would mean burning it into the picture and nothing does that -- see `SubtitleRendition`.
 */
function subtitlesToPublish(streams: readonly ProbedStream[]): {
  streams: ProbedStream[];
  refusedBitmap: string | null;
} {
  const subs = streams.filter((s) => s.codec_type === "subtitle");
  const text = subs.filter((s) => TEXT_SUBTITLES.has(codecOf(s)));
  if (text.length > 0) return { streams: text, refusedBitmap: null };
  return {
    streams: [],
    refusedBitmap: subs.find((s) => BITMAP_SUBTITLES.has(codecOf(s)))?.codec_name ?? null,
  };
}

/**
 * Decide the plan.
 *
 * `wantSubtitles` defaults to FALSE. It costs almost nothing now -- an extracted WebVTT
 * rendition never touches the video and hls.js fetches none of it until a viewer switches
 * subtitles on -- but it does decide whether the subtitle renditions are PUBLISHED at all,
 * and a caller that has not asked for them should not be handed them.
 */
export function planPlayback(
  probe: ProbedMedia,
  client: ClientCapabilities = CONSERVATIVE_CLIENT,
  opts: { wantSubtitles?: boolean } = {},
): PlaybackPlan {
  const reasons: string[] = [];
  const video = planVideo(probe, client, reasons);
  const audio = planAudio(probe, client, reasons);
  const subtitles = opts.wantSubtitles ? planSubtitles(probe, reasons) : [];

  // The container is ALWAYS rewritten and it is worth saying so: 97% of this library is
  // Matroska, which no browser plays, and a reader looking at a plan whose every stream
  // says "copied" would otherwise wonder what ffmpeg is for.
  if (probe.formatName && !probe.formatName.includes("mp4")) {
    reasons.push(`container is ${probe.formatName}, repackaged as fragmented MP4 (no re-encode)`);
  }
  return { video, audio, subtitles, reasons };
}

/** The one video rendition, or null when the file has no video stream to publish. */
function planVideo(probe: ProbedMedia, client: ClientCapabilities, reasons: string[]): VideoRendition | null {
  const streams = probe.streams.filter((s) => s.codec_type === "video");
  const stream = streams.find((s) => s.isDefault) ?? streams[0];
  if (!stream) {
    reasons.push("no video stream");
    return null;
  }
  const codec = codecOf(stream);
  const action: StreamAction = client.video.map((c) => c.toLowerCase()).includes(codec)
    ? "copy"
    : "transcode";
  reasons.push(
    action === "copy"
      ? `video is ${codec}, which this browser decodes -- copied`
      : `video is ${codec}, which this browser cannot decode -- re-encoded to ${TARGET_VIDEO}`,
  );
  const scaleWidth = action === "transcode" ? downscaleWidth(stream.width) : null;
  if (scaleWidth !== null) {
    reasons.push(
      `video is ${stream.width}px wide, scaled down to ${scaleWidth}px to keep the re-encode cheap`,
    );
  }
  return {
    action,
    sourceIndex: stream.index,
    codec: action === "copy" ? codec : TARGET_VIDEO,
    scaleWidth,
  };
}

/**
 * Every audio rendition, each with its OWN copy/transcode answer.
 *
 * Per track rather than per file, because the tracks genuinely differ: a release commonly
 * carries a lossless English track and an aac dub, and one of those copies where the other
 * cannot. Deciding once from the first track would re-encode a stream the browser could have
 * played, or copy one it cannot.
 */
function planAudio(probe: ProbedMedia, client: ClientCapabilities, reasons: string[]): AudioRendition[] {
  const streams = audioInOfferOrder(probe.streams);
  if (streams.length === 0) {
    reasons.push("no audio stream");
    return [];
  }
  const canPlay = client.audio.map((c) => c.toLowerCase());
  const renditions = withDistinctNames(
    streams.map((stream, ordinal): AudioRendition => {
      const codec = codecOf(stream);
      const action: StreamAction = canPlay.includes(codec) ? "copy" : "transcode";
      return {
        action,
        sourceIndex: stream.index,
        codec: action === "copy" ? codec : TARGET_AUDIO,
        label: labelFor(stream, "audio", ordinal),
      };
    }),
  );
  // The DEFAULT track's decision in full, because it is the one that will actually run, and
  // then ONE line naming what else is on offer -- a reason each would push twelve lines of
  // near-identical text at a reader on the files that carry twelve tracks.
  const sourceCodec = codecOf(streams[0] as ProbedStream);
  reasons.push(
    renditions[0]?.action === "copy"
      ? `audio is ${sourceCodec}, which this browser decodes -- copied`
      : `audio is ${sourceCodec}, which this browser cannot decode -- re-encoded to ${TARGET_AUDIO}`,
  );
  reasons.push(...offerReason("audio", renditions));
  return renditions;
}

/** Every publishable subtitle rendition, or none and the reason there are none. */
function planSubtitles(probe: ProbedMedia, reasons: string[]): SubtitleRendition[] {
  const { streams, refusedBitmap } = subtitlesToPublish(probe.streams);
  if (streams.length === 0) {
    if (refusedBitmap) {
      reasons.push(
        `the only subtitles here are ${refusedBitmap} (a bitmap), which could be shown only by burning them into the picture -- not supported, so none are published`,
      );
    }
    return [];
  }
  const renditions = withDistinctNames(
    streams.map(
      (stream, ordinal): SubtitleRendition => ({
        sourceIndex: stream.index,
        codec: codecOf(stream),
        label: labelFor(stream, "subtitles", ordinal),
      }),
    ),
  );
  reasons.push(
    `subtitles are ${renditions[0]?.codec}, published as selectable WebVTT renditions (no re-encode)`,
  );
  reasons.push(...offerReason("subtitles", renditions));
  return renditions;
}

/** What else is on the menu, in one line, or nothing when there is only one rendition. */
function offerReason(kind: TrackKind, renditions: readonly { label: TrackLabel }[]): string[] {
  if (renditions.length < 2) return [];
  return [`${renditions.length} ${kind} tracks offered: ${renditions.map((r) => r.label.name).join(", ")}`];
}

/**
 * Rename any rendition whose menu label collides with an earlier one.
 *
 * A file with six English subtitle tracks and no titles would otherwise put six entries called
 * "English" in the menu, which cannot be chosen from -- and that is the ordinary shape of a
 * scene release rather than a corner case. The suffix is positional (`English (2)`) because
 * there is nothing else left to tell them apart: the container said the same thing twice.
 */
function withDistinctNames<T extends { label: TrackLabel }>(renditions: T[]): T[] {
  const used = new Map<string, number>();
  return renditions.map((rendition) => {
    const { name } = rendition.label;
    const seen = used.get(name) ?? 0;
    used.set(name, seen + 1);
    if (seen === 0) return rendition;
    return { ...rendition, label: { ...rendition.label, name: `${name} (${seen + 1})` } };
  });
}

/** How one rendition is described to a viewer: the menu entry, and the language tag beside it. */
function labelFor(stream: ProbedStream, kind: TrackKind, ordinal: number): TrackLabel {
  return { name: trackName(stream, kind, ordinal), language: languageTag(stream.language) };
}

/**
 * What a player's menu shows for one rendition, best answer first.
 *
 * Three sources, in descending order of how much they know:
 *
 * 1. **The container's own title tag.** `Commentary by the director` is a fact nothing else in
 *    the file can reconstruct, so when it is there nothing else is added to it.
 * 2. **The language, spelled out in English.** `Intl.DisplayNames` maps ISO-639-2/B -- which is
 *    what Matroska actually writes (`ger`, `fre`, `chi`) -- as readily as BCP-47, so there is
 *    no language table here to go stale.
 * 3. **The kind and its position**, for a track the container said nothing about at all.
 *
 * The forced/SDH marker rides on 2 and 3 but never on 1, because a title already says what the
 * track is and appending to somebody's own words is how a menu ends up reading
 * `English SDH (SDH)`.
 */
function trackName(stream: ProbedStream, kind: TrackKind, ordinal: number): string {
  const title = cleanLabel(stream.title);
  if (title) return title;
  const base = languageName(stream.language) ?? defaultName(kind, ordinal);
  return cleanLabel(`${base}${trackMarker(stream)}`) || defaultName(kind, ordinal);
}

/** What a rendition is called when the container said nothing about it. */
function defaultName(kind: TrackKind, ordinal: number): string {
  const noun = kind === "audio" ? "Audio" : kind === "subtitles" ? "Subtitles" : "Video";
  return ordinal === 0 ? noun : `${noun} ${ordinal + 1}`;
}

/** The disposition worth showing in a menu, or nothing. `forced` wins: it is the narrower claim. */
function trackMarker(stream: ProbedStream): string {
  if (stream.forced) return " (forced)";
  return stream.hearingImpaired ? " (SDH)" : "";
}

/**
 * The language name in English, or null when the container said nothing we can read.
 *
 * `fallback: "none"` so an unrecognised subtag answers `undefined` rather than echoing itself
 * back as if it were a language -- a menu entry called `qaa` is worse than one called
 * `Subtitles 3`.
 */
function languageName(raw: string | undefined): string | null {
  const tag = languageTag(raw);
  if (!tag) return null;
  try {
    return LANGUAGE_NAMES.of(tag) ?? null;
  } catch {
    // `Intl.DisplayNames.of` THROWS a RangeError on a structurally invalid tag rather than
    // answering undefined, and container metadata is exactly where malformed tags live.
    return null;
  }
}

const LANGUAGE_NAMES = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });

/** ISO 639-2's code for "the container does not know", which is not a language to display. */
const UNDETERMINED_LANGUAGE = "und";

/**
 * The container's language tag, or null when it is not one.
 *
 * ONE sanitiser for both readers: the display lookup above, and the `LANGUAGE` attribute the
 * master playlist writes -- which goes into a manifest, so it must not be able to carry a
 * quote or a newline. RFC 5646's shape, loosely: subtags of letters and digits, joined by
 * hyphens. `eng`, `pt-BR` and `es-419` all pass; `en_US` and a title in Cyrillic do not.
 *
 * `und` is refused along with them, and it is the interesting case: it is perfectly
 * well-formed and it MEANS "the container does not know", so passing it through would put a
 * claim of ignorance in the manifest and render a menu entry as `Unknown language`.
 */
const LANGUAGE_TAG = /^[a-z]{2,8}(-[a-z0-9]{1,8})*$/;

function languageTag(raw: string | undefined): string | null {
  const tag = raw?.trim().toLowerCase();
  if (!tag || tag === UNDETERMINED_LANGUAGE) return null;
  return LANGUAGE_TAG.test(tag) ? tag : null;
}

/** The longest menu label worth carrying. A title tag is free text out of somebody's muxer. */
const MAX_LABEL_LENGTH = 60;

/**
 * A label safe to put in a manifest and short enough to read.
 *
 * The quote is the one that matters: `NAME="..."` is a quoted string with no escape sequence
 * in the HLS grammar, so a title containing `"` would end the attribute early and produce a
 * manifest a player rejects. Control characters go for the same reason -- a newline inside an
 * attribute ends the tag.
 */
function cleanLabel(raw: string | undefined): string {
  return (raw ?? "")
    .replace(/[\p{C}"]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LABEL_LENGTH);
}

/**
 * The width to scale a re-encode down to, or null to leave it alone.
 *
 * A source at or below the cap is left where it is: upscaling would spend pixels to make the
 * picture worse. A source whose width the container never stated is also left alone, because
 * a guess here is the one that produces a stretched frame.
 */
function downscaleWidth(sourceWidth: number | undefined): number | null {
  if (!sourceWidth || sourceWidth <= MAX_TRANSCODE_WIDTH) return null;
  return MAX_TRANSCODE_WIDTH;
}

/** True when this plan re-encodes video -- the only expensive outcome, and worth metering. */
export function isExpensive(plan: PlaybackPlan): boolean {
  return plan.video?.action === "transcode";
}

export interface FfmpegOpts {
  input: string;
  /** Directory this run writes its playlist, init segment and media segment into. */
  outDir: string;
  /**
   * Which rendition this run produces: a kind and which of that kind.
   *
   * One run makes ONE track, because a muxed segment can honour only one cutting rule and
   * the tracks need different ones -- see `hls-timeline.ts` for why that is what closes the
   * audio hole rather than an arrangement preference. The ordinal indexes the plan's list for
   * that kind, which is what makes `renditionFor` a lookup rather than a search.
   */
  track: Track;
  /** Which segment of that rendition's timeline to produce, and the range it covers. */
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
 * How far PAST the segment's end a VIDEO COPY reads, so the muxer can close the segment.
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
 * How far PAST a video-copy boundary to ask ffmpeg to seek, so that it lands ON it.
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
 * > entries, which is a cluster -- seconds. It applies ONLY to a video copy: a re-encode
 * > decodes from the previous keyframe and discards, so it starts exactly where it was asked
 * > to and a nudge would make it skip 200 ms of film, and an AUDIO run WANTS to start early
 * > because that is what makes its segment cover its whole declared range.
 */
const SEEK_NUDGE_SEC = 0.2;

/**
 * The `-hls_time` an AUDIO run gets: longer than any film, so the muxer never cuts.
 *
 * > [!CAUTION] THE AUDIO SEGMENT IS BOUNDED BY `-to` AND NOTHING ELSE, and that is the fix
 * > Told a real `-hls_time`, the muxer cuts that far after the run's FIRST packet -- and a
 * > copy-mode seek lands at the container's index granularity BEFORE the boundary, so the cut
 * > lands early by however much that was. Measured 2026-09-08 on a 1080p WEB-DL with 1.6 s
 * > Matroska clusters: `-ss 2400 -hls_time 6` produced [2398.400, 2404.416) where the playlist
 * > had declared [2400, 2406). Consecutive segments then abut only when the cluster spacing
 * > happens to divide the grid -- true on that file, not true in general, and a gap is exactly
 * > the bug this whole rendition split exists to remove.
 * >
 * > With no reachable cut the run writes everything it read as ONE segment, so a segment
 * > covers [wherever the seek landed, `-to`) -- a SUPERSET of its declared range, always. The
 * > start may be early and never late, so segment N ends exactly where segment N+1's declared
 * > range begins and N+1 begins at or before that. **No gap is possible by construction**
 * > rather than by measurement. Measured on the same file: [2398.400, 2406.016) then
 * > [2404.416, 2412.000), zero gap, 1.6 s of overlap that MSE simply overwrites. The
 * > re-encode path buys the same guarantee for 0.037 s of overlap, because a decode discards
 * > accurately.
 */
const AUDIO_NEVER_CUT_SEC = 86_400;

/**
 * How far BEFORE its own boundary a SUBTITLE run starts reading.
 *
 * A cue that begins in segment N and is still on screen in segment N+1 belongs to both. Play
 * straight through and it does not matter -- the cue was appended with its full duration when
 * segment N loaded and stays in the text track until it expires. **SEEKING is what needs
 * this**: land at 01:10:03 and the player fetches only the segment containing it, so a cue
 * that started at 01:10:00 would be missing until the next line of dialogue.
 *
 * Six seconds, because no cue in this library is that long: the longest measured in two whole
 * films was 4.959 s, with p99 at 4.125 s (1562 and 919 cues, extracted 2026-09-08). Reading
 * early emits some cues in two adjacent segments and that is HARMLESS by design rather than by
 * luck -- hls.js keys a cue on a hash of its start, end and text and refuses to add one it
 * already has, and its own source says so: *"Sometimes there are cue overlaps on segmented
 * vtts"*.
 *
 * It costs nothing to widen: a subtitle run reads text, and the segment it produced for the
 * measurement above took 0.07 s either way.
 */
const SUBTITLE_LEAD_SEC = 6;

/**
 * What the nested fMP4 muxer is told, so that a segment says where it belongs IN ITSELF.
 *
 * > [!CAUTION] WITHOUT THESE, EVERY SEGMENT CLAIMS TO START AT ZERO and hides its real
 * > position in an edit list -- which drifts 0.083 s further per fragment in the browser
 * > ffmpeg's default fMP4 output writes `tfdt.baseMediaDecodeTime = 0` in every fragment and
 * > puts the segment's absolute position in the initialisation segment's `elst` instead: an
 * > empty edit whose duration is the start, plus a second entry trimming the B-frame reorder
 * > delay (`duration=0, media_time=1328` at a 16000 media timescale -- 0.083 s, two frames at
 * > 24000/1001). Measured here 2026-09-08 on a synthetic h264 source and on the library.
 * >
 * > **hls.js does not implement edit lists at all** -- its source contains no `elst` or `edts`
 * > -- so it reads a fragment that says it starts at zero, re-derives its own time base from
 * > the playlist on EVERY fragment, and lands each one at `playlist start + 0.083 s`. Its
 * > drift correction then carries that forward, so fragment N is placed 0.083*N late: measured
 * > +0.166, +0.248, +0.331 on three consecutive fragments. The buffered ranges end up ~0.134 s
 * > apart, over hls.js's 0.1 s `maxBufferHole`, and the player stalls and jumps once per
 * > segment -- every six seconds, on the ~97% of this library that is copied.
 * >
 * > So the placement is moved out of the edit list and into the media, where every consumer
 * > reads it. Each option earns its place and all three were measured separately:
 * >
 * > | option | without it |
 * > |---|---|
 * > | `movflags=+frag_discont` | `tfdt` stays 0 -- the fragment does not say where it is |
 * > | `movflags=+negative_cts_offsets` | `tfdt` stays 0 and the reorder delay biases every PTS |
 * > | `use_editlist=0` | a residual `elst` survives to be applied a second time |
 * >
 * > With them, the same segment carries `tfdt = 192192` at a 16000 timescale -- 12.012 s, its
 * > own boundary to the millisecond -- and a first sample with `cts = 0`. The init drops from
 * > 817 bytes to 765 and no longer carries an `edts` at all.
 *
 * > [!IMPORTANT] `-hls_segment_options` IS the pass-through, and it was believed not to exist
 * > `-movflags -use_editlist` and `-muxdelay 0` were both measured as silently ignored, which
 * > is true: `-f hls` builds the nested mp4 muxer itself and no OUTPUT-level flag reaches it.
 * > `-hls_segment_options` is the dictionary hlsenc hands to that muxer verbatim, and it is
 * > what makes this a flag change rather than the fMP4-by-hand rewrite it looked like.
 * >
 * > It was added to hlsenc in November 2021, so an ffmpeg older than that rejects it outright
 * > rather than ignoring it -- a hard failure at spawn, not a silent regression. Verified here
 * > against ffmpeg 9.0.1.
 */
const SEGMENT_MUXER_OPTIONS = "movflags=+frag_discont+negative_cts_offsets:use_editlist=0";

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
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    ...hardwareArgs(plan, opts),
    ...readArgs(plan, opts),
    ...streamArgs(plan, opts),
    ...outputArgs(opts),
  ];
}

/**
 * Hardware acceleration, wired up ONLY when there is an encode to accelerate.
 *
 * Decoding into a hardware surface and then COPYING the stream is pure overhead, and for
 * VAAPI it breaks the copy path outright -- the frames end up somewhere `-c:v copy` cannot
 * reach. So a remux stays entirely software whatever the machine can do, which costs
 * nothing: a remux never touches a pixel. An AUDIO run never touches a pixel either, so it
 * has nothing to accelerate whatever the video half of the plan says.
 */
function hardwareArgs(plan: PlaybackPlan, opts: FfmpegOpts): string[] {
  const enc = videoEncoder(plan, opts);
  if (!enc.hardware || !enc.hwaccel) return [];
  // Only VAAPI keeps its frames on the GPU and needs its device named. VideoToolbox and
  // NVENC take the accelerator alone, and handing them an output format they do not expect
  // is a spawn error rather than an ignored flag.
  const device = enc.vaapiDevice ? ["-hwaccel_output_format", "vaapi", "-vaapi_device", enc.vaapiDevice] : [];
  return ["-hwaccel", enc.hwaccel, ...device];
}

/** Which encoder this run will actually use, or `SOFTWARE` when it encodes no video at all. */
function videoEncoder(plan: PlaybackPlan, opts: FfmpegOpts): EncoderChoice {
  const encodes = opts.track.kind === "video" && plan.video?.action === "transcode";
  return encodes ? (opts.encoder ?? SOFTWARE) : SOFTWARE;
}

/**
 * Where the read starts and where it stops.
 *
 * The four regimes and what separates them:
 *
 * - **A video COPY** is nudged past its boundary and reads past the end, because the MUXER
 *   does the cutting for it -- see `SEEK_NUDGE_SEC` and `SEGMENT_TAIL_SLACK_SEC`.
 * - **A video RE-ENCODE** decodes from the previous keyframe and discards, so it starts
 *   exactly where it is asked to and ends exactly where it is told. Either the nudge or the
 *   slack would make it wrong -- skipping 200 ms of film, or encoding two seconds nobody
 *   asked for.
 * - **AUDIO, either way**, asks for the boundary plainly and stops at the next one, because
 *   `-to` is the only thing bounding an audio segment -- see `AUDIO_NEVER_CUT_SEC`.
 * - **SUBTITLES** start EARLY, so a cue that spans the boundary is in both segments and a
 *   seek into the middle of one still finds it -- see `SUBTITLE_LEAD_SEC`.
 *
 * > [!CAUTION] SEGMENT ZERO SEEKS TOO, and the seek is what keeps its timestamps expressible
 * > A source's own timeline starts BEFORE zero: an AAC track opens with a priming packet at
 * > -0.021 s, which is decoder warm-up rather than film. Since the placement moved into
 * > `tfdt` -- see `SEGMENT_MUXER_OPTIONS` -- that matters, because `baseMediaDecodeTime` is
 * > UNSIGNED. Measured 2026-09-08 with no `-ss` at all: the first audio segment came out with
 * > a `tfdt` of 2^64 - 1008, a segment claiming to begin 584 billion seconds into the film.
 * > hls.js re-bases its way out of that and Safari's native player would not.
 * >
 * > An input seek discards everything before its target, so seeking to the boundary -- even
 * > when the boundary is 0 -- leaves nothing negative to express. Measured: `tfdt` 0, one
 * > priming packet dropped, every later segment unchanged to the byte.
 * >
 * > `-avoid_negative_ts make_non_negative` also removes the wrap and is the WRONG fix: it
 * > shifts a whole run to keep its timestamps positive, and on the first VIDEO segment that
 * > shift is the 0.083 s reorder delay -- so segment zero's picture would run 0.083 s behind
 * > its own sound and snap back at the next boundary. Measured, and rejected for that.
 */
function readArgs(plan: PlaybackPlan, opts: FfmpegOpts): string[] {
  const copyingVideo = opts.track.kind === "video" && plan.video?.action === "copy";
  const readUntil = opts.segment.endSec + (copyingVideo ? SEGMENT_TAIL_SLACK_SEC : 0);
  return [
    ...seekArgs(copyingVideo, opts),
    "-i",
    opts.input,
    "-copyts",
    "-avoid_negative_ts",
    "disabled",
    "-to",
    readUntil.toFixed(6),
  ];
}

function seekArgs(copyingVideo: boolean, opts: FfmpegOpts): string[] {
  const { startSec } = opts.segment;
  if (copyingVideo) {
    // See SEEK_NUDGE_SEC. `-noaccurate_seek` is the other half: without it ffmpeg discards
    // everything between the nudged target and the boundary, which would drop the first 200 ms
    // of the segment.
    return ["-noaccurate_seek", "-ss", (startSec + SEEK_NUDGE_SEC).toFixed(6)];
  }
  // Never below zero: a negative `-ss` is not a seek to the start, it is an argument ffmpeg
  // reads as a time before the file begins.
  if (opts.track.kind === "subtitles") {
    return ["-ss", Math.max(0, startSec - SUBTITLE_LEAD_SEC).toFixed(6)];
  }
  return ["-ss", startSec.toFixed(6)];
}

/**
 * Which source stream this run carries, and what it does to it.
 *
 * The other tracks are refused EXPLICITLY with `-vn` and `-an` rather than merely left
 * unmapped: a rendition that quietly picked up a second stream would be a muxed segment
 * again, which is the whole thing this split exists to prevent.
 */
function streamArgs(plan: PlaybackPlan, opts: FfmpegOpts): string[] {
  const rendition = renditionFor(plan, opts.track);
  const map = rendition ? ["-map", `0:${rendition.sourceIndex}`] : [];
  return [...map, ...codecArgs(plan, opts)];
}

/**
 * The rendition this run is making, or null when the plan does not have one.
 *
 * Null is unreachable through the session, which only ever asks for a rendition it published;
 * it is here because `Track.ordinal` is a number off the wire by the time it reaches this
 * module, and a lookup that cannot answer "no such rendition" would index past the end.
 */
function renditionFor(plan: PlaybackPlan, track: Track): Rendition | null {
  switch (track.kind) {
    case "video":
      return track.ordinal === 0 ? plan.video : null;
    case "audio":
      return plan.audio[track.ordinal] ?? null;
    case "subtitles":
      return plan.subtitles[track.ordinal] ?? null;
  }
}

function codecArgs(plan: PlaybackPlan, opts: FfmpegOpts): string[] {
  switch (opts.track.kind) {
    case "video":
      return videoCodecArgs(plan, opts);
    case "audio":
      return audioCodecArgs(plan.audio[opts.track.ordinal]);
    case "subtitles":
      return subtitleCodecArgs();
  }
}

/**
 * A re-encode needs no `-force_key_frames`: a fresh encoder emits an IDR on its first frame,
 * and every segment is a fresh encoder. The segment is independently decodable by
 * construction, which is the property `EXT-X-INDEPENDENT-SEGMENTS` promises.
 */
function videoCodecArgs(plan: PlaybackPlan, opts: FfmpegOpts): string[] {
  if (plan.video?.action !== "transcode") return ["-an", "-c:v", "copy"];
  const enc = videoEncoder(plan, opts);
  // Hardware encoders take a BITRATE rather than a quality target: none of the three
  // implements `-crf`, and passing it is a spawn error rather than an ignored flag.
  const codec = enc.hardware
    ? ["-c:v", enc.encoder, "-b:v", HARDWARE_BITRATE]
    : ["-c:v", "libx264", "-preset", SOFTWARE_PRESET, "-crf", SOFTWARE_CRF];
  // VAAPI does its format conversion inside the filter, on the GPU. Everything else takes
  // `-pix_fmt`, which VAAPI cannot: its frames are surfaces rather than planes.
  const pixelFormat = enc.vaapiDevice ? [] : ["-pix_fmt", SOFTWARE_PIXEL_FORMAT];
  return ["-an", ...videoFilter(plan, enc), ...codec, ...pixelFormat];
}

/**
 * The `-vf` chain for a re-encode: the resize, the pixel format, or neither.
 *
 * Two spellings of one job, and they are NOT interchangeable. After `-hwaccel vaapi
 * -hwaccel_output_format vaapi` the frames never leave the GPU, so the ordinary `scale`
 * filter cannot see them and `scale_vaapi` is the only one that can -- which is also where
 * VAAPI's mandatory nv12 conversion goes, since `-pix_fmt` has no surface to apply to.
 * VideoToolbox and NVENC hand frames back to system memory, so they take the plain one.
 */
function videoFilter(plan: PlaybackPlan, enc: EncoderChoice): string[] {
  const scaleWidth = plan.video?.scaleWidth ?? null;
  if (enc.vaapiDevice) {
    // `h=-2` lets ffmpeg keep the aspect ratio and round to an even height for us.
    const size = scaleWidth ? `w=${scaleWidth}:h=-2:` : "";
    return ["-vf", `scale_vaapi=${size}format=${VAAPI_PIXEL_FORMAT}`];
  }
  return scaleWidth ? ["-vf", `scale=${scaleWidth}:-2`] : [];
}

/**
 * One audio rendition, copied or re-encoded on its OWN codec's answer.
 *
 * A rendition the plan does not have re-encodes, which is unreachable -- `streamArgs` maps no
 * stream for it, so the run produces nothing whatever this returns -- and is the right way for
 * an unreachable branch to fall: re-encoding is the answer that works everywhere.
 */
function audioCodecArgs(rendition: AudioRendition | undefined): string[] {
  if (rendition?.action === "copy") return ["-vn", "-c:a", "copy"];
  return ["-vn", "-c:a", "aac", "-ac", "2", "-b:a", "192k"];
}

/**
 * A text subtitle stream, converted to WebVTT.
 *
 * There is no copy path and there does not need to be: `webvtt` in and `webvtt` out is
 * already a passthrough as far as cost goes, and every other text format has to be converted
 * anyway. The conversion reads text, so it is free next to the demux that finds it.
 */
function subtitleCodecArgs(): string[] {
  return ["-vn", "-an", "-c:s", "webvtt"];
}

/**
 * Where this run's segment goes, and in what shape.
 *
 * Two shapes, because two of the renditions are fMP4 and one is text. The HLS muxer is what
 * makes an fMP4 segment cut correctly and carry its own position; WebVTT has neither problem,
 * so a subtitle run writes its one file directly and skips the muxer entirely.
 */
function outputArgs(opts: FfmpegOpts): string[] {
  if (opts.track.kind === "subtitles") {
    // Straight to the published name. Nothing has to be cut, so there is no segmenting muxer
    // to name the file for us -- and the run's `-ss`/`-to` already bound it to this segment.
    return ["-f", "webvtt", `${opts.outDir}/${segmentFileName(opts.track, opts.segment.index)}`];
  }
  return hlsMuxerArgs(opts);
}

/** The HLS muxer block: one segment, its init, and the throwaway playlist ffmpeg insists on. */
function hlsMuxerArgs(opts: FfmpegOpts): string[] {
  return [
    "-f",
    "hls",
    // VIDEO: the segment's own length, so the muxer's cutting rule -- the first keyframe at or
    // past this -- lands on the NEXT boundary, which is a keyframe by construction.
    // AUDIO: unreachable on purpose, so `-to` alone ends the segment. See AUDIO_NEVER_CUT_SEC.
    "-hls_time",
    opts.track.kind === "video"
      ? (opts.segment.endSec - opts.segment.startSec).toFixed(6)
      : AUDIO_NEVER_CUT_SEC.toFixed(6),
    "-hls_playlist_type",
    "vod",
    "-hls_segment_type",
    "fmp4",
    // Handed straight to the nested fMP4 muxer, which no output-level flag can reach. This is
    // what makes a segment carry its own absolute position -- see SEGMENT_MUXER_OPTIONS.
    "-hls_segment_options",
    SEGMENT_MUXER_OPTIONS,
    "-hls_flags",
    "independent_segments",
    // `-start_number` names the file after its place in the WHOLE film rather than after
    // this run's position in it, so a run started at segment 400 writes vseg00400.m4s and the
    // playlist the client already holds points straight at it.
    "-start_number",
    String(opts.segment.index),
    // `hls_fmp4_init_filename` is resolved against the PLAYLIST's directory, not the working
    // directory, so both must name the same place or ffmpeg fails at header-write time with
    // "Failed to open segment".
    "-hls_fmp4_init_filename",
    RUN_INIT_NAME,
    "-hls_segment_filename",
    `${opts.outDir}/${segmentFilePattern(opts.track)}`,
    // ffmpeg insists on a playlist output. Nothing reads this one -- the client is served
    // `hls-timeline.ts`'s complete VOD playlist, which knows about every segment rather than
    // only the one this run made.
    `${opts.outDir}/produced.m3u8`,
  ];
}
