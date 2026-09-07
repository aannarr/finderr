/**
 * What finderr mirrors about a PLAYABLE FILE, and the one projection that produces it.
 *
 * Radarr and Sonarr both already know every fact a transcode decision needs -- the absolute
 * path, the container, the video codec, the audio codec, the resolution -- because both run
 * MediaInfo at import. This module turns their two record shapes into one row so the
 * playback path never asks which arr a title came from.
 *
 * > [!IMPORTANT] IT COSTS NOTHING UPSTREAM, AND THAT IS WHY IT LIVES ON THE EXISTING WALKS
 * > Radarr embeds `movieFile` in `/movie`, which the library mirror already streams. Sonarr
 * > serves `episodeFile` inside `/episode?seriesId=` the moment `includeEpisodeFile=true` is
 * > passed, which the episode mirror already calls per series. Measured against both live
 * > servers 2026-09-08. So the whole of this arrives on walks that were happening anyway --
 * > no new endpoint, no new timer, and nothing added to any render path.
 *
 * ## The sentinel, and why a film has a season number
 *
 * A film has exactly one file; an episode has exactly one file; a series has none of its
 * own. That is genuinely ONE relation -- "the file behind this playable thing" -- so it is
 * one table, unlike `library` and `episode`, which answer different questions and are
 * deliberately separate (see `store.ts`).
 *
 * The key therefore has to address both, and `NOT_AN_EPISODE` is the storage device that
 * lets it: a film is `(tconst, -1, -1)`. This follows `UNKNOWN_LANG`'s precedent exactly --
 * a reserved in-band value beats a nullable key column, because SQLite treats two NULLs as
 * distinct and a primary key over them stops being a primary key. -1 is safe where 0 is
 * not: **season 0 is the specials and is a real season on every series.**
 */

import type { ArrFile, ArrMediaInfo } from "./arr";

/**
 * The season and episode of something that is not an episode.
 *
 * Never write `-1` directly; the constant is what makes a reader stop and find this comment.
 */
export const NOT_AN_EPISODE = -1;

/** One playable file, flattened from whichever arr described it. */
export interface MediaFileRow {
  imdb_id: string;
  /** `NOT_AN_EPISODE` for a film. */
  season: number;
  /** `NOT_AN_EPISODE` for a film. */
  episode: number;
  service: "radarr" | "sonarr";
  arr_file_id: number;
  /** Absolute, as the ARR sees it. Meaningless to this process until `media-path.ts` maps it. */
  path: string;
  size: number | null;
  /** The arr's RELEASE label (`x265`), not ffmpeg's (`hevc`). See `ArrMediaInfo`. */
  video_codec: string | null;
  video_depth: number | null;
  /** `HDR`, `SDR`, `Dolby Vision`... free text from the arr, displayed and never matched on. */
  video_range: string | null;
  audio_codec: string | null;
  audio_channels: number | null;
  /** Comma-joined ISO-639-2, e.g. `eng` or `eng,swe`. */
  audio_langs: string | null;
  /** LANGUAGES, never formats -- see the warning on `ArrMediaInfo`. */
  subtitle_langs: string | null;
  /** `1920x1080`, as the arr wrote it. Parsed nowhere; a probe answers for real. */
  resolution: string | null;
  /** `1:32:49`. The arr's own formatting, kept verbatim rather than parsed into seconds. */
  runtime: string | null;
}

/** Trim to `null`, so an empty upstream string never becomes a value a reader must special-case. */
function text(v: string | undefined): string | null {
  const s = v?.trim();
  return s ? s : null;
}

function num(v: number | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Flatten one arr file record into a row, or `null` when there is nothing playable.
 *
 * **A file with no `path` yields `null`, and that is the only hard requirement.** Everything
 * else is optional: an arr that imported a file before it could scan it serves the path with
 * no `mediaInfo` at all, and losing the path over a missing codec would make the file
 * unplayable to protect a field nothing needs yet. The probe at click time is the authority
 * regardless, so an unscanned file plays exactly as well as a scanned one -- it just cannot
 * be reasoned about in bulk beforehand.
 */
export function mediaFileRow(
  imdbId: string,
  service: "radarr" | "sonarr",
  file: ArrFile | undefined | null,
  at: { season: number; episode: number } = { season: NOT_AN_EPISODE, episode: NOT_AN_EPISODE },
): MediaFileRow | null {
  if (!imdbId || !file || typeof file.id !== "number") return null;
  const path = text(file.path);
  if (!path) return null;
  const mi: ArrMediaInfo = file.mediaInfo ?? {};
  return {
    imdb_id: imdbId,
    season: at.season,
    episode: at.episode,
    service,
    arr_file_id: file.id,
    path,
    size: num(file.size),
    video_codec: text(mi.videoCodec),
    video_depth: num(mi.videoBitDepth),
    video_range: text(mi.videoDynamicRange),
    audio_codec: text(mi.audioCodec),
    audio_channels: num(mi.audioChannels),
    audio_langs: text(mi.audioLanguages),
    subtitle_langs: text(mi.subtitles),
    resolution: text(mi.resolution),
    runtime: text(mi.runTime),
  };
}
