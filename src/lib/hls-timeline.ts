/**
 * The whole timeline of a title, stated up front, so a player will let you scrub anywhere.
 *
 * Entirely pure: numbers in, numbers and one string out. No ffmpeg, no filesystem, no clock.
 *
 * ## Why the playlist has to be complete before a single frame exists
 *
 * **A player cannot seek to a segment that is not in the playlist.** A growing
 * `EXT-X-PLAYLIST-TYPE:EVENT` list therefore offers a timeline exactly as long as what has
 * already been encoded, which -- with the read paced to roughly realtime -- is a few seconds
 * past the playhead. Dragging the scrubber to 01:20:00 of a two-hour film has nothing to
 * land on.
 *
 * So the server states the entire timeline immediately: every segment, with its duration,
 * ending in `EXT-X-ENDLIST`. The player believes the film exists, lets you touch any part of
 * it, and asks for the one segment it needs. `transcode-session.ts` makes that segment when
 * it is asked for.
 *
 * > [!IMPORTANT] A SEGMENT BOUNDARY MUST BE A PLACE THE SOURCE CAN ACTUALLY BE CUT
 * > Copying a video stream means the cut can only fall on a keyframe -- ffmpeg cannot invent
 * > one without re-encoding. Measured 2026-09-08, both asked for 4-second segments: a 1080p
 * > h264 file segmented at exactly 4.004 s, and a 2160p HEVC file with a ten-second GOP
 * > produced 11.011 s then 10.010 s. **A uniform grid would therefore be a LIE for the second
 * > file** -- and a playlist that lies about where a segment starts sends the player to the
 * > wrong place, then runs out of segment numbers before it runs out of film.
 * >
 * > Hence `timelineFrom`, which never invents a boundary: it is handed the places this file
 * > can be cut and picks a subset of them. `keyframes.ts` finds those places, and when it
 * > cannot the caller passes a uniform grid, which is exactly right for a re-encode because
 * > a re-encode makes its own keyframes.
 */

/**
 * Where every segment of one title starts, and where the last one ends.
 *
 * `starts` is ascending and always begins at 0. Durations are DERIVED from consecutive
 * entries rather than stored, because storing both is two facts that can disagree.
 */
export interface Timeline {
  starts: readonly number[];
  /** Where the final segment ends: the title's runtime, in seconds. */
  endSec: number;
}

/**
 * The shortest segment worth emitting, in seconds.
 *
 * A cut point a hair before the end of the file would otherwise produce a final segment of a
 * few frames -- which costs a whole ffmpeg run and a round trip to deliver nothing a viewer
 * can perceive. The tail is folded into its predecessor instead.
 */
const MIN_SEGMENT_SEC = 1;

/**
 * How long a segment should be, before the source gets a say.
 *
 * Six seconds is the HLS authoring recommendation and it is a genuine trade rather than a
 * ritual: a player buffers whole segments, so a longer one delays the first frame and a
 * shorter one multiplies the ffmpeg runs and the round trips. In copy mode this is a FLOOR,
 * not a target -- a source whose keyframes are ten seconds apart gets ten-second segments,
 * because those are the only places it can be cut.
 */
export const SEGMENT_TARGET_SEC = 6;

/** How many segments this timeline has. */
export function segmentCount(t: Timeline): number {
  return t.starts.length;
}

/** The half-open range segment `index` covers, or null when there is no such segment. */
export function segmentRange(t: Timeline, index: number): { startSec: number; endSec: number } | null {
  const start = t.starts[index];
  if (start === undefined) return null;
  return { startSec: start, endSec: t.starts[index + 1] ?? t.endSec };
}

/**
 * Build a timeline by taking a subset of the places this file can be cut.
 *
 * The rule is greedy and one sentence long: **walk the cut points and take the first one
 * that is at least `segmentSec` past the previous boundary.** That yields segments of AT
 * LEAST the target length, never shorter, and every boundary is a real cut point rather than
 * a wish -- which is the property the whole design rests on.
 *
 * Cut points at or past the end are dropped, so is any leading garbage before 0, and a tail
 * shorter than `MIN_SEGMENT_SEC` is folded back into the segment before it.
 */
export function timelineFrom(
  durationSec: number,
  segmentSec: number,
  cutPoints: readonly number[],
): Timeline {
  const endSec = Math.max(durationSec, 0);
  const starts: number[] = [0];
  if (endSec > 0 && segmentSec > 0) {
    for (const cut of [...cutPoints].sort((a, b) => a - b)) {
      const last = starts[starts.length - 1] as number;
      if (cut - last < segmentSec) continue;
      if (endSec - cut < MIN_SEGMENT_SEC) break;
      starts.push(cut);
    }
  }
  return { starts, endSec };
}

/**
 * The timeline a re-encode gets: an exact grid, because a re-encode makes its own keyframes.
 *
 * Expressed through `timelineFrom` rather than beside it so there is ONE definition of how a
 * timeline is formed. The multiples handed in are the cut points, and a re-encoded segment
 * genuinely can start at any of them.
 */
export function uniformTimeline(durationSec: number, segmentSec: number): Timeline {
  const cuts: number[] = [];
  if (segmentSec > 0) {
    for (let t = segmentSec; t < durationSec; t += segmentSec) cuts.push(t);
  }
  return timelineFrom(durationSec, segmentSec, cuts);
}

/** How a segment file is named, given its index. The one owner of that spelling. */
export function segmentFileName(index: number): string {
  return `seg${String(index).padStart(5, "0")}.m4s`;
}

/**
 * The same spelling as `segmentFileName`, in ffmpeg's template language.
 *
 * Two languages for one naming rule is the classic pair that drifts, so they live together
 * and a test asserts they still agree. `%05d` is what makes `padStart(5, "0")` correct.
 */
export const SEGMENT_FILE_PATTERN = "seg%05d.m4s";

/**
 * What one ffmpeg run calls the initialisation segment it writes.
 *
 * A fixed name inside that run's own private working directory, so it never collides; the
 * session renames it to `initFileName(index)` on the way out.
 */
export const RUN_INIT_NAME = "init.mp4";

/** How a published initialisation segment is named. The one owner of that spelling. */
export function initFileName(index: number): string {
  return `init${String(index).padStart(5, "0")}.mp4`;
}

/**
 * The complete VOD playlist, as text.
 *
 * `EXT-X-ENDLIST` is what makes it VOD rather than live: the player stops polling, trusts the
 * total duration, and enables the full scrub bar. Version 7 is the floor for fMP4
 * (`EXT-X-MAP` with a media initialisation section).
 *
 * > [!CAUTION] EVERY SEGMENT NAMES ITS OWN `EXT-X-MAP`, and sharing one is a MEASURED BUG
 * > The tidy version emits a single `EXT-X-MAP` for the film, on the reasoning that the codec
 * > configuration cannot change halfway through -- and two inits produced at different seek
 * > offsets really do differ in only six bytes. **Those six bytes are the EDIT LIST**, and it
 * > encodes where its own run started. Measured 2026-09-08: playing segment 401 against the
 * > init produced for segment 400 shifted its whole presentation by 6.882 s, which is exactly
 * > the distance between the two boundaries. It would have shifted further the further apart
 * > they were, so the failure grows with the seek that caused it.
 * >
 * > `-use_editlist 0` does make the inits byte-identical, and it buys that by REBASING each
 * > segment's decode times to zero -- which throws away the one thing that places an
 * > independently produced segment on a timeline. So the offset lives either in the init or
 * > in the media, never in neither, and the honest answer is to keep the init that belongs to
 * > the segment. That is correct under a player which applies edit lists and under one which
 * > ignores them, which is the reason to prefer it over betting on which this browser is.
 * >
 * > The cost is one four-kilobyte request per segment, for a file every run already wrote.
 */
export function vodPlaylist(t: Timeline): string {
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(longestSegmentSec(t)))}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-INDEPENDENT-SEGMENTS",
  ];
  for (let i = 0; i < t.starts.length; i++) {
    const range = segmentRange(t, i);
    if (!range) continue;
    // RELATIVE names, which is what lets a client retarget the media at a different endpoint
    // from the playlist. An absolute base here would weld every segment to one address and
    // make multi-homed playback impossible without rewriting the playlist.
    lines.push(`#EXT-X-MAP:URI="${initFileName(i)}"`);
    lines.push(`#EXTINF:${(range.endSec - range.startSec).toFixed(6)},`);
    lines.push(segmentFileName(i));
  }
  lines.push("#EXT-X-ENDLIST");
  return `${lines.join("\n")}\n`;
}

function longestSegmentSec(t: Timeline): number {
  let longest = 0;
  for (let i = 0; i < t.starts.length; i++) {
    const range = segmentRange(t, i);
    if (range) longest = Math.max(longest, range.endSec - range.startSec);
  }
  return longest;
}
