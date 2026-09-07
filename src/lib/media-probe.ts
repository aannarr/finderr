/**
 * Asking ffprobe what is actually inside ONE file, at the moment somebody clicks play.
 *
 * ## Why this exists at all, when the arrs already told us the codecs
 *
 * `media_file` carries Radarr's and Sonarr's own MediaInfo scan, and that is enough to
 * reason about the library in BULK -- how many titles would need a transcode, what the
 * shape of the collection is. It is not enough to plan one playback, for two reasons that
 * are both measured rather than assumed:
 *
 * - **`subtitles` in the arr payload is a LANGUAGE list and never a format.** `"eng"` does
 *   not say whether the track is SRT (converts to WebVTT for nothing) or PGS (a bitmap,
 *   which forces a full video re-encode). That single distinction is the difference between
 *   free and most of a Celeron, so it cannot be guessed.
 * - **`videoCodec` is the arr's RELEASE vocabulary**, not ffmpeg's: it says `x265` where
 *   ffprobe says `hevc`. Mapping between them is one more table that can drift out of step
 *   with a decision that has to be exactly right.
 *
 * So one probe, on one file, at click time. It reads the container header rather than the
 * file, so it is milliseconds -- and it is emphatically NOT a sweep: nothing here ever walks
 * the library, and the render path never calls it.
 *
 * > [!CAUTION] The path handed in must ALREADY have been through `media-path.ts`
 * > This module spawns a process with the path as an argument. It does not re-derive whether
 * > the path is allowed, because a second copy of that rule is a second thing that can be
 * > wrong -- `resolveMediaFile` is the single owner and its output is the only thing that may
 * > arrive here. The assertion is cheap and it is enforced by the call site, not by a
 * > comment: nothing in this file constructs a path.
 */

import type { ProbedMedia, ProbedStream } from "./playback-plan";

/** How long one probe may take before it is abandoned. */
export const PROBE_TIMEOUT_MS = 10_000;

/** Injected so tests need neither ffprobe nor a media file. */
export type ProbeRunner = (
  argv: string[],
  timeoutMs: number,
) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

export class ProbeError extends Error {}

/**
 * The ffprobe invocation, as an argv.
 *
 * Exported so a test can assert the flags without spawning anything. `-show_streams` plus
 * `-show_format` is one process for both halves; asking twice would double the cost of the
 * one thing that happens while a human waits.
 */
export function ffprobeArgs(path: string): string[] {
  return [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    "-show_format",
    // Read only what the header needs. Without this ffprobe will happily read megabytes off
    // a spinning array to refine a frame-rate estimate nothing here looks at.
    "-analyzeduration",
    "2000000",
    "-probesize",
    "5000000",
    path,
  ];
}

/** The raw shape ffprobe emits, before it is narrowed. Every field is optional in practice. */
interface RawProbe {
  streams?: {
    index?: number;
    codec_type?: string;
    codec_name?: string;
    channels?: number;
    width?: number;
    height?: number;
    tags?: { language?: string };
    disposition?: { default?: number };
  }[];
  format?: { duration?: string; format_name?: string };
}

/**
 * Parse ffprobe's JSON into the narrow shape a plan reads.
 *
 * PURE and exported, so the parsing can be tested against real recorded output without a
 * subprocess -- which is where the surprises actually are. A stream with no `index` or no
 * `codec_type` is DROPPED rather than defaulted: `-map 0:undefined` is an ffmpeg error at
 * spawn time, and a stream we cannot address is one we cannot use.
 */
export function parseProbe(json: string): ProbedMedia {
  let raw: RawProbe;
  try {
    raw = JSON.parse(json) as RawProbe;
  } catch {
    throw new ProbeError("ffprobe returned output that is not JSON");
  }

  const streams: ProbedStream[] = [];
  for (const s of raw.streams ?? []) {
    if (typeof s.index !== "number" || typeof s.codec_type !== "string") continue;
    streams.push({
      index: s.index,
      codec_type: s.codec_type,
      codec_name: s.codec_name,
      channels: s.channels,
      width: s.width,
      height: s.height,
      language: s.tags?.language,
      isDefault: s.disposition?.default === 1,
    });
  }

  const durationRaw = Number(raw.format?.duration);
  return {
    streams,
    durationSec: Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : null,
    formatName: raw.format?.format_name ?? null,
  };
}

/**
 * Probe one file.
 *
 * Throws `ProbeError` on anything that is not a clean parse -- a missing binary, a timeout,
 * a non-zero exit, unparseable output. There is deliberately no "partial" result: a plan
 * built on half a probe would make exactly the wrong decision about the half it did not see,
 * and the honest answer to a failed probe is that this file cannot be played right now.
 */
export async function probeMedia(
  path: string,
  run: ProbeRunner = spawnFfprobe,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ProbedMedia> {
  const res = await run(ffprobeArgs(path), timeoutMs);
  if (!res.ok) {
    // The stderr may name the path, which can carry a title somebody would rather not have
    // in a shared log; the CALLER logs, and it logs a code. This message says what happened
    // and never what it was looking at.
    throw new ProbeError("ffprobe could not read this file");
  }
  const probe = parseProbe(res.stdout);
  if (probe.streams.length === 0) throw new ProbeError("ffprobe found no streams");
  return probe;
}

const spawnFfprobe: ProbeRunner = async (argv, timeoutMs) => {
  const proc = Bun.spawn(["ffprobe", ...argv], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { ok: code === 0, stdout, stderr };
  } catch (err) {
    return { ok: false, stdout: "", stderr: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
};
