/**
 * The whole timeline of a title, stated up front, so a player will let you scrub anywhere.
 *
 * Entirely pure: numbers in, numbers and strings out. No ffmpeg, no filesystem, no clock.
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
 *
 * ## THE TWO TRACKS ARE SEGMENTED SEPARATELY, and that is what closes the audio hole
 *
 * A muxed segment can honour exactly ONE cutting rule, and video's rule -- cut on a keyframe
 * -- is the strictest. ffmpeg obeys it and writes the audio packets that arrive after that
 * keyframe into the NEXT segment of the run, which is discarded because the next segment
 * comes from a different run seeking past them. Measured 2026-09-08: **~60 ms of sound missing
 * at every boundary**, showing up in the browser as a ~0.16 s hole in `media.buffered`, a
 * `bufferStalledError` and a freeze every six seconds.
 *
 * So video and audio are published as SEPARATE RENDITIONS, which is what production packagers
 * do. The video rendition keeps the keyframe grid it has to keep. The audio rendition has no
 * keyframe constraint at all -- every audio packet is a key packet -- so it gets a plain
 * uniform grid and `playback-plan.ts` makes each audio segment cover its whole declared range
 * and a little of the one before it. A gap becomes impossible rather than jumped over.
 *
 * The grids do NOT have to match, and forcing them to would bring the constraint straight
 * back: hls.js aligns renditions by timestamp, not by segment index.
 *
 * ## SUBTITLES ARE THE THIRD RENDITION, and they are segmented for the same reason
 *
 * A text subtitle track becomes a WebVTT rendition cut on the same plain grid as audio. It is
 * segmented rather than extracted whole, and that is measured rather than assumed: a
 * `-c:s webvtt` pass over one 6.65 GB film took **92.3 s**, because subtitle packets are
 * interleaved through every cluster so ffmpeg has to demux the entire container to collect
 * them. The same extraction bounded to one six-second segment took **0.07 s** -- the identical
 * figure a copy-mode video segment costs. Measured 2026-09-08 over the array.
 *
 * A WebVTT rendition has NO initialisation segment, which is the one way it differs in shape
 * from the other two: there is no fMP4 header to carry, so `TRACK_FILES` leaves `init` off it
 * and every reader of that table asks whether there is one rather than assuming.
 */

/**
 * A rendition. Video, audio and subtitles are published separately and cut on different
 * grids, so almost everything named in this module is named per track.
 *
 * The names are the `PlaybackPlan` field names on purpose: `playback-plan.ts` looks a track's
 * source stream up as `plan[track]`, which is one structural correspondence rather than a
 * switch that has to be reopened for every new rendition.
 */
export type Track = "video" | "audio" | "subtitles";

/** Every track, in the order a reader expects them. The one owner of that list. */
export const TRACKS: readonly Track[] = ["video", "audio", "subtitles"];

/**
 * The renditions a player must have before it can show a frame.
 *
 * Subtitles are deliberately absent: a viewer sees the film without them, hls.js does not
 * even fetch a subtitle fragment until the track is switched on, and warming one would spend
 * an ffmpeg run on the start request for something nobody has asked to see.
 */
export const TRACKS_BLOCKING_FIRST_FRAME: readonly Track[] = ["video", "audio"];

/**
 * Where every segment of one rendition starts, and where the last one ends.
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
 * The timelines a session publishes, one per rendition it actually has.
 *
 * A track is absent when the source has no such stream -- a film with no audio track, or the
 * audio-only case. Absent means "not published at all": no playlist, no segments, and no
 * `EXT-X-MEDIA` line naming a rendition that would 404.
 */
export type TrackTimelines = { readonly [K in Track]?: Timeline };

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
 * An exact grid: what a re-encode gets, and what the AUDIO rendition always gets.
 *
 * Expressed through `timelineFrom` rather than beside it so there is ONE definition of how a
 * timeline is formed. The multiples handed in are the cut points, and both callers genuinely
 * can start a segment at any of them -- a re-encode makes its own keyframes, and audio has no
 * keyframes to be constrained by in the first place.
 */
export function uniformTimeline(durationSec: number, segmentSec: number): Timeline {
  const cuts: number[] = [];
  if (segmentSec > 0) {
    for (let t = segmentSec; t < durationSec; t += segmentSec) cuts.push(t);
  }
  return timelineFrom(durationSec, segmentSec, cuts);
}

/**
 * What each rendition's published files are called, and what they are served as.
 *
 * ONE table, because these names are written in four languages -- generated here, matched by
 * the route, handed to ffmpeg as a `%05d` template, and read back off disk by the session --
 * and four independent spellings is the classic pair that drifts into a file published under
 * a name the playlist never mentions.
 *
 * `init` is ABSENT on subtitles rather than empty: a WebVTT rendition has no fMP4
 * initialisation segment to publish, so there is nothing to name and no `EXT-X-MAP` to write.
 */
const TRACK_FILES: Record<Track, TrackFiles> = {
  video: {
    playlist: "video.m3u8",
    segment: { prefix: "vseg", extension: ".m4s" },
    init: { prefix: "vinit", extension: ".mp4" },
    contentType: "video/iso.segment",
  },
  audio: {
    playlist: "audio.m3u8",
    segment: { prefix: "aseg", extension: ".m4s" },
    init: { prefix: "ainit", extension: ".mp4" },
    contentType: "video/iso.segment",
  },
  subtitles: {
    playlist: "subtitles.m3u8",
    segment: { prefix: "sseg", extension: ".vtt" },
    contentType: "text/vtt",
  },
};

/** Everything about one rendition's published files that has to be spelled the same way twice. */
interface TrackFiles {
  playlist: string;
  segment: FileNaming;
  /** Absent when the rendition has no initialisation segment. WebVTT has none. */
  init?: FileNaming;
  /** What a produced media segment of this rendition is served as. */
  contentType: string;
}

/** How one kind of published file is spelled: a fixed prefix, an index, a fixed extension. */
interface FileNaming {
  prefix: string;
  extension: string;
}

/** How many digits a published name carries. `%05d` in ffmpeg's template language. */
const INDEX_DIGITS = 5;

function publishedName(naming: FileNaming, index: number): string {
  return `${naming.prefix}${String(index).padStart(INDEX_DIGITS, "0")}${naming.extension}`;
}

/** How a media segment file is named. The one owner of that spelling. */
export function segmentFileName(track: Track, index: number): string {
  return publishedName(TRACK_FILES[track].segment, index);
}

/**
 * How a published initialisation segment is named, or null for a rendition that has none.
 *
 * Null is a real answer rather than a failure: WebVTT segments carry no fMP4 header, so a
 * subtitle rendition publishes nothing beside its media and every caller decides what that
 * means for it -- no `EXT-X-MAP` in the playlist, nothing to rename, nothing to evict.
 */
export function initFileName(track: Track, index: number): string | null {
  const naming = TRACK_FILES[track].init;
  return naming ? publishedName(naming, index) : null;
}

/** What a produced media segment of this rendition is served as. The one owner of that. */
export function segmentContentType(track: Track): string {
  return TRACK_FILES[track].contentType;
}

/**
 * The same spelling as `segmentFileName`, in ffmpeg's template language.
 *
 * Derived from the same table rather than typed a second time, so the two cannot drift.
 */
export function segmentFilePattern(track: Track): string {
  const { prefix, extension } = TRACK_FILES[track].segment;
  return `${prefix}%0${INDEX_DIGITS}d${extension}`;
}

/** The name of one rendition's media playlist, as the master playlist points at it. */
export function mediaPlaylistName(track: Track): string {
  return TRACK_FILES[track].playlist;
}

/**
 * What one ffmpeg run calls the initialisation segment it writes.
 *
 * A fixed name inside that run's own private working directory, so it never collides; the
 * session renames it to `initFileName(track, index)` on the way out.
 */
export const RUN_INIT_NAME = "init.mp4";

/** One file a session publishes, as named on the wire. */
export interface ProducedName {
  track: Track;
  kind: "segment" | "init";
  index: number;
}

/**
 * Read a published file name back into the thing it names, or null when it is not one of ours.
 *
 * **This is the traversal guard, and it works by ENUMERATING what is allowed rather than by
 * stripping what is forbidden.** The name arrives off the wire and a session directory is a
 * real directory, so the only safe shape is a closed pattern whose capture becomes a NUMBER
 * before anything touches the filesystem -- no `..`, no slash, no dot-file, no extension we
 * did not write. Parsing lives here, beside the spelling it has to agree with, so the route
 * never re-types a pattern that could drift from the names actually produced.
 */
export function parseProducedName(name: string): ProducedName | null {
  for (const track of TRACKS) {
    for (const kind of ["segment", "init"] as const) {
      const naming = TRACK_FILES[track][kind];
      // A rendition with no initialisation segment has no name to match, and matching one
      // would admit a file this server never writes.
      if (!naming) continue;
      const index = indexIn(naming, name);
      if (index !== null) return { track, kind, index };
    }
  }
  return null;
}

/**
 * The index this name carries, or null when it is not this naming at all.
 *
 * The slice is a guess and the round trip is the guard: a name is accepted only when
 * re-generating it from the parsed index reproduces the name EXACTLY, which settles the
 * prefix, the digit count, the padding and the extension in one comparison. So there is no
 * separate pattern to keep in step with `publishedName`, and no way for a name that merely
 * resembles ours to slip through.
 */
function indexIn(naming: FileNaming, name: string): number | null {
  const digits = name.slice(naming.prefix.length, name.length - naming.extension.length);
  if (!/^\d+$/.test(digits)) return null;
  const index = Number(digits);
  return publishedName(naming, index) === name ? index : null;
}

/** The playlist a player is pointed at: the one that names the renditions. */
export const MASTER_PLAYLIST_NAME = "index.m3u8";

/**
 * A nominal bitrate for the single variant, because `BANDWIDTH` is a required attribute.
 *
 * It exists to drive ABR selection between variants and there is exactly one variant, so no
 * decision anywhere reads it. A real figure would mean measuring the file to state a number
 * nothing consults; a wrong-looking constant that is honest about being nominal is better
 * than a guess dressed up as a measurement.
 */
const NOMINAL_BANDWIDTH = 8_000_000;

/**
 * The rendition group names, written once each.
 *
 * A `GROUP-ID` is spelled twice by construction -- on the `EXT-X-MEDIA` line that defines the
 * group and on the `EXT-X-STREAM-INF` that joins it -- and a variant naming a group that does
 * not exist is a manifest a player rejects outright.
 */
const AUDIO_GROUP = "audio";
const SUBTITLE_GROUP = "subs";

/**
 * The master playlist: which renditions exist, and where each one's own playlist is.
 *
 * > [!IMPORTANT] NO `CODECS` ATTRIBUTE, DELIBERATELY
 * > It is optional, and getting it wrong is fatal rather than cosmetic -- a declared codec
 * > string that does not match the media makes the browser refuse the SourceBuffer outright.
 * > hls.js reads the real codec out of each rendition's fMP4 initialisation segment, which is
 * > the only place that cannot be wrong about it.
 */
export function masterPlaylist(timelines: TrackTimelines): string {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS"];
  // Audio is a separate rendition ONLY when there is video to attach it to. A file with no
  // video stream has one thing to play, and it is the variant itself.
  const separateAudio = timelines.video !== undefined && timelines.audio !== undefined;
  if (separateAudio) {
    lines.push(
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="${AUDIO_GROUP}",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="${mediaPlaylistName("audio")}"`,
    );
  }
  // `DEFAULT=NO,AUTOSELECT=NO` is the whole subtitle policy and it is deliberate: the
  // rendition is OFFERED and never switched on for you. hls.js leaves it unselected, so it
  // fetches no subtitle fragment -- and produces no ffmpeg run -- until a viewer picks it out
  // of the player's own caption menu.
  const hasSubtitles = timelines.subtitles !== undefined;
  if (hasSubtitles) {
    lines.push(
      `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="${SUBTITLE_GROUP}",NAME="Subtitles",DEFAULT=NO,AUTOSELECT=NO,URI="${mediaPlaylistName("subtitles")}"`,
    );
  }
  const variant: Track = timelines.video !== undefined ? "video" : "audio";
  const groups = [
    separateAudio ? `,AUDIO="${AUDIO_GROUP}"` : "",
    hasSubtitles ? `,SUBTITLES="${SUBTITLE_GROUP}"` : "",
  ].join("");
  lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${NOMINAL_BANDWIDTH}${groups}`);
  // RELATIVE, like every other name this module writes -- see `mediaPlaylist`.
  lines.push(mediaPlaylistName(variant));
  return `${lines.join("\n")}\n`;
}

/**
 * One rendition's complete VOD playlist, as text.
 *
 * `EXT-X-ENDLIST` is what makes it VOD rather than live: the player stops polling, trusts the
 * total duration, and enables the full scrub bar. Version 7 is the floor for fMP4
 * (`EXT-X-MAP` with a media initialisation section).
 *
 * > [!NOTE] EVERY SEGMENT STILL NAMES ITS OWN `EXT-X-MAP`, and it no longer HAS to
 * > It had to until 2026-09-08. Two inits produced at different seek offsets differed in six
 * > bytes, those six bytes were the EDIT LIST, and it encoded where that run had started --
 * > so playing segment 401 against segment 400's init shifted its whole presentation by
 * > 6.882 s, the distance between the two boundaries.
 * >
 * > `SEGMENT_MUXER_OPTIONS` in `playback-plan.ts` moved that placement out of the init and
 * > into each fragment's own `tfdt`, where every consumer reads it -- hls.js implements no
 * > edit lists at all -- and the inits a rendition produces are now BYTE-IDENTICAL whatever
 * > the seek offset. Serving one per segment is therefore redundant rather than required: the
 * > same 765 bytes, produced by the run that made the segment anyway.
 * >
 * > It is kept because collapsing it to a single `EXT-X-MAP` is a change to the playlist that
 * > buys one saved request per segment and needs its own browser verification. Card:
 * > `one-ext-x-map-per-rendition-now-that-every-init-is-byte-iden`.
 *
 * > [!NOTE] A SUBTITLE RENDITION WRITES NO `EXT-X-MAP` AT ALL, and that is not an omission
 * > WebVTT segments are plain text with no initialisation section, so there is nothing to map
 * > to. `initFileName` answers null for that rendition and this loop skips the line rather
 * > than publishing a URI that would 404 once per segment.
 */
export function mediaPlaylist(track: Track, t: Timeline): string {
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
    const init = initFileName(track, i);
    if (init) lines.push(`#EXT-X-MAP:URI="${init}"`);
    lines.push(`#EXTINF:${(range.endSec - range.startSec).toFixed(6)},`);
    lines.push(segmentFileName(track, i));
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
