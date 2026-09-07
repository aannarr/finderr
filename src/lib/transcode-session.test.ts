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
import { dirname, join } from "node:path";
import { INIT_FILE_NAME, segmentFileName, type Timeline } from "./hls-timeline";
import type { PlaybackPlan } from "./playback-plan";
import {
  EXPENSIVE_SESSIONS,
  HARD_TTL_MS,
  IDLE_REAP_MS,
  MAX_SESSIONS,
  SEGMENT_CACHE,
  SEGMENT_CONCURRENCY,
  SessionRefused,
  type Spawner,
  sessionKey,
  TranscodeSessions,
} from "./transcode-session";

const CHEAP: PlaybackPlan = {
  video: { action: "copy", sourceIndex: 0, codec: "h264" },
  audio: { action: "transcode", sourceIndex: 1, codec: "aac" },
  subtitles: { action: "none", sourceIndex: null },
  reasons: [],
};

const EXPENSIVE: PlaybackPlan = {
  video: { action: "transcode", sourceIndex: 0, codec: "h264" },
  audio: { action: "transcode", sourceIndex: 1, codec: "aac" },
  subtitles: { action: "none", sourceIndex: null },
  reasons: [],
};

/** Sixty six-second segments: long enough that eviction and out-of-range both have room. */
const TIMELINE: Timeline = {
  starts: Array.from({ length: 60 }, (_, i) => i * 6),
  endSec: 360,
};

/** What a run of the fake ffmpeg is told to write, read back out of its own argv. */
function outputOf(argv: string[]): { work: string; index: number } {
  const pattern = argv[argv.indexOf("-hls_segment_filename") + 1] ?? "";
  return { work: dirname(pattern), index: Number(argv[argv.indexOf("-start_number") + 1]) };
}

/**
 * A spawner that behaves like ffmpeg: it writes an init segment and one media segment into
 * the working directory it was given, then exits.
 *
 * `manual` withholds the exit so a test can hold a production open, and `exitCode` makes it
 * fail without writing -- the two states the publish path has to tell apart.
 */
function fakeFfmpeg(opts: { manual?: boolean; exitCode?: number } = {}) {
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
      const { work, index } = outputOf(argv);
      writeFileSync(join(work, INIT_FILE_NAME), `init for ${index}`);
      writeFileSync(join(work, segmentFileName(index)), `media for ${index}`);
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

const mgr = (spawn: Spawner) => new TranscodeSessions({ root, spawn, now, ffmpegPath: "ffmpeg" });
const opts = (over: Partial<Parameters<TranscodeSessions["start"]>[0]> = {}) => ({
  input: "/plex/a.mkv",
  plan: CHEAP,
  timeline: TIMELINE,
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
    expect(s.timeline).toBe(TIMELINE);
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
});

describe("producing a segment on demand", () => {
  test("asking for a segment runs ffmpeg for exactly that segment and publishes it", async () => {
    const f = fakeFfmpeg();
    const m = mgr(f.spawn);
    const s = m.start(opts());

    const path = await m.segmentPath(s.id, 12);

    expect(path).toBe(join(s.dir, segmentFileName(12)));
    expect(existsSync(path as string)).toBe(true);
    expect(f.spawned).toHaveLength(1);
    // The range comes from the timeline, so the segment covers 72s..78s of the film.
    expect(f.spawned[0]?.join(" ")).toContain("-ss 72.000000");
    expect(f.spawned[0]?.join(" ")).toContain("-to 78.000000");
  });

  /** Producing it twice would cost a second ffmpeg for bytes already on disk. */
  test("a segment already produced is served without running ffmpeg again", async () => {
    const f = fakeFfmpeg();
    const m = mgr(f.spawn);
    const s = m.start(opts());

    await m.segmentPath(s.id, 3);
    await m.segmentPath(s.id, 3);

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

    const both = Promise.all([m.segmentPath(s.id, 5), m.segmentPath(s.id, 5)]);
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
    for (let i = 0; i < SEGMENT_CONCURRENCY; i++) held.push(m.segmentPath(s.id, i));
    const refused = await m.segmentPath(s.id, SEGMENT_CONCURRENCY);

    expect(refused).toBeNull();
    expect(f.spawned).toHaveLength(SEGMENT_CONCURRENCY);
    for (const done of f.finish) done();
    await Promise.all(held);
  });

  /** Once a production settles its slot comes back, or the session would seize after two. */
  test("a finished production frees its concurrency slot", async () => {
    const f = fakeFfmpeg();
    const m = mgr(f.spawn);
    const s = m.start(opts());

    for (let i = 0; i < SEGMENT_CONCURRENCY + 2; i++) {
      expect(await m.segmentPath(s.id, i)).not.toBeNull();
    }
  });

  test("a segment the timeline does not have is null rather than an ffmpeg run", async () => {
    const f = fakeFfmpeg();
    const m = mgr(f.spawn);
    const s = m.start(opts());

    expect(await m.segmentPath(s.id, 999)).toBeNull();
    expect(await m.segmentPath(s.id, -1)).toBeNull();
    expect(f.spawned).toHaveLength(0);
  });

  test("a session that no longer exists yields null rather than throwing", async () => {
    const m = mgr(fakeFfmpeg().spawn);
    expect(await m.segmentPath("nope", 0)).toBeNull();
    expect(await m.initPath("nope")).toBeNull();
  });

  /**
   * ffmpeg failing must publish NOTHING. Renaming a partial file into place would hand the
   * player a truncated fragment, which is a decode error rather than a retryable 404.
   */
  test("a failed run publishes nothing and leaves no working directory behind", async () => {
    const f = fakeFfmpeg({ exitCode: 1 });
    const m = mgr(f.spawn);
    const s = m.start(opts());

    expect(await m.segmentPath(s.id, 4)).toBeNull();
    expect(existsSync(join(s.dir, segmentFileName(4)))).toBe(false);
    expect(readdirSync(s.dir)).toHaveLength(0);
  });

  /**
   * ONE init for the whole film. Every run writes its own, and they differ only in duration
   * fields -- measured across two seek offsets 2026-09-08 -- so the first one is kept and a
   * player never sees the initialisation section change under it.
   */
  test("the first init segment produced is the one that is kept", async () => {
    const f = fakeFfmpeg();
    const m = mgr(f.spawn);
    const s = m.start(opts());

    await m.segmentPath(s.id, 2);
    await m.segmentPath(s.id, 9);

    expect(await Bun.file(join(s.dir, INIT_FILE_NAME)).text()).toBe("init for 2");
  });

  /** A player asks for the init before any media, so a cold session must be able to make it. */
  test("asking for the init on a cold session produces the first segment to get it", async () => {
    const f = fakeFfmpeg();
    const m = mgr(f.spawn);
    const s = m.start(opts());

    expect(await m.initPath(s.id)).toBe(join(s.dir, INIT_FILE_NAME));
    expect(f.spawned[0]?.join(" ")).toContain("-start_number 0");
  });

  /**
   * A full watch-through would otherwise leave the whole remuxed film in the data directory.
   * Re-producing an evicted segment costs the measured 0.08 s, so a rewind past the window is
   * cheap rather than broken.
   */
  test("only the most recent SEGMENT_CACHE segments stay on disk", async () => {
    const m = mgr(fakeFfmpeg().spawn);
    const s = m.start(opts());

    for (let i = 0; i < SEGMENT_CACHE + 3; i++) await m.segmentPath(s.id, i);

    expect(existsSync(join(s.dir, segmentFileName(0)))).toBe(false);
    expect(existsSync(join(s.dir, segmentFileName(2)))).toBe(false);
    expect(existsSync(join(s.dir, segmentFileName(3)))).toBe(true);
    expect(existsSync(join(s.dir, segmentFileName(SEGMENT_CACHE + 2)))).toBe(true);
    // The init is not a segment and eviction must never take it.
    expect(existsSync(join(s.dir, INIT_FILE_NAME))).toBe(true);
  });

  test("reading a segment counts as being wanted", async () => {
    const m = mgr(fakeFfmpeg().spawn);
    const s = m.start(opts());

    clock += IDLE_REAP_MS - 1;
    await m.segmentPath(s.id, 1);
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

    const pending = m.segmentPath(s.id, 1);
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
    const pending = [m.segmentPath(a.id, 0), m.segmentPath(b.id, 0)];

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
