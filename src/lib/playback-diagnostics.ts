/**
 * Everything the SERVER knows about one playback that a person might want to see, gathered
 * into one block for the player's "stats for nerds" panel.
 *
 * Every field here is already computed on the way to starting a session -- the probe, the
 * mirrored `media_file` row, the encoder chosen at boot, which grid the segments were cut on.
 * None of it is new work: this module only stops those facts being thrown away the moment the
 * plan is built. **It must stay that way.** A diagnostic that costs a probe of its own is
 * measuring a system it has changed, and the panel it feeds polls.
 *
 * The block is FIXED for the life of a session, which is why it rides on the start response
 * rather than on the session poll: the file does not change codec while it plays, and a
 * per-tick payload that repeated it would be the same bytes forty times a minute.
 */

import { type EncoderChoice, type EncoderFacts, encoderFacts } from "./encoder";
import type { CutSource } from "./keyframes";
import type { MediaFileRow } from "./media-file";
import type { PlaybackPlan, ProbedMedia, ProbedStream } from "./playback-plan";

/** What is actually inside the file, before anything was planned about it. */
export interface SourceFacts {
  /** The container, as ffprobe names it -- `matroska,webm`. */
  container: string | null;
  /** `1920x1080`, from the probe where it can, from the arr's scan otherwise. */
  resolution: string | null;
  /** ffmpeg's vocabulary (`hevc`), never the arr's release label (`x265`). */
  videoCodec: string | null;
  audioCodec: string | null;
  audioChannels: number | null;
  /**
   * Bits per sample, and `dynamicRange` beside it -- BOTH from the arr's scan rather than the
   * probe, because `ffprobeArgs` deliberately does not ask for the pixel format. Adding
   * `-show_entries stream=pix_fmt` to the click-time probe would spend the one measurement a
   * human waits on to fill in two fields nothing decides on.
   */
  bitDepth: number | null;
  /** `HDR`, `SDR`, `Dolby Vision` -- free text from the arr, displayed and never matched on. */
  dynamicRange: string | null;
  durationSec: number | null;
  sizeBytes: number | null;
}

/** How the film was cut up, which is the difference between a stutter and a bad guess. */
export interface SegmentingFacts {
  /**
   * `keyframes` when the boundaries follow the source's own keyframes, `uniform` when the
   * probe found none usable and the timeline fell back to a plain grid.
   *
   * The distinction is the whole reason this field exists: a title on the fallback grid
   * decodes badly at every boundary, and until now the only way to know which one you had was
   * to read a log on the box.
   */
  source: CutSource | null;
  /** The grid the timeline aims at, in seconds. */
  targetSec: number;
  /** Segments in the published timeline -- the whole film, not what has been produced. */
  count: number;
}

export interface PlaybackDiagnostics {
  source: SourceFacts;
  segmenting: SegmentingFacts;
  /**
   * Null when no encoder was probed at all -- a checkout with no ffmpeg, where a re-encode
   * would fall to the software floor if it were ever attempted.
   *
   * Reported even when the plan COPIES video, because "which encoder would this box use" is a
   * question about the box rather than about this title, and the plan beside it already says
   * whether anything is being encoded.
   */
  encoder: EncoderFacts | null;
}

/** The probed stream a plan decided to use, or null when it uses none. */
function streamAt(probe: ProbedMedia, index: number | null): ProbedStream | null {
  if (index === null) return null;
  return probe.streams.find((s) => s.index === index) ?? null;
}

/**
 * `1920x1080` from the probed video stream.
 *
 * Null rather than a half-answer when the container states only one dimension: `1920x?` reads
 * as a fact and is not one, and the arr's own string is the better fallback.
 */
function resolutionOf(stream: ProbedStream | null): string | null {
  if (!stream?.width || !stream.height) return null;
  return `${stream.width}x${stream.height}`;
}

/**
 * Gather what the server knows about this playback.
 *
 * PURE, so the whole block is testable without ffprobe, a media file or a session -- which is
 * the point: the shapes a panel has to render are exactly the awkward ones (an unscanned arr
 * row, a container that states no duration, a plan that copies both streams).
 */
export function playbackDiagnostics(input: {
  row: MediaFileRow;
  probe: ProbedMedia;
  plan: PlaybackPlan;
  segmenting: SegmentingFacts;
  encoder?: EncoderChoice;
}): PlaybackDiagnostics {
  const video = streamAt(input.probe, input.plan.video.sourceIndex);
  const audio = streamAt(input.probe, input.plan.audio.sourceIndex);
  return {
    source: {
      container: input.probe.formatName,
      resolution: resolutionOf(video) ?? input.row.resolution,
      videoCodec: video?.codec_name ?? null,
      audioCodec: audio?.codec_name ?? null,
      audioChannels: audio?.channels ?? null,
      bitDepth: input.row.video_depth,
      dynamicRange: input.row.video_range,
      durationSec: input.probe.durationSec,
      sizeBytes: input.row.size,
    },
    segmenting: input.segmenting,
    encoder: input.encoder ? encoderFacts(input.encoder) : null,
  };
}
