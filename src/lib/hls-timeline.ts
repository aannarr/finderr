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
 * ## THE TRACKS ARE SEGMENTED SEPARATELY, and that is what closes the audio hole
 *
 * A muxed segment can honour exactly ONE cutting rule, and video's rule -- cut on a keyframe
 * -- is the strictest. ffmpeg obeys it and writes the audio packets that arrive after that
 * keyframe into the NEXT segment of the run, which is discarded because the next segment
 * comes from a different run seeking past them. Measured 2026-09-08: **~60 ms of sound missing
 * at every boundary**, showing up in the browser as a ~0.16 s hole in `media.buffered`, a
 * `bufferStalledError` and a freeze every six seconds.
 *
 * So video and audio are published as SEPARATE RENDITIONS, which is what production packagers
 * do. The video rendition keeps the keyframe grid it has to keep. An audio rendition has no
 * keyframe constraint at all -- every audio packet is a key packet -- so it gets a plain
 * uniform grid and `playback-plan.ts` makes each audio segment cover its whole declared range
 * and a little of the one before it. A gap becomes impossible rather than jumped over.
 *
 * The grids do NOT have to match, and forcing them to would bring the constraint straight
 * back: hls.js aligns renditions by timestamp, not by segment index.
 *
 * ## SUBTITLES ARE RENDITIONS TOO, and they are segmented for the same reason
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
 *
 * ## THERE ARE N RENDITIONS OF A KIND, NOT ONE, and that is why a track has an ORDINAL
 *
 * Measured over a 1-in-9 sample of the real movie library on 2026-09-08: **53% of films carry
 * two or more TEXT subtitle tracks and 19% carry two or more audio tracks**. Publishing one of
 * each and calling it "Audio" hands a viewer whichever track the muxer happened to flag --
 * frequently a foreign dub, or a forced-narrative subtitle carrying four lines for the whole
 * film. So a `Track` is a KIND plus an ORDINAL, HLS's own `EXT-X-MEDIA` group carries one
 * entry per rendition with a real `NAME` and `LANGUAGE`, and the choice is the player's.
 */

/** What a rendition carries. The three things HLS models separately. */
export type TrackKind = "video" | "audio" | "subtitles";

/** Every kind, in the order a reader expects them. The one owner of that list. */
export const TRACK_KINDS: readonly TrackKind[] = ["video", "audio", "subtitles"];

/**
 * One published rendition: what it carries, and which of that kind it is.
 *
 * The ordinal is a PUBLISHED identity rather than a source stream number -- renditions of a
 * kind are numbered 0, 1, 2 in the order they are offered, and which source stream each one
 * is made from is `PlaybackPlan`'s business. That keeps the names on the wire short and
 * stable, and it means the ordinal always indexes the plan's list for that kind.
 *
 * **The first AUDIO rendition is the one that plays.** `planPlayback` puts the container's
 * own default first, so "which rendition is default" is a position rather than a flag that
 * could disagree with the order -- see `masterPlaylist`.
 */
export interface Track {
  readonly kind: TrackKind;
  readonly ordinal: number;
}

/**
 * A track's identity as ONE string, so it can key a map and name a playlist.
 *
 * `video0`, `audio1`, `subtitles3`. Nothing parses it back -- `parseProducedName` reads the
 * FILE names, which carry the same two numbers in their own spelling -- so this exists purely
 * to be a key that two `Track` values with the same fields agree on.
 */
export function trackKey(track: Track): string {
  return `${track.kind}${track.ordinal}`;
}

/**
 * How one rendition is described to a viewer, in the player's own menu.
 *
 * Derived once by `playback-plan.ts` from what the container said, and carried here rather
 * than re-derived: this module writes the manifest and has never seen a probe.
 */
export interface TrackLabel {
  /** What a player's menu shows. Never empty, and distinct within its kind. */
  name: string;
  /** BCP-47-ish as the container tagged it, or null when it said nothing usable. */
  language: string | null;
}

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
 * One rendition a session publishes: what it is, how it is cut, and how it is offered.
 *
 * A LIST of these rather than a map keyed by kind, because there are now several renditions
 * of a kind and their ORDER is the offer -- audio 0 is the one that plays. A rendition the
 * source does not have is simply not in the list: no playlist, no segments, and no
 * `EXT-X-MEDIA` line naming a rendition that would 404.
 */
export interface PublishedTrack {
  track: Track;
  timeline: Timeline;
  label: TrackLabel;
}

/** Everything a session publishes, in offer order. */
export type PublishedTracks = readonly PublishedTrack[];

/** The published renditions of one kind, still in offer order. */
export function tracksOfKind(published: PublishedTracks, kind: TrackKind): PublishedTracks {
  return published.filter((t) => t.track.kind === kind);
}

/**
 * The renditions a player must have before it can show a frame.
 *
 * The video, and the ONE audio rendition the player will select -- never the alternates and
 * never subtitles. hls.js fetches nothing for a rendition it has not selected, so warming one
 * would spend an ffmpeg run on the start request for something nobody has asked to hear.
 */
export function tracksBlockingFirstFrame(published: PublishedTracks): Track[] {
  const first = (kind: TrackKind) => tracksOfKind(published, kind)[0]?.track;
  return [first("video"), first("audio")].filter((track): track is Track => track !== undefined);
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
 * An exact grid: what a re-encode gets, and what every AUDIO and SUBTITLE rendition gets.
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
 * What each KIND of rendition's published files are called, and what they are served as.
 *
 * ONE table, because these names are written in four languages -- generated here, matched by
 * the route, handed to ffmpeg as a `%05d` template, and read back off disk by the session --
 * and four independent spellings is the classic pair that drifts into a file published under
 * a name the playlist never mentions.
 *
 * `init` is ABSENT on subtitles rather than empty: a WebVTT rendition has no fMP4
 * initialisation segment to publish, so there is nothing to name and no `EXT-X-MAP` to write.
 */
const TRACK_FILES: Record<TrackKind, TrackFiles> = {
  video: {
    segment: { prefix: "vseg", extension: ".m4s" },
    init: { prefix: "vinit", extension: ".mp4" },
    contentType: "video/iso.segment",
  },
  audio: {
    segment: { prefix: "aseg", extension: ".m4s" },
    init: { prefix: "ainit", extension: ".mp4" },
    contentType: "video/iso.segment",
  },
  subtitles: {
    segment: { prefix: "sseg", extension: ".vtt" },
    contentType: "text/vtt",
  },
};

/** Everything about one kind's published files that has to be spelled the same way twice. */
interface TrackFiles {
  segment: FileNaming;
  /** Absent when the rendition has no initialisation segment. WebVTT has none. */
  init?: FileNaming;
  /** What a produced media segment of this kind is served as. */
  contentType: string;
}

/** How one kind of published file is spelled: a fixed prefix, an index, a fixed extension. */
interface FileNaming {
  prefix: string;
  extension: string;
}

/** Which published file of a segment: the media itself, or the header it needs. */
type ProducedFileKind = "segment" | "init";

/** How many digits a segment index carries in a published name. `%05d` in ffmpeg's template. */
const INDEX_DIGITS = 5;

/**
 * What separates a rendition's ordinal from its segment index in a published name.
 *
 * `vseg0-00042.m4s`. The ordinal is UNPADDED, so the two numbers cannot be told apart by
 * width alone and something has to sit between them -- and a separator that is neither a
 * digit nor part of any prefix or extension makes `producedIn` a split rather than a regex.
 */
const ORDINAL_SEPARATOR = "-";

function publishedName(naming: FileNaming, track: Track, index: number): string {
  const at = String(index).padStart(INDEX_DIGITS, "0");
  return `${naming.prefix}${track.ordinal}${ORDINAL_SEPARATOR}${at}${naming.extension}`;
}

/** How a media segment file is named. The one owner of that spelling. */
export function segmentFileName(track: Track, index: number): string {
  return publishedName(TRACK_FILES[track.kind].segment, track, index);
}

/**
 * How a published initialisation segment is named, or null for a rendition that has none.
 *
 * Null is a real answer rather than a failure: WebVTT segments carry no fMP4 header, so a
 * subtitle rendition publishes nothing beside its media and every caller decides what that
 * means for it -- no `EXT-X-MAP` in the playlist, nothing to rename, nothing to evict.
 */
export function initFileName(track: Track, index: number): string | null {
  const naming = TRACK_FILES[track.kind].init;
  return naming ? publishedName(naming, track, index) : null;
}

/** What a produced media segment of this rendition is served as. The one owner of that. */
export function segmentContentType(track: Track): string {
  return TRACK_FILES[track.kind].contentType;
}

/**
 * The same spelling as `segmentFileName`, in ffmpeg's template language.
 *
 * Derived from the same table rather than typed a second time, so the two cannot drift.
 */
export function segmentFilePattern(track: Track): string {
  const naming = TRACK_FILES[track.kind].segment;
  return `${naming.prefix}${track.ordinal}${ORDINAL_SEPARATOR}%0${INDEX_DIGITS}d${naming.extension}`;
}

/**
 * The name of one rendition's media playlist, as the master playlist points at it.
 *
 * The track key plus an extension, so the playlist name and the map key cannot drift apart.
 */
export function mediaPlaylistName(track: Track): string {
  return `${trackKey(track)}.m3u8`;
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
  file: ProducedFileKind;
  index: number;
}

/**
 * Read a published file name back into the thing it names, or null when it is not one of ours.
 *
 * **This is the traversal guard, and it works by ENUMERATING what is allowed rather than by
 * stripping what is forbidden.** The name arrives off the wire and a session directory is a
 * real directory, so the only safe shape is a closed pattern whose captures become NUMBERS
 * before anything touches the filesystem -- no `..`, no slash, no dot-file, no extension we
 * did not write. Parsing lives here, beside the spelling it has to agree with, so the route
 * never re-types a pattern that could drift from the names actually produced.
 */
export function parseProducedName(name: string): ProducedName | null {
  for (const kind of TRACK_KINDS) {
    for (const file of ["segment", "init"] as const) {
      const found = producedIn(kind, file, name);
      if (found) return found;
    }
  }
  return null;
}

/**
 * The rendition and segment this name carries, or null when it is not this naming at all.
 *
 * The split is a guess and the round trip is the guard: a name is accepted only when
 * re-generating it from the parsed numbers reproduces the name EXACTLY, which settles the
 * prefix, the digit count, the padding, the separator and the extension in one comparison. So
 * there is no separate pattern to keep in step with `publishedName`, and no way for a name
 * that merely resembles ours to slip through.
 */
function producedIn(kind: TrackKind, file: ProducedFileKind, name: string): ProducedName | null {
  const naming = TRACK_FILES[kind][file];
  // A rendition with no initialisation segment has no name to match, and matching one would
  // admit a file this server never writes.
  if (!naming) return null;
  const body = name.slice(naming.prefix.length, name.length - naming.extension.length);
  const [ordinalText, indexText] = body.split(ORDINAL_SEPARATOR);
  if (!isDigits(ordinalText) || !isDigits(indexText)) return null;
  const track: Track = { kind, ordinal: Number(ordinalText) };
  const index = Number(indexText);
  return publishedName(naming, track, index) === name ? { track, file, index } : null;
}

function isDigits(text: string | undefined): text is string {
  return text !== undefined && /^\d+$/.test(text);
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
 * A `GROUP-ID` is spelled twice by construction -- on the `EXT-X-MEDIA` lines that define the
 * group and on the `EXT-X-STREAM-INF` that joins it -- and a variant naming a group that does
 * not exist is a manifest a player rejects outright.
 */
const AUDIO_GROUP = "audio";
const SUBTITLE_GROUP = "subs";

/**
 * The master playlist: which renditions exist, what each is called, and where its playlist is.
 *
 * > [!IMPORTANT] NO `CODECS` ATTRIBUTE, DELIBERATELY
 * > It is optional, and getting it wrong is fatal rather than cosmetic -- a declared codec
 * > string that does not match the media makes the browser refuse the SourceBuffer outright.
 * > hls.js reads the real codec out of each rendition's fMP4 initialisation segment, which is
 * > the only place that cannot be wrong about it.
 *
 * > [!IMPORTANT] AN AUDIO-ONLY TITLE OFFERS ONE AUDIO RENDITION, and that is a shape rather
 * > than a policy
 * > With no video there is nothing for an audio GROUP to hang off: the variant must itself be
 * > an audio playlist, and a variant that also joined an audio group would name the same media
 * > twice. So the caller publishes only the default audio rendition for such a title -- see
 * > `publishedTracksFor` in `playback-routes.ts` -- and this function simply writes what it is
 * > given.
 */
export function masterPlaylist(published: PublishedTracks): string {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS"];
  const video = tracksOfKind(published, "video");
  const audio = tracksOfKind(published, "audio");
  const subtitles = tracksOfKind(published, "subtitles");

  // Audio is a separate rendition ONLY when there is video to attach it to.
  const separateAudio = video.length > 0 && audio.length > 0;
  if (separateAudio) {
    // `DEFAULT=YES` on the FIRST one, which is the container's own default -- `planPlayback`
    // put it there. `AUTOSELECT=YES` on all of them is what lets a player whose system
    // language is Japanese pick the Japanese track without anybody touching a menu.
    for (const t of audio) {
      lines.push(mediaLine("AUDIO", AUDIO_GROUP, t, { isDefault: t.track.ordinal === 0, autoselect: true }));
    }
  }
  // `DEFAULT=NO,AUTOSELECT=NO` is the whole subtitle policy and it is deliberate: a rendition
  // is OFFERED and never switched on for you. hls.js leaves them unselected, so it fetches no
  // subtitle fragment -- and produces no ffmpeg run -- until a viewer picks one out of a menu.
  // AUTOSELECT would break exactly that: a player matching its system language would start
  // producing segments for a track nobody asked to see.
  for (const t of subtitles) {
    lines.push(mediaLine("SUBTITLES", SUBTITLE_GROUP, t, { isDefault: false, autoselect: false }));
  }

  const variant = video[0] ?? audio[0];
  const groups = [
    separateAudio ? `,AUDIO="${AUDIO_GROUP}"` : "",
    subtitles.length > 0 ? `,SUBTITLES="${SUBTITLE_GROUP}"` : "",
  ].join("");
  lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${NOMINAL_BANDWIDTH}${groups}`);
  // RELATIVE, like every other name this module writes -- see `mediaPlaylist`.
  if (variant) lines.push(mediaPlaylistName(variant.track));
  return `${lines.join("\n")}\n`;
}

/**
 * One `EXT-X-MEDIA` line: a rendition, as the player's menu will show it.
 *
 * `LANGUAGE` is omitted rather than emptied when the container said nothing usable -- an empty
 * attribute is a claim about the language, and "we do not know" is not one.
 */
function mediaLine(
  type: "AUDIO" | "SUBTITLES",
  group: string,
  published: PublishedTrack,
  offer: { isDefault: boolean; autoselect: boolean },
): string {
  const { name, language } = published.label;
  return [
    `#EXT-X-MEDIA:TYPE=${type}`,
    `GROUP-ID="${group}"`,
    `NAME="${name}"`,
    ...(language ? [`LANGUAGE="${language}"`] : []),
    `DEFAULT=${offer.isDefault ? "YES" : "NO"}`,
    `AUTOSELECT=${offer.autoselect ? "YES" : "NO"}`,
    `URI="${mediaPlaylistName(published.track)}"`,
  ].join(",");
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
