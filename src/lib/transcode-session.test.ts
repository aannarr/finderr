/**
 * The session manager, against a fake ffmpeg and a fake clock.
 *
 * No real ffmpeg and no media here on purpose: every property worth pinning is about the
 * BOOKKEEPING -- who joins whom, what is refused, what is reaped, which segment file is
 * published and when -- and a real transcode would make each of those cases a second slower
 * and no more true. The real ffmpeg is exercised in `playback-plan.test.ts`'s argv and end to
 * end by hand.
 *
 * The fake spawner does WRITE the files a real run would, because publication is the half of
 * this module that touches the disk: a segment is renamed into place only when it is
 * complete, and a test that never produced a file could not tell that apart from a test that
 * served a half-written one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { initName } from "../test/playback-names";
import {
  type PublishedTracks,
  RUN_INIT_NAME,
  segmentFileName,
  type Timeline,
  type Track,
} from "./hls-timeline";
import type { PlaybackPlan } from "./playback-plan";
import {
  EXPENSIVE_SESSIONS,
  HARD_TTL_MS,
  IDLE_REAP_MS,
  MAX_SESSIONS,
  SEGMENT_CACHE,
  SEGMENT_CONCURRENCY,
  type SegmentRun,
  SessionRefused,
  type Spawner,
  STREAM_TOKEN_TTL_MS,
  sessionKey,
  TOKEN_GRACE_MS,
  TranscodeSessions,
} from "./transcode-session";

const ENGLISH = { name: "English", language: "eng" };

const CHEAP: PlaybackPlan = {
  video: { action: "copy", sourceIndex: 0, codec: "h264", scaleWidth: null },
  audio: [{ action: "transcode", sourceIndex: 1, codec: "aac", label: ENGLISH }],
  subtitles: [],
  reasons: [],
};

const EXPENSIVE: PlaybackPlan = {
  video: { action: "transcode", sourceIndex: 0, codec: "h264", scaleWidth: 1280 },
  audio: [{ action: "transcode", sourceIndex: 1, codec: "aac", label: ENGLISH }],
  subtitles: [],
  reasons: [],
};

/** The same file offering a second audio track, which is a DIFFERENT plan for the same input. */
const DUBBED: PlaybackPlan = {
  ...CHEAP,
  audio: [
    ...CHEAP.audio,
    { action: "copy", sourceIndex: 2, codec: "aac", label: { name: "Japanese", language: "jpn" } },
  ],
};

/**
 * Sixty segments each: long enough that eviction and out-of-range both have room.
 *
 * The two grids are deliberately DIFFERENT, as the real ones are -- video lands on the
 * source's keyframes and audio on a plain grid -- so a test that asserts a range proves the
 * session handed the right rendition's timeline down rather than whichever it had.
 */
const VIDEO_TIMELINE: Timeline = {
  starts: Array.from({ length: 60 }, (_, i) => i * 6.006),
  endSec: 360.36,
};
const AUDIO_TIMELINE: Timeline = {
  starts: Array.from({ length: 60 }, (_, i) => i * 6),
  endSec: 360.36,
};

const VIDEO: Track = { kind: "video", ordinal: 0 };
const AUDIO: Track = { kind: "audio", ordinal: 0 };
/** The alternate audio rendition a dubbed title publishes beside the default. */
const AUDIO_2: Track = { kind: "audio", ordinal: 1 };

const label = { name: "Track", language: null };
const TRACKS: PublishedTracks = [
  { track: VIDEO, timeline: VIDEO_TIMELINE, label },
  { track: AUDIO, timeline: AUDIO_TIMELINE, label },
];

/**
 * What a run of the fake ffmpeg is told to write, read back out of its own argv.
 *
 * The media name is DERIVED from the `-hls_segment_filename` template rather than rebuilt
 * from the track, exactly as ffmpeg derives it -- so the fake cannot accidentally agree with
 * the session about a name the real one would have spelled differently.
 */
function outputOf(argv: string[]): { work: string; media: string; index: number } {
  const pattern = argv[argv.indexOf("-hls_segment_filename") + 1] ?? "";
  const index = Number(argv[argv.indexOf("-start_number") + 1]);
  return {
    work: dirname(pattern),
    media: basename(pattern).replace("%05d", String(index).padStart(5, "0")),
    index,
  };
}

/**
 * A spawner that behaves like ffmpeg: it writes an init segment and one media segment into
 * the working directory it was given, then exits.
 *
 * `manual` withholds the exit so a test can hold a production open, and `exitCode` makes it
 * fail without writing -- the two states the publish path has to tell apart.
 */
function fakeFfmpeg(opts: { manual?: boolean; exitCode?: number; cpuMs?: number | null } = {}) {
  const spawned: string[][] = [];
  const killed: { signal: number | undefined }[] = [];
  const finish: (() => void)[] = [];
  const spawn: Spawner = (argv) => {
    spawned.push(argv);
    let signalled = false;
    const complete = () => {
      // A killed ffmpeg writes nothing and exits non-zero, and so does a failing one.
      const code = signalled ? 143 : (opts.exitCode ?? 0);
      if (code !== 0) return code;
      const { work, media, index } = outputOf(argv);
      writeFileSync(join(work, RUN_INIT_NAME), `init for ${media}`);
      writeFileSync(join(work, media), `media for ${index}`);
      return code;
    };
    const exited = opts.manual
      ? new Promise<number>((resolve) => {
          finish.push(() => resolve(complete()));
        })
      : Promise.resolve().then(complete);
    return {
      kill: (signal) => {
        signalled = true;
        killed.push({ signal });
      },
      exited,
      // Present only when a test says what this run cost. A spawner WITHOUT it is the real
      // case for a runtime that cannot account for its children, and the manager has to
      // report nothing rather than zero -- see `charge`.
      ...(opts.cpuMs === undefined ? {} : { cpuMillis: () => opts.cpuMs ?? null }),
    };
  };
  return { spawn, spawned, killed, finish };
}

let root: string;
let clock: number;
const now = () => clock;

beforeEach(() => {
  root = mkdtempSync(`${tmpdir()}/finderr-sessions-`);
  clock = 1_000_000;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const mgr = (spawn: Spawner, onRun?: (run: SegmentRun) => void) =>
  new TranscodeSessions({ root, spawn, now, ffmpegPath: "ffmpeg", onRun });
const opts = (over: Partial<Parameters<TranscodeSessions["start"]>[0]> = {}) => ({
  input: "/plex/a.mkv",
  plan: CHEAP,
  tracks: TRACKS,
  ...over,
});

describe("starting a session", () => {
  /**
   * A session is a DECISION, not a process. Nothing is encoded until a player asks for a
   * segment, which is what stops a viewer who presses play and leaves from buying a film.
   */
  test("costs a directory and a slot, and starts no ffmpeg at all", () => {
    const f = fakeFfmpeg();
    const s = mgr(f.spawn).start(opts());

    expect(f.spawned).toHaveLength(0);
    expect(existsSync(s.dir)).toBe(true);
    expect(s.tracks).toBe(TRACKS);
  });

  /**
   * THE JOIN. Two sessions over one output directory would have two ffmpegs racing to write
   * the same segment file, so this is a correctness property rather than an efficiency one.
   */
  test("a second identical request joins the session rather than making another", () => {
    const m = mgr(fakeFfmpeg().spawn);
    const a = m.start(opts());
    const b = m.start(opts());

    expect(b.id).toBe(a.id);
    expect(b.dir).toBe(a.dir);
    expect(m.list()).toHaveLength(1);
  });

  test("joining counts as being wanted, so a busy session is never reaped under a viewer", () => {
    const m = mgr(fakeFfmpeg().spawn);
    const a = m.start(opts());

    clock += IDLE_REAP_MS - 1;
    m.start(opts());
    clock += IDLE_REAP_MS - 1;

    expect(m.reap()).toBe(0);
    expect(m.get(a.id)).not.toBeNull();
  });

  test("a different plan for the same file is a different session", () => {
    const m = mgr(fakeFfmpeg().spawn);
    m.start(opts());
    m.start(opts({ plan: EXPENSIVE }));
    expect(m.list()).toHaveLength(2);
  });

  /**
   * THE POSITION IS NOT PART OF THE KEY ANY MORE, and that absence is the whole change: a
   * session used to BE a position, so two viewers at different points in one film paid for
   * two ffmpegs. A session is now the whole film, and they share every segment either of
   * them causes to be produced.
   */
  test("the key names what changes a segment's CONTENT, and nothing about position", () => {
    const base = opts();
    expect(sessionKey(base)).toBe(sessionKey({ ...base }));
    expect(sessionKey(base)).not.toBe(sessionKey({ ...base, input: "/plex/b.mkv" }));
    expect(sessionKey(base)).not.toBe(sessionKey({ ...base, plan: EXPENSIVE }));
  });

  /**
   * EVERY rendition is in the key, not just the one being watched. Two browsers with different
   * codec support get different per-track answers on the same file -- Safari copies an eac3
   * alternate that Chrome must re-encode -- and a key naming only the first would join them
   * onto ONE output directory, where the second viewer is served the first's audio.
   */
  test("a plan that differs only in an ALTERNATE rendition is a different session", () => {
    const base = opts();
    expect(sessionKey(base)).not.toBe(sessionKey({ ...base, plan: DUBBED }));
  });
});

/**
 * THE STREAM TOKEN. It is the one playback credential that travels over plain http -- minted
 * in a reply from the app's own origin, spent against whichever candidate answered -- so its
 * whole design is "worth little if observed": one session, half an hour, and a renewal only
 * the app's origin can perform.
 */
describe("the stream token", () => {
  test("is not the session id, so printing an id never leaks the right to stream it", () => {
    const s = mgr(fakeFfmpeg().spawn).start(opts());
    expect(s.token).not.toBe(s.id);
    expect(s.token.length).toBeGreaterThan(20);
  });

  test("two sessions get different tokens", () => {
    const m = mgr(fakeFfmpeg().spawn);
    expect(m.start(opts()).token).not.toBe(m.start(opts({ plan: EXPENSIVE })).token);
  });

  test("admits its own session and nothing else", () => {
    const m = mgr(fakeFfmpeg().spawn);
    const a = m.start(opts());
    const b = m.start(opts({ plan: EXPENSIVE }));

    expect(m.admitsToken(a.id, a.token)).toBe(true);
    expect(m.admitsToken(b.id, a.token)).toBe(false);
    expect(m.admitsToken(a.id, "guessed")).toBe(false);
    expect(m.admitsToken("no-such-session", a.token)).toBe(false);
  });

  test("stops being accepted once its window has passed", () => {
    const m = mgr(fakeFfmpeg().spawn);
    const s = m.start(opts());

    clock += STREAM_TOKEN_TTL_MS - 1;
    expect(m.admitsToken(s.id, s.token)).toBe(true);
    clock += 2;
    expect(m.admitsToken(s.id, s.token)).toBe(false);
  });

  /**
   * A RE-MINT MUST NOT STALL THE PLAYER. Several segment requests are always in flight
   * carrying the value that was current when they were issued, so cutting the old token dead
   * at the swap would fail all of them -- which the loader reads as a dead path and answers by
   * rotating endpoints, for a fault that was never about the network.
   */
  test("the previous token keeps working for the grace window, then does not", () => {
    const m = mgr(fakeFfmpeg().spawn);
    const s = m.start(opts());
    const before = s.token;

    const after = m.remintToken(s.id)?.token;
    expect(after).not.toBe(before);
    expect(m.admitsToken(s.id, after ?? "")).toBe(true);
    expect(m.admitsToken(s.id, before)).toBe(true);

    clock += TOKEN_GRACE_MS + 1;
    expect(m.admitsToken(s.id, before)).toBe(false);
    expect(m.admitsToken(s.id, after ?? "")).toBe(true);
  });

  /** Renewal is what makes the short window survivable across a feature film. */
  test("a re-mint gives a full fresh window", () => {
    const m = mgr(fakeFfmpeg().spawn);
    const s = m.start(opts());

    clock += STREAM_TOKEN_TTL_MS - 1;
    const renewed = m.remintToken(s.id);
    expect(renewed?.tokenExpiresAt).toBe(clock + STREAM_TOKEN_TTL_MS);
  });

  test("re-minting a session that is gone answers null rather than inventing one", () => {
    expect(mgr(fakeFfmpeg().spawn).remintToken("no-such-session")).toBeNull();
  });

  /** The token dies with the session, so an abandoned playback's credential dies with it. */
  test("a reaped session admits its token no longer", () => {
    const m = mgr(fakeFfmpeg().spawn);
    const s = m.start(opts());

    clock += IDLE_REAP_MS + 1;
    m.reap();
    expect(m.admitsToken(s.id, s.token)).toBe(false);
  });
});

describe("producing a segment on demand", () => {
  test("asking for a segment runs ffmpeg for exactly that segment and publishes it", async () => {
    const f = fakeFfmpeg();
    const m = mgr(f.spawn);
    const s = m.start(opts());

    const path = await m.segmentPath(s.id, VIDEO, 12);

    expect(path).toBe(join(s.dir, segmentFileName(VIDEO, 12)));
    expect(existsSync(path as string)).toBe(true);
    expect(f.spawned).toHaveLength(1);
    // The range comes from the VIDEO timeline, so the segment covers 72.072s..78.078s of the
    // film. The seek and the read both carry playback-plan's offsets; what matters here is
    // that the SESSION handed the right rendition's range down.
    expect(f.spawned[0]?.join(" ")).toContain("-ss 72.272000");
    expect(f.spawned[0]?.join(" ")).toContain("-hls_time 6.006000");
  });

  /**
   * THE TWO RENDITIONS ARE CUT ON THEIR OWN GRIDS, and handing one the other's range is
   * exactly the mix-up that would put the boundaries back on top of each other.
   */
  test("an audio segment is cut on the audio grid, not the video one", async () => {
    const f = fakeFfmpeg();
    const m = mgr(f.spawn);
    const s = m.start(opts());

    const path = await m.segmentPath(s.id, AUDIO, 12);

    expect(path).toBe(join(s.dir, segmentFileName(AUDIO, 12)));
    expect(f.spawned[0]?.join(" ")).toContain("-ss 72.000000");
    expect(f.spawned[0]?.join(" ")).toContain("-to 78.000000");
  });

  /** Both renditions land in one directory, so each must publish under its own names. */
  test("the two renditions never write over each other", async () => {
    const m = mgr(fakeFfmpeg().spawn);
    const s = m.start(opts());

    await m.segmentPath(s.id, VIDEO, 4);
    await m.segmentPath(s.id, AUDIO, 4);

    expect(await Bun.file(join(s.dir, initName(VIDEO))).text()).toBe(`init for ${segmentFileName(VIDEO, 4)}`);
    expect(await Bun.file(join(s.dir, initName(AUDIO))).text()).toBe(`init for ${segmentFileName(AUDIO, 4)}`);
  });

  /**
   * TWO RENDITIONS OF ONE KIND SHARE THE DIRECTORY TOO, and this is the case the ordinal was
   * added for: the second audio track publishing over the first would serve a viewer who chose
   * Japanese the English bytes, under the right file name, with nothing anywhere reporting it.
   */
  test("two renditions of the SAME kind never write over each other", async () => {
    const f = fakeFfmpeg();
    const m = mgr(f.spawn);
    const s = m.start(
      opts({ plan: DUBBED, tracks: [...TRACKS, { track: AUDIO_2, timeline: AUDIO_TIMELINE, label }] }),
    );

    await m.segmentPath(s.id, AUDIO, 4);
    await m.segmentPath(s.id, AUDIO_2, 4);

    expect(await Bun.file(join(s.dir, segmentFileName(AUDIO, 4))).text()).toBe("media for 4");
    expect(await Bun.file(join(s.dir, segmentFileName(AUDIO_2, 4))).text()).toBe("media for 4");
    // Each run carried its own source stream, which is the half a shared name would hide.
    expect(f.spawned[0]?.join(" ")).toContain("-map 0:1");
    expect(f.spawned[1]?.join(" ")).toContain("-map 0:2");
  });

  /** Its own ceiling, or selecting an alternate would eat the default's back-pressure budget. */
  test("each rendition of a kind has its own concurrency slots", async () => {
    const f = fakeFfmpeg({ manual: true });
    const m = mgr(f.spawn);
    const s = m.start(
      opts({ plan: DUBBED, tracks: [...TRACKS, { track: AUDIO_2, timeline: AUDIO_TIMELINE, label }] }),
    );

    const held = [];
    for (let i = 0; i < SEGMENT_CONCURRENCY; i++) held.push(m.segmentPath(s.id, AUDIO, i));
    held.push(m.segmentPath(s.id, AUDIO_2, 0));

    expect(f.spawned).toHaveLength(SEGMENT_CONCURRENCY + 1);
    for (const done of f.finish) done();
    for (const path of await Promise.all(held)) expect(path).not.toBeNull();
  });

  /** A rendition this title does not publish has no segments, and asking costs no ffmpeg. */
  test("a track the session has no timeline for is null rather than an ffmpeg run", async () => {
    const f = fakeFfmpeg();
    const m = mgr(f.spawn);
    const s = m.start(opts({ tracks: TRACKS.slice(0, 1) }));

    expect(await m.segmentPath(s.id, AUDIO, 0)).toBeNull();
    expect(await m.initPath(s.id, AUDIO)).toBeNull();
    expect(f.spawned).toHaveLength(0);
  });

  /** Producing it twice would cost a second ffmpeg for bytes already on disk. */
  test("a segment already produced is served without running ffmpeg again", async () => {
    const f = fakeFfmpeg();
    const m = mgr(f.spawn);
    const s = m.start(opts());

    await m.segmentPath(s.id, VIDEO, 3);
    await m.segmentPath(s.id, VIDEO, 3);

    expect(f.spawned).toHaveLength(1);
  });

  /**
   * Two ffmpegs writing one segment file would hand a player half of each, so the dedupe is
   * correctness. The case is real: a player retries a slow fragment while the first request
   * is still producing it.
   */
  test("two requests for the same segment share one production", async () => {
    const f = fakeFfmpeg({ manual: true });
    const m = mgr(f.spawn);
    const s = m.start(opts());

    const both = Promise.all([m.segmentPath(s.id, VIDEO, 5), m.segmentPath(s.id, VIDEO, 5)]);
    expect(f.spawned).toHaveLength(1);
    f.finish[0]?.();
    const [a, b] = await both;
    expect(a).toBe(b);
  });

  /**
   * BACK-PRESSURE, and the case is the one the card named: a viewer dragging the scrubber
   * emits a seek per pointer move, and without a ceiling each one would spawn an ffmpeg for a
   * position the viewer has already left.
   */
  test("a session will not produce more than SEGMENT_CONCURRENCY segments at once", async () => {
    const f = fakeFfmpeg({ manual: true });
    const m = mgr(f.spawn);
    const s = m.start(opts());

    const held = [];
    for (let i = 0; i < SEGMENT_CONCURRENCY; i++) held.push(m.segmentPath(s.id, VIDEO, i));
    const refused = await m.segmentPath(s.id, VIDEO, SEGMENT_CONCURRENCY);

    expect(refused).toBeNull();
    expect(f.spawned).toHaveLength(SEGMENT_CONCURRENCY);
    for (const done of f.finish) done();
    await Promise.all(held);
  });

  /**
   * THE CEILING IS PER RENDITION, and it has to be: a player fetches video and audio in
   * parallel, so one shared ceiling of two would be filled by the first segment of each and
   * the very next request -- the one made before the first frame -- would be refused.
   */
  test("filling one rendition's concurrency does not refuse the other's", async () => {
    const f = fakeFfmpeg({ manual: true });
    const m = mgr(f.spawn);
    const s = m.start(opts());

    const held = [];
    for (let i = 0; i < SEGMENT_CONCURRENCY; i++) held.push(m.segmentPath(s.id, VIDEO, i));
    held.push(m.segmentPath(s.id, AUDIO, 0));

    expect(f.spawned).toHaveLength(SEGMENT_CONCURRENCY + 1);
    for (const done of f.finish) done();
    for (const path of await Promise.all(held)) expect(path).not.toBeNull();
  });

  /** Once a production settles its slot comes back, or the session would seize after two. */
  test("a finished production frees its concurrency slot", async () => {
    const f = fakeFfmpeg();
    const m = mgr(f.spawn);
    const s = m.start(opts());

    for (let i = 0; i < SEGMENT_CONCURRENCY + 2; i++) {
      expect(await m.segmentPath(s.id, VIDEO, i)).not.toBeNull();
    }
  });

  test("a segment the timeline does not have is null rather than an ffmpeg run", async () => {
    const f = fakeFfmpeg();
    const m = mgr(f.spawn);
    const s = m.start(opts());

    expect(await m.segmentPath(s.id, VIDEO, 999)).toBeNull();
    expect(await m.segmentPath(s.id, VIDEO, -1)).toBeNull();
    expect(f.spawned).toHaveLength(0);
  });

  test("a session that no longer exists yields null rather than throwing", async () => {
    const m = mgr(fakeFfmpeg().spawn);
    expect(await m.segmentPath("nope", VIDEO, 0)).toBeNull();
    expect(await m.initPath("nope", VIDEO)).toBeNull();
  });

  /**
   * ffmpeg failing must publish NOTHING. Renaming a partial file into place would hand the
   * player a truncated fragment, which is a decode error rather than a retryable 404.
   */
  test("a failed run publishes nothing and leaves no working directory behind", async () => {
    const f = fakeFfmpeg({ exitCode: 1 });
    const m = mgr(f.spawn);
    const s = m.start(opts());

    expect(await m.segmentPath(s.id, VIDEO, 4)).toBeNull();
    expect(existsSync(join(s.dir, segmentFileName(VIDEO, 4)))).toBe(false);
    expect(readdirSync(s.dir)).toHaveLength(0);
  });

  /**
   * ONE INIT FOR THE RENDITION, written by whichever run got there first and never rewritten.
   * Every run produces a byte-identical one since the placement moved into each fragment's
   * `tfdt` -- so the second run has nothing to add, and a rename underneath a player that is
   * reading the file would be a risk taken for no gain.
   */
  test("a rendition publishes exactly one init, from the first run that made one", async () => {
    const m = mgr(fakeFfmpeg().spawn);
    const s = m.start(opts());

    await m.segmentPath(s.id, VIDEO, 2);
    await m.segmentPath(s.id, VIDEO, 9);

    expect(readdirSync(s.dir).filter((n) => n.startsWith("vinit"))).toEqual([initName(VIDEO)]);
    expect(await Bun.file(join(s.dir, initName(VIDEO))).text()).toBe(`init for ${segmentFileName(VIDEO, 2)}`);
  });

  /**
   * A player asks for the init immediately before the first media segment, so the pair must
   * cost ONE transcode of those six seconds rather than two.
   */
  test("the init and the first segment come out of a single run", async () => {
    const f = fakeFfmpeg();
    const m = mgr(f.spawn);
    const s = m.start(opts());

    expect(await m.initPath(s.id, VIDEO)).toBe(join(s.dir, initName(VIDEO)));
    expect(await m.segmentPath(s.id, VIDEO, 0)).toBe(join(s.dir, segmentFileName(VIDEO, 0)));
    expect(f.spawned).toHaveLength(1);
    expect(f.spawned[0]?.join(" ")).toContain("-start_number 0");
  });

  /**
   * THE POINT OF ONE SHARED INIT: a viewer who seeks into the middle of a film asks for the
   * init named by the playlist and gets the one the segment they are watching already wrote.
   * A per-segment init would have made this a second ffmpeg for a position nobody is at.
   */
  test("an init asked for after any segment costs no further run", async () => {
    const f = fakeFfmpeg();
    const m = mgr(f.spawn);
    const s = m.start(opts());

    await m.segmentPath(s.id, VIDEO, 42);

    expect(await m.initPath(s.id, VIDEO)).toBe(join(s.dir, initName(VIDEO)));
    expect(f.spawned).toHaveLength(1);
  });

  /**
   * A full watch-through would otherwise leave the whole remuxed film in the data directory.
   * Re-producing an evicted segment costs the measured 0.08 s, so a rewind past the window is
   * cheap rather than broken.
   */
  test("only the most recent SEGMENT_CACHE segments stay on disk", async () => {
    const m = mgr(fakeFfmpeg().spawn);
    const s = m.start(opts());

    for (let i = 0; i < SEGMENT_CACHE + 3; i++) await m.segmentPath(s.id, VIDEO, i);

    for (const gone of [0, 2]) {
      expect(existsSync(join(s.dir, segmentFileName(VIDEO, gone)))).toBe(false);
    }
    for (const kept of [3, SEGMENT_CACHE + 2]) {
      expect(existsSync(join(s.dir, segmentFileName(VIDEO, kept)))).toBe(true);
    }
    // THE INIT IS NOT EVICTABLE. The playlist names it once for the whole film, so dropping it
    // with the segment that happened to produce it would 404 every fragment after that.
    expect(existsSync(join(s.dir, initName(VIDEO)))).toBe(true);
  });

  test("reading a segment counts as being wanted", async () => {
    const m = mgr(fakeFfmpeg().spawn);
    const s = m.start(opts());

    clock += IDLE_REAP_MS - 1;
    await m.segmentPath(s.id, VIDEO, 1);
    clock += IDLE_REAP_MS - 1;

    expect(m.reap()).toBe(0);
  });
});

describe("the two budgets", () => {
  /**
   * One number would either strangle the cheap case or admit enough of the expensive one to
   * take a Celeron down, which is why there are two.
   */
  test("expensive sessions are capped well below the total", () => {
    const m = mgr(fakeFfmpeg().spawn);
    for (let i = 0; i < EXPENSIVE_SESSIONS; i++) {
      m.start(opts({ input: `/plex/e${i}.mkv`, plan: EXPENSIVE }));
    }
    expect(() => m.start(opts({ input: "/plex/one-too-many.mkv", plan: EXPENSIVE }))).toThrow(SessionRefused);
  });

  test("a cheap session is still admitted when the expensive budget is full", () => {
    const m = mgr(fakeFfmpeg().spawn);
    for (let i = 0; i < EXPENSIVE_SESSIONS; i++) {
      m.start(opts({ input: `/plex/e${i}.mkv`, plan: EXPENSIVE }));
    }
    expect(() => m.start(opts({ input: "/plex/cheap.mkv" }))).not.toThrow();
  });

  test("the total is capped too", () => {
    const m = mgr(fakeFfmpeg().spawn);
    for (let i = 0; i < MAX_SESSIONS; i++) m.start(opts({ input: `/plex/c${i}.mkv` }));
    expect(() => m.start(opts({ input: "/plex/over.mkv" }))).toThrow(SessionRefused);
  });

  /** Refusing rather than queueing: a queued playback is a person watching a spinner. */
  test("the refusal names which budget it was", () => {
    const m = mgr(fakeFfmpeg().spawn);
    for (let i = 0; i < EXPENSIVE_SESSIONS; i++) {
      m.start(opts({ input: `/plex/e${i}.mkv`, plan: EXPENSIVE }));
    }
    try {
      m.start(opts({ input: "/plex/x.mkv", plan: EXPENSIVE }));
      throw new Error("should have refused");
    } catch (err) {
      expect(err).toBeInstanceOf(SessionRefused);
      expect((err as SessionRefused).reason).toBe("too-many-expensive");
    }
  });

  /**
   * The manager reports both limits itself so nothing else has to count them. A surface that
   * derived "2 of 3 expensive" from a session list plus its own copy of the constants would be
   * a second reading of the rule that decides whether a viewer is refused.
   */
  test("it reports what is spent against each limit", () => {
    const m = mgr(fakeFfmpeg().spawn);
    expect(m.budgets()).toEqual({
      sessions: { used: 0, max: MAX_SESSIONS },
      expensive: { used: 0, max: EXPENSIVE_SESSIONS },
    });

    m.start(opts({ input: "/plex/cheap.mkv" }));
    m.start(opts({ input: "/plex/hot.mkv", plan: EXPENSIVE }));

    expect(m.budgets()).toEqual({
      sessions: { used: 2, max: MAX_SESSIONS },
      expensive: { used: 1, max: EXPENSIVE_SESSIONS },
    });
  });

  /** An abandoned session must never keep a live viewer out. */
  test("start reaps before it refuses", () => {
    const m = mgr(fakeFfmpeg().spawn);
    for (let i = 0; i < MAX_SESSIONS; i++) m.start(opts({ input: `/plex/c${i}.mkv` }));

    clock += IDLE_REAP_MS + 1;
    expect(() => m.start(opts({ input: "/plex/fresh.mkv" }))).not.toThrow();
    expect(m.list()).toHaveLength(1);
  });
});

describe("ending a session", () => {
  test("stop removes the session and its directory", () => {
    const m = mgr(fakeFfmpeg().spawn);
    const s = m.start(opts());
    const dir = s.dir;

    m.stop(s.id);

    expect(m.get(s.id)).toBeNull();
    expect(existsSync(dir)).toBe(false);
  });

  /**
   * A segment run is short, which NARROWS the orphan window rather than closing it: a 4K
   * re-encode of one segment is still seconds of a Celeron, and a child outlives its parent.
   */
  test("stop signals whatever the session is running", async () => {
    const f = fakeFfmpeg({ manual: true });
    const m = mgr(f.spawn);
    const s = m.start(opts());

    const pending = m.segmentPath(s.id, VIDEO, 1);
    m.stop(s.id);

    expect(f.killed[0]?.signal).toBe(15);
    f.finish[0]?.();
    expect(await pending).toBeNull();
  });

  test("stopping twice is harmless", () => {
    const m = mgr(fakeFfmpeg().spawn);
    const s = m.start(opts());
    m.stop(s.id);
    expect(() => m.stop(s.id)).not.toThrow();
  });

  test("an idle session is reaped", () => {
    const m = mgr(fakeFfmpeg().spawn);
    const s = m.start(opts());

    clock += IDLE_REAP_MS - 1;
    expect(m.reap()).toBe(0);

    clock += 2;
    expect(m.reap()).toBe(1);
    expect(m.get(s.id)).toBeNull();
  });

  test("touch keeps a session alive", () => {
    const m = mgr(fakeFfmpeg().spawn);
    const s = m.start(opts());

    for (let i = 0; i < 5; i++) {
      clock += IDLE_REAP_MS - 1;
      expect(m.touch(s.id)).not.toBeNull();
      expect(m.reap()).toBe(0);
    }
    expect(m.get(s.id)).not.toBeNull();
  });

  /**
   * A client polling forever looks exactly like a healthy viewer, so the idle reaper alone
   * cannot bound the table. This is what makes it finite under ANY client behaviour.
   */
  test("the hard TTL kills a session that is being touched forever", () => {
    const m = mgr(fakeFfmpeg().spawn);
    const s = m.start(opts());

    while (clock - s.startedAt < HARD_TTL_MS) {
      clock += IDLE_REAP_MS / 2;
      m.touch(s.id);
      m.reap();
    }
    m.reap();
    expect(m.get(s.id)).toBeNull();
  });

  test("touching a session that no longer exists is null, not a throw", () => {
    const m = mgr(fakeFfmpeg().spawn);
    expect(m.touch("nope")).toBeNull();
  });

  /**
   * THE ORPHAN CASE. A child outlives its parent, so a process that exits without stopping
   * its sessions leaves every ffmpeg running at whatever CPU it was using. Observed on the
   * dev server 2026-09-08: an orphan from a restart three edits earlier was still at 344%.
   */
  test("stopAll signals every running ffmpeg", async () => {
    const f = fakeFfmpeg({ manual: true });
    const m = mgr(f.spawn);
    const a = m.start(opts({ input: "/plex/a.mkv" }));
    const b = m.start(opts({ input: "/plex/b.mkv" }));
    const pending = [m.segmentPath(a.id, VIDEO, 0), m.segmentPath(b.id, VIDEO, 0)];

    m.stopAll();

    expect(m.list()).toHaveLength(0);
    expect(f.killed.filter((k) => k.signal === 15)).toHaveLength(2);
    for (const done of f.finish) done();
    await Promise.all(pending);
  });

  /** The other half of the orphan problem: what a SIGKILL leaves on disk. */
  test("sweepStale removes session directories from a previous life", () => {
    const m = mgr(fakeFfmpeg().spawn);
    const a = m.start(opts({ input: "/plex/a.mkv" }));
    const b = m.start(opts({ input: "/plex/b.mkv" }));
    expect(existsSync(a.dir)).toBe(true);

    // A fresh manager over the same root is exactly what a restarted process sees.
    const reborn = mgr(fakeFfmpeg().spawn);
    expect(reborn.sweepStale()).toBe(2);
    expect(existsSync(a.dir)).toBe(false);
    expect(existsSync(b.dir)).toBe(false);
  });

  test("sweeping an empty or missing root is not an error", () => {
    const m = new TranscodeSessions({ root: `${root}/never-created`, spawn: fakeFfmpeg().spawn, now });
    expect(m.sweepStale()).toBe(0);
  });

  /** A stopped session's key must be free, or that file can never be played again. */
  test("a stopped session's key is released so the same file can start again", () => {
    const m = mgr(fakeFfmpeg().spawn);
    const a = m.start(opts());
    m.stop(a.id);
    const b = m.start(opts());
    expect(b.id).not.toBe(a.id);
  });
});

/**
 * What each finished ffmpeg cost, handed to whoever is keeping the books.
 *
 * The manager does not keep this itself -- see `ManagerOpts.onRun`. What is pinned here is that
 * it reports the CHILD's number, reports it for runs that failed as well as runs that worked,
 * and says NOTHING at all rather than zero when the spawner cannot account for its children.
 */
describe("reporting what a run cost", () => {
  test("a finished run reports its child's CPU against its session", async () => {
    const runs: SegmentRun[] = [];
    const m = mgr(fakeFfmpeg({ cpuMs: 137 }).spawn, (r) => runs.push(r));
    const s = m.start(opts());
    await m.segmentPath(s.id, VIDEO, 0);

    expect(runs).toEqual([{ sessionId: s.id, cpuMs: 137 }]);
  });

  /**
   * A run that was killed on the timeout, or that died on a bad input, still burned the CPU it
   * burned -- and those are exactly the runs an operator most wants to see in the graph.
   */
  test("a FAILED run still reports what it cost", async () => {
    const runs: SegmentRun[] = [];
    const m = mgr(fakeFfmpeg({ exitCode: 1, cpuMs: 91 }).spawn, (r) => runs.push(r));
    const s = m.start(opts());
    expect(await m.segmentPath(s.id, VIDEO, 0)).toBeNull();

    expect(runs).toEqual([{ sessionId: s.id, cpuMs: 91 }]);
  });

  /**
   * NOTHING, not zero. A spawner that cannot account for its children is a spawner whose CPU
   * is UNKNOWN, and recording a zero would draw a flat line that reads as "transcoding is
   * free" on a box that is pinned.
   */
  test("a spawner that cannot account for its children reports nothing", async () => {
    const runs: SegmentRun[] = [];
    const m = mgr(fakeFfmpeg().spawn, (r) => runs.push(r));
    const s = m.start(opts());
    await m.segmentPath(s.id, VIDEO, 0);

    expect(runs).toEqual([]);
  });

  test("a spawner that answers null reports nothing either", async () => {
    const runs: SegmentRun[] = [];
    const m = mgr(fakeFfmpeg({ cpuMs: null }).spawn, (r) => runs.push(r));
    const s = m.start(opts());
    await m.segmentPath(s.id, VIDEO, 0);

    expect(runs).toEqual([]);
  });

  /** Instrumentation that can break the thing it measures is worse than no instrumentation. */
  test("a listener that throws does not fail the segment", async () => {
    const m = mgr(fakeFfmpeg({ cpuMs: 5 }).spawn, () => {
      throw new Error("the books are on fire");
    });
    const s = m.start(opts());

    expect(await m.segmentPath(s.id, VIDEO, 0)).not.toBeNull();
  });
});
