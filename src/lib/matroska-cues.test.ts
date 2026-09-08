/**
 * The Cues reader, against Matroska files this test WRITES.
 *
 * A fixture measured in gigabytes would test nothing a reader can look at, so every file here
 * is built from the same id table the reader reads with -- and built in the layouts real
 * muxers produce, which is where the whole difficulty is: **Cues is usually written at the END
 * of the file**, after the media, because its entries are cluster positions that are not known
 * until the clusters exist. Finding it therefore means following the SeekHead, and the layouts
 * below are the three shapes that appear in the wild plus the ones that must fall back.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cueTimes,
  MATROSKA_ID as ID,
  openFileRange,
  type RangeReader,
  readContainerCutPoints,
} from "./matroska-cues";

// --- writing EBML, which is the only way to have a file worth reading -------------------

const concat = (...parts: readonly (readonly number[] | Uint8Array)[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part instanceof Uint8Array ? part : Uint8Array.from(part), at);
    at += part.length;
  }
  return out;
};

/** An id, as the bytes it is written in -- the marker is part of the number, so this is a dump. */
const idBytes = (id: number): number[] => {
  const out: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  return out;
};

/**
 * A data size, ALWAYS four bytes.
 *
 * Real writers use the shortest form; this one does not, so that swapping a placeholder
 * position for a real one cannot change any element's length and invalidate the layout the
 * placeholder was measured in.
 */
const sizeBytes = (n: number): number[] => [
  0x10 | ((n >>> 24) & 0x0f),
  (n >>> 16) & 0xff,
  (n >>> 8) & 0xff,
  n & 0xff,
];

const el = (id: number, data: readonly number[] | Uint8Array): Uint8Array =>
  concat(idBytes(id), sizeBytes(data.length), data);

/** An unsigned value in the fewest bytes, which is what a muxer writes. */
const uint = (id: number, value: number): Uint8Array => {
  const out: number[] = [];
  for (let v = value; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  return el(id, out.length > 0 ? out : [0]);
};

/** A four-byte unsigned value, so a placeholder offset and a real one are the same size. */
const uint32 = (id: number, value: number): Uint8Array =>
  el(id, [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);

const seekEntry = (target: number, position: number): Uint8Array =>
  el(ID.seek, concat(el(ID.seekId, idBytes(target)), uint32(ID.seekPosition, position)));

const seekHead = (entries: readonly { target: number; position: number }[]): Uint8Array =>
  el(ID.seekHead, concat(...entries.map((e) => seekEntry(e.target, e.position))));

/** Where each part lands, relative to the start of the run. */
const offsetsOf = (parts: readonly Uint8Array[]): number[] => {
  const offsets: number[] = [];
  let at = 0;
  for (const part of parts) {
    offsets.push(at);
    at += part.length;
  }
  return offsets;
};

// --- the pieces of a file --------------------------------------------------------------

/** The real EBML header id. The reader skips it generically, so it never names it. */
const EBML_HEADER_ID = 0x1a45dfa3;
const ebmlHeader = el(EBML_HEADER_ID, [0x42, 0x82, 0x84, 0x6d, 0x61, 0x74, 0x72]);

const infoOf = (timecodeScaleNs: number | null): Uint8Array =>
  el(ID.info, timecodeScaleNs === null ? [] : uint(ID.timecodeScale, timecodeScaleNs));

interface TrackSpec {
  number: number;
  type: number;
}

/** Audio first and video second, so "the video track" cannot be right by accident of order. */
const AUDIO_THEN_VIDEO: TrackSpec[] = [
  { number: 2, type: 2 },
  { number: 1, type: 1 },
];

const tracksOf = (tracks: readonly TrackSpec[]): Uint8Array =>
  el(
    ID.tracks,
    concat(
      ...tracks.map((t) =>
        el(ID.trackEntry, concat(uint(ID.trackNumber, t.number), uint(ID.trackType, t.type))),
      ),
    ),
  );

interface CueSpec {
  ticks: number;
  track: number;
}

/** The CuePoints alone, which is what `cueTimes` is handed. */
const cuePoints = (points: readonly CueSpec[]): Uint8Array =>
  concat(
    ...points.map((c) =>
      el(
        ID.cuePoint,
        concat(uint(ID.cueTime, c.ticks), el(ID.cueTrackPositions, uint(ID.cueTrack, c.track))),
      ),
    ),
  );

const cuesOf = (points: readonly CueSpec[]): Uint8Array => el(ID.cues, cuePoints(points));

/** Two cue points on the video track, plus the zero every file has by construction. */
const DEFAULT_CUES: CueSpec[] = [
  { ticks: 0, track: 1 },
  { ticks: 11011, track: 1 },
  { ticks: 21021, track: 1 },
];

/**
 * Stand-in media, never parsed -- the reader stops at the first cluster by design.
 *
 * Deliberately larger than the reader's head window, so a Cues element written after it really
 * is out of reach of the one read at the start of the file. A small cluster would leave the
 * whole fixture inside that window and every "it followed the SeekHead" test would pass
 * without the SeekHead being needed.
 */
const cluster = el(ID.cluster, new Uint8Array(300 * 1024));

interface FileSpec {
  cues?: readonly CueSpec[] | null;
  tracks?: readonly TrackSpec[];
  timecodeScaleNs?: number | null;
  /**
   * How the index can be found:
   * - `direct`: a leading SeekHead naming Info, Tracks and Cues -- the ordinary shape.
   * - `chained`: a leading SeekHead naming only a second SeekHead at the end of the file.
   * - `none`: no SeekHead at all, so only what precedes the media can be found.
   */
  seek?: "direct" | "chained" | "none";
  /** Put Cues in FRONT of the media, which is legal and lets the head window find it alone. */
  cuesFirst?: boolean;
}

function matroska(spec: FileSpec = {}): Uint8Array {
  const info = infoOf(spec.timecodeScaleNs === undefined ? 1_000_000 : spec.timecodeScaleNs);
  const tracks = tracksOf(spec.tracks ?? AUDIO_THEN_VIDEO);
  const cues = spec.cues === null ? null : cuesOf(spec.cues ?? DEFAULT_CUES);
  const seek = spec.seek ?? "direct";

  /** The Segment's children, with `fill` free to rewrite the placeholders once laid out. */
  const build = (positions: { info: number; tracks: number; cues: number; tail: number }): Uint8Array[] => {
    const body: Uint8Array[] = [info, tracks, cluster];
    if (spec.cuesFirst && cues) body.splice(2, 0, cues);
    else if (cues) body.push(cues);
    if (seek === "none") return body;
    if (seek === "chained") {
      const tail = seekHead([
        { target: ID.info, position: positions.info },
        { target: ID.tracks, position: positions.tracks },
        { target: ID.cues, position: positions.cues },
      ]);
      return [seekHead([{ target: ID.seekHead, position: positions.tail }]), ...body, tail];
    }
    return [
      seekHead([
        { target: ID.info, position: positions.info },
        { target: ID.tracks, position: positions.tracks },
        { target: ID.cues, position: positions.cues },
      ]),
      ...body,
    ];
  };

  // Laid out twice: once with zeroed positions to measure everything, once with the real
  // offsets. The two layouts are byte-identical in length because every position is a fixed
  // four-byte field.
  const measured = build({ info: 0, tracks: 0, cues: 0, tail: 0 });
  const offsets = offsetsOf(measured);
  const indexOf = (part: Uint8Array | null): number =>
    part === null ? 0 : (offsets[measured.indexOf(part)] as number);
  const final = build({
    info: indexOf(info),
    tracks: indexOf(tracks),
    cues: indexOf(cues),
    tail: offsets[measured.length - 1] as number,
  });
  return concat(ebmlHeader, el(ID.segment, concat(...final)));
}

/** A reader over bytes in memory, counting what it was asked for. */
function readerOver(file: Uint8Array): { reader: RangeReader; reads: number[] } {
  const reads: number[] = [];
  return {
    reads,
    reader: {
      size: file.length,
      async read(offset, length) {
        reads.push(offset);
        return file.slice(offset, Math.min(offset + length, file.length));
      },
    },
  };
}

// --- the reader ------------------------------------------------------------------------

describe("reading a file's own index", () => {
  test("the video track's cue times, in seconds", async () => {
    const { reader } = readerOver(matroska());
    expect(await readContainerCutPoints(reader)).toEqual([11.011, 21.021]);
  });

  /**
   * The whole point: a handful of seeks instead of the 1200 the ffprobe probe makes, which is
   * the difference between 0.5 s and 64 s on a cold file over the array.
   */
  test("it costs a handful of reads, not one per probe point", async () => {
    const { reader, reads } = readerOver(matroska());
    await readContainerCutPoints(reader);
    // The head window, then the Cues header and the Cues itself. The SeekHead, Info and
    // Tracks are all inside the window that was already read.
    expect(reads.length).toBeLessThanOrEqual(4);
  });

  test("a SeekHead naming a second SeekHead is followed", async () => {
    const { reader } = readerOver(matroska({ seek: "chained" }));
    expect(await readContainerCutPoints(reader)).toEqual([11.011, 21.021]);
  });

  test("Cues written in front of the media needs no SeekHead at all", async () => {
    const { reader } = readerOver(matroska({ seek: "none", cuesFirst: true }));
    expect(await readContainerCutPoints(reader)).toEqual([11.011, 21.021]);
  });

  /** Walking to it would be a seek per cluster -- thousands, which is the cost being avoided. */
  test("Cues behind the media with no SeekHead is a fallback, not a walk", async () => {
    const { reader, reads } = readerOver(matroska({ seek: "none" }));
    expect(await readContainerCutPoints(reader)).toBeNull();
    expect(reads.length).toBeLessThanOrEqual(2);
  });

  test("a file with no Cues at all falls back", async () => {
    const { reader } = readerOver(matroska({ cues: null }));
    expect(await readContainerCutPoints(reader)).toBeNull();
  });

  /** An audio cue is not a place a copied video stream can be cut. */
  test("Cues indexing only another track falls back rather than lying", async () => {
    const { reader } = readerOver(matroska({ cues: [{ ticks: 11011, track: 2 }] }));
    expect(await readContainerCutPoints(reader)).toBeNull();
  });

  test("a file with no video track has nothing to index", async () => {
    const { reader } = readerOver(matroska({ tracks: [{ number: 2, type: 2 }] }));
    expect(await readContainerCutPoints(reader)).toBeNull();
  });

  /** A wrong scale is a whole timeline wrong by a factor, which is worse than no timeline. */
  test("a non-default TimecodeScale is honoured", async () => {
    const file = matroska({ timecodeScaleNs: 100_000, cues: [{ ticks: 110_110, track: 1 }] });
    expect(await readContainerCutPoints(readerOver(file).reader)).toEqual([11.011]);
  });

  test("an Info with no TimecodeScale gets the spec default", async () => {
    const file = matroska({ timecodeScaleNs: null, cues: [{ ticks: 11_011, track: 1 }] });
    expect(await readContainerCutPoints(readerOver(file).reader)).toEqual([11.011]);
  });

  test("something that is not Matroska is null rather than an invented index", async () => {
    const { reader } = readerOver(new Uint8Array(512));
    expect(await readContainerCutPoints(reader)).toBeNull();
  });

  /** A media share going away mid-read is an ordinary event, and the fallback handles it. */
  test("an I/O error is a fallback, not a throw", async () => {
    const failing: RangeReader = {
      size: 1000,
      read: () => Promise.reject(new Error("EIO")),
    };
    expect(await readContainerCutPoints(failing)).toBeNull();
  });

  /**
   * Following a wrong offset lands in the middle of the media, where bytes still parse as
   * elements -- so the id at the target is checked rather than trusted.
   */
  test("a SeekHead pointing at the wrong place is refused", async () => {
    const broken = concat(matroska());
    // Point every SeekPosition at the start of the Segment, which holds the SeekHead itself:
    // a real, parseable element that is not the one the entry claimed.
    for (let i = 0; i < broken.length - 9; i++) {
      if (broken[i] === 0x53 && broken[i + 1] === 0xac) broken.fill(0, i + 6, i + 10);
    }
    expect(await readContainerCutPoints(readerOver(broken).reader)).toBeNull();
  });
});

describe("cue times", () => {
  const cues = cuePoints([
    { ticks: 0, track: 1 },
    { ticks: 21021, track: 1 },
    { ticks: 11011, track: 1 },
    { ticks: 21021, track: 1 },
    { ticks: 30030, track: 2 },
  ]);

  test("ascending, unique, and never the zero that is a boundary anyway", () => {
    expect(cueTimes(cues, 1, 1_000_000)).toEqual([11.011, 21.021]);
  });

  test("another track's cue points are not ours", () => {
    expect(cueTimes(cues, 2, 1_000_000)).toEqual([30.03]);
  });

  test("nothing for this track is an empty list rather than a throw", () => {
    expect(cueTimes(cues, 9, 1_000_000)).toEqual([]);
  });
});

describe("opening a real file", () => {
  test("a path that is not there cannot be read", async () => {
    expect(await openFileRange("/definitely/not/a/file.mkv")).toBeNull();
  });

  test("a real file reads its own bytes back, and knows its size", async () => {
    const dir = mkdtempSync(join(tmpdir(), "finderr-cues-"));
    try {
      const path = join(dir, "tiny.mkv");
      const file = matroska();
      await Bun.write(path, file);
      const reader = await openFileRange(path);
      expect(reader?.size).toBe(file.length);
      expect(await readContainerCutPoints(reader as RangeReader)).toEqual([11.011, 21.021]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
