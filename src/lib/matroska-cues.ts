/**
 * Reading a Matroska file's OWN index, which is the cheapest honest answer to "where can this
 * be cut" that exists -- one seek and one sequential read, against a probe that costs a minute.
 *
 * ## Why this exists, measured on the NAS over the array on 2026-09-08
 *
 * `keyframes.ts` finds cut points by asking ffprobe for one packet at each of up to 1200 seek
 * points. That is 0.47 s on a file whose pages are resident and **64.28 s on a cold 31 GB
 * one** -- 1200 random seeks over nine spinning disks -- against a 30 s timeout. So the first
 * play of a large title times out and falls back to a uniform grid, which is a LIE about where
 * the file can be cut: a copy-mode segment produced for a grid boundary starts early, hls.js
 * re-times it, and the timeline grows a ~1.3 s hole at every boundary.
 *
 * Every one of those 1200 seeks lands in the same place the demuxer's own index already points
 * at. Matroska writes that index down as a **Cues** element -- one contiguous block, a few
 * hundred kilobytes -- so reading it costs one seek plus one sequential read of a region we
 * ask for by size. Jellyfin does exactly this and falls back to ffprobe; so does this.
 *
 * > [!IMPORTANT] MP4 NEEDS NOTHING FROM THIS, and that is why only Matroska is implemented
 * > MP4's sync sample table lives in `moov`, which every reader parses when it OPENS the file,
 * > so the sparse probe's seeks are already answered from memory there. 38 of the 1173 files in
 * > this library are MP4 and the rest are Matroska; the expensive case is the common one.
 *
 * > [!CAUTION] THESE ARE THE OFFSETS FFMPEG SEEKS BY, WHICH IS A STRONGER CLAIM THAN "KEYFRAMES"
 * > ffmpeg's Matroska demuxer builds its seek index FROM this element, so a CueTime is exactly
 * > a place its `-ss` can land, which is the property `hls-timeline.ts` needs. It is a SUBSET
 * > of the file's keyframes -- a writer indexes what it chooses to -- and that is harmless
 * > here for the same reason the sparse probe's subset is: each boundary only has to be real,
 * > and a missing one makes a segment longer rather than wrong. It would NOT be harmless in a
 * > design that predicts where a single long ffmpeg run will cut, which is one of the reasons
 * > that design is closed.
 *
 * ## What it refuses to answer, and why refusing is cheap
 *
 * Anything unexpected returns null and the caller pays for the ffprobe probe it would have
 * paid for anyway. A file with no Cues, an unknown-length Segment, a Cues element indexing only
 * an audio track, a `Tracks` we cannot find: all null. **A wrong cut point is far worse than an
 * absent one** -- it produces a segment boundary that does not exist in the file, which is the
 * uniform-grid failure this module exists to remove, except silent.
 */

import { childrenOf, type EbmlElement, elementsIn, elementUint, findChild, readElement } from "./ebml";

/**
 * Random access to one file. INJECTED, so every test in this module runs on bytes it built
 * itself -- no media, no filesystem, no fixture measured in gigabytes.
 */
export interface RangeReader {
  /** Total bytes in the file, which is also half of the cache key `keyframes.ts` uses. */
  readonly size: number;
  /** The bytes in `[offset, offset + length)`, or fewer at end of file. */
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** A `RangeReader` over a real file, or null when it cannot be opened or is empty. */
export async function openFileRange(path: string): Promise<RangeReader | null> {
  const file = Bun.file(path);
  const size = file.size;
  if (!(size > 0)) return null;
  return {
    size,
    async read(offset, length) {
      const end = Math.min(offset + length, size);
      if (end <= offset) return new Uint8Array(0);
      return new Uint8Array(await file.slice(offset, end).arrayBuffer());
    },
  };
}

/**
 * The element ids this reader knows, with their length markers, exactly as the spec writes them.
 *
 * EXPORTED so the tests build their fixture files out of the same table this reads them with.
 * A second copy of these constants in a test would drift, and a drifted id in a fixture makes
 * the test pass against a file no muxer would ever write.
 */
export const MATROSKA_ID = {
  segment: 0x18538067,
  seekHead: 0x114d9b74,
  seek: 0x4dbb,
  seekId: 0x53ab,
  seekPosition: 0x53ac,
  info: 0x1549a966,
  timecodeScale: 0x2ad7b1,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  trackType: 0x83,
  cues: 0x1c53bb6b,
  cuePoint: 0xbb,
  cueTime: 0xb3,
  cueTrackPositions: 0xb7,
  cueTrack: 0xf7,
  cluster: 0x1f43b675,
} as const;

/** `TrackType` for video. The one track kind whose keyframes constrain a cut. */
const VIDEO_TRACK_TYPE = 1;

/**
 * How much of the file's head is read in one go, before anything is parsed.
 *
 * It has to cover the EBML header, the leading SeekHead and -- with luck -- Info and Tracks,
 * because reading it is ONE sequential read at the cheapest offset on the disk. 256 KiB is
 * generous for that and still a rounding error beside the 30 s this module exists to avoid.
 * Anything not in it is found through the SeekHead, which is what a SeekHead is for.
 */
const HEAD_WINDOW_BYTES = 256 * 1024;

/** Enough for the longest id plus the longest size field, with room to spare. */
const ELEMENT_HEADER_BYTES = 16;

/**
 * Ceilings on the elements this reader will pull into memory.
 *
 * A Cues element for a three-hour film runs to a few hundred kilobytes; 16 MiB is far past any
 * real one and stops a corrupt or hostile size field from asking for a gigabyte. Info and
 * Tracks are kilobytes -- CodecPrivate is the only thing in them with any size at all.
 */
const MAX_CUES_BYTES = 16 * 1024 * 1024;
const MAX_HEADER_ELEMENT_BYTES = 4 * 1024 * 1024;

/**
 * How many SeekHeads will be followed before giving up.
 *
 * Two is the shape real files have: a leading one that points at the index, or a leading one
 * that points at a second SeekHead written at the end of the file beside the Cues. A limit
 * exists at all because a corrupt file can point a SeekHead at itself, and this loop reads
 * from a disk.
 */
const MAX_SEEK_HEADS = 4;

/** Matroska's own default, in nanoseconds per tick, for a file whose Info omits it. */
const DEFAULT_TIMECODE_SCALE_NS = 1_000_000;

/** Where the parts of the Segment live, as absolute offsets of their element headers. */
interface SegmentMap {
  info: number | null;
  tracks: number | null;
  cues: number | null;
}

/** The ids worth remembering the position of, so noticing one is a lookup rather than a switch. */
const MAPPED: Readonly<Record<number, keyof SegmentMap>> = {
  [MATROSKA_ID.info]: "info",
  [MATROSKA_ID.tracks]: "tracks",
  [MATROSKA_ID.cues]: "cues",
};

/**
 * Where this file can be cut, in seconds, or null when its index cannot be read.
 *
 * Never throws: an I/O error on a media share is an ordinary event and the caller's answer to
 * it is the same as its answer to a file with no Cues, which is to probe instead.
 */
export async function readContainerCutPoints(reader: RangeReader): Promise<number[] | null> {
  try {
    return await readCues(reader);
  } catch {
    return null;
  }
}

async function readCues(source: RangeReader): Promise<number[] | null> {
  const head = await source.read(0, HEAD_WINDOW_BYTES);
  const segment = findSegment(head);
  if (!segment) return null;
  const reader = servedFromHead(source, head);

  const map = await mapSegment(reader, head, segment.dataStart);
  if (map.cues === null || map.info === null || map.tracks === null) return null;

  // Info first: a file whose TimecodeScale we cannot read is one whose cue times we cannot
  // turn into seconds, and a wrong scale is a whole timeline that is wrong by a factor.
  const info = await readElementAt(reader, map.info, MATROSKA_ID.info, MAX_HEADER_ELEMENT_BYTES);
  if (!info) return null;
  const timecodeScaleNs = timecodeScaleOf(info);

  const tracks = await readElementAt(reader, map.tracks, MATROSKA_ID.tracks, MAX_HEADER_ELEMENT_BYTES);
  if (!tracks) return null;
  const videoTrack = videoTrackNumber(tracks);
  if (videoTrack === null) return null;

  const cues = await readElementAt(reader, map.cues, MATROSKA_ID.cues, MAX_CUES_BYTES);
  if (!cues) return null;
  const times = cueTimes(cues, videoTrack, timecodeScaleNs);
  return times.length > 0 ? times : null;
}

/**
 * The same file, with the head window it has already read answered from memory.
 *
 * The SeekHead, Info and Tracks all live in that window in an ordinary file, and re-reading
 * each of them would be three more seeks on a disk whose seeks are the entire cost being
 * avoided here. Everything past the window -- the Cues, in every real layout -- goes to the
 * file as before.
 */
function servedFromHead(source: RangeReader, head: Uint8Array): RangeReader {
  return {
    size: source.size,
    read: (offset, length) =>
      offset >= 0 && offset + length <= head.length
        ? Promise.resolve(head.subarray(offset, offset + length))
        : source.read(offset, length),
  };
}

/** The Segment element, skipping the EBML header and any padding in front of it. */
function findSegment(head: Uint8Array): EbmlElement | null {
  for (const el of elementsIn(head, 0, head.length)) {
    if (el.id === MATROSKA_ID.segment) return el;
  }
  return null;
}

/**
 * Where Info, Tracks and Cues are, from the head window first and the SeekHead for the rest.
 *
 * The window alone answers it for the elements a writer puts in front of the media. **Cues is
 * usually not one of them** -- it can only be written once the cluster positions are known, so
 * it lands at the end of the file -- and finding it by walking top-level elements would mean a
 * seek per cluster, thousands of them, which is the cost this module exists to avoid. The
 * SeekHead is the file's own answer to that and it is why the format has one.
 */
async function mapSegment(
  reader: RangeReader,
  head: Uint8Array,
  segmentDataStart: number,
): Promise<SegmentMap> {
  const map: SegmentMap = { info: null, tracks: null, cues: null };
  const note = (id: number, at: number) => {
    const key = MAPPED[id];
    if (key && map[key] === null) map[key] = at;
  };

  const pending: number[] = [];
  for (const el of elementsIn(head, segmentDataStart, head.length)) {
    // The media starts here, and nothing beyond it is worth walking to element by element.
    if (el.id === MATROSKA_ID.cluster) break;
    if (el.id === MATROSKA_ID.seekHead) pending.push(el.start);
    else note(el.id, el.start);
  }

  const visited = new Set<number>();
  while (pending.length > 0 && !isComplete(map) && visited.size < MAX_SEEK_HEADS) {
    const at = pending.shift() as number;
    if (visited.has(at)) continue;
    visited.add(at);
    const seekHead = await readElementAt(reader, at, MATROSKA_ID.seekHead, MAX_HEADER_ELEMENT_BYTES);
    if (!seekHead) continue;
    for (const entry of seekEntries(seekHead)) {
      const target = segmentDataStart + entry.position;
      if (entry.id === MATROSKA_ID.seekHead) pending.push(target);
      else note(entry.id, target);
    }
  }
  return map;
}

function isComplete(map: SegmentMap): boolean {
  return map.info !== null && map.tracks !== null && map.cues !== null;
}

/**
 * Every `Seek` in a SeekHead: which element, and where it is relative to the Segment's data.
 *
 * `SeekID` holds the id BYTES, marker and all, which is exactly the form `readUint` produces
 * and the form the `ID` table above is written in -- so the comparison needs no translation.
 */
function* seekEntries(seekHead: Uint8Array): Generator<{ id: number; position: number }> {
  for (const seek of elementsIn(seekHead, 0, seekHead.length)) {
    if (seek.id !== MATROSKA_ID.seek) continue;
    const idEl = findChild(seekHead, seek, MATROSKA_ID.seekId);
    const posEl = findChild(seekHead, seek, MATROSKA_ID.seekPosition);
    if (!idEl || !posEl) continue;
    const id = elementUint(seekHead, idEl);
    const position = elementUint(seekHead, posEl);
    if (id === null || position === null) continue;
    yield { id, position };
  }
}

/** Nanoseconds per timecode tick. Absent means the spec default, which is what writers omit. */
function timecodeScaleOf(info: Uint8Array): number {
  for (const el of elementsIn(info, 0, info.length)) {
    if (el.id !== MATROSKA_ID.timecodeScale) continue;
    const scale = elementUint(info, el);
    if (scale !== null && scale > 0) return scale;
  }
  return DEFAULT_TIMECODE_SCALE_NS;
}

/**
 * The `TrackNumber` of the first video track, or null when there is none to be found.
 *
 * FIRST, because that is the track `ffprobe -select_streams v:0` reports and the one
 * `playback-plan.ts` maps -- three places have to agree about which stream is "the video" and
 * this is the cheap way for them to agree.
 */
function videoTrackNumber(tracks: Uint8Array): number | null {
  for (const entry of elementsIn(tracks, 0, tracks.length)) {
    if (entry.id !== MATROSKA_ID.trackEntry) continue;
    const typeEl = findChild(tracks, entry, MATROSKA_ID.trackType);
    const numberEl = findChild(tracks, entry, MATROSKA_ID.trackNumber);
    if (!typeEl || !numberEl) continue;
    if (elementUint(tracks, typeEl) !== VIDEO_TRACK_TYPE) continue;
    const number = elementUint(tracks, numberEl);
    if (number !== null) return number;
  }
  return null;
}

/**
 * The cue times for one track, in ascending unique seconds.
 *
 * PURE and exported, because this is where the surprises are. Two of them are worth naming:
 *
 * - **A CuePoint that does not index THIS track is dropped.** A Cues element may index audio,
 *   subtitles or several tracks at once, and an audio cue is not a place a copied video stream
 *   can be cut. Keeping one would put a boundary in the playlist that the file cannot honour.
 * - **`t = 0` is dropped**, exactly as the ffprobe path drops it: the first boundary exists by
 *   construction, so an entry for it is a duplicate rather than information.
 *
 * Rounded to microseconds because the arithmetic is ticks times nanoseconds over a billion,
 * which lands a hair off a round number in binary floating point. A cut point is fed to
 * ffmpeg's `-ss` as text, so six decimals is all that ever survives anyway -- and it makes
 * these numbers directly comparable with what ffprobe prints.
 */
export function cueTimes(cues: Uint8Array, trackNumber: number, timecodeScaleNs: number): number[] {
  const seconds = new Set<number>();
  for (const point of elementsIn(cues, 0, cues.length)) {
    if (point.id !== MATROSKA_ID.cuePoint) continue;
    const timeEl = findChild(cues, point, MATROSKA_ID.cueTime);
    if (!timeEl) continue;
    if (!indexesTrack(cues, point, trackNumber)) continue;
    const ticks = elementUint(cues, timeEl);
    if (ticks === null) continue;
    const t = Math.round((ticks * timecodeScaleNs) / 1000) / 1e6;
    if (Number.isFinite(t) && t > 0) seconds.add(t);
  }
  return [...seconds].sort((a, b) => a - b);
}

/** Whether any of this CuePoint's positions is for the track we care about. */
function indexesTrack(cues: Uint8Array, point: EbmlElement, trackNumber: number): boolean {
  for (const positions of childrenOf(cues, point)) {
    if (positions.id !== MATROSKA_ID.cueTrackPositions) continue;
    const trackEl = findChild(cues, positions, MATROSKA_ID.cueTrack);
    if (trackEl && elementUint(cues, trackEl) === trackNumber) return true;
  }
  return false;
}

/**
 * One element's data, read by its position: a header read, then a read of exactly its size.
 *
 * The expected id is checked rather than trusted. A `SeekPosition` is a byte offset written by
 * somebody else's muxer, and following a wrong one lands us in the middle of the media -- where
 * bytes still parse as elements and would yield an index made of noise.
 */
async function readElementAt(
  reader: RangeReader,
  offset: number,
  expectedId: number,
  maxBytes: number,
): Promise<Uint8Array | null> {
  if (offset < 0 || offset >= reader.size) return null;
  const header = await reader.read(offset, ELEMENT_HEADER_BYTES);
  const el = readElement(header, 0);
  if (!el || el.id !== expectedId || el.dataSize === null || el.dataSize > maxBytes) return null;
  const data = await reader.read(offset + el.dataStart, el.dataSize);
  return data.length === el.dataSize ? data : null;
}
