/**
 * The session manager, against a fake spawner and a fake clock.
 *
 * No ffmpeg and no media here on purpose: every property worth pinning is about the
 * BOOKKEEPING -- who joins whom, what is refused, what is reaped -- and a real transcode
 * would make each of those cases a second slower and no more true. The real ffmpeg is
 * exercised in `playback-plan.test.ts`'s argv and end to end by hand.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { PlaybackPlan } from "./playback-plan";
import {
  EXPENSIVE_SESSIONS,
  HARD_TTL_MS,
  IDLE_REAP_MS,
  MAX_SESSIONS,
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

/** A spawner that records its argv and lets a test decide when the process exits. */
function fakeSpawner() {
  const spawned: string[][] = [];
  const killed: { signal: number | undefined }[] = [];
  const finish: ((code: number) => void)[] = [];
  const spawn: Spawner = (argv) => {
    spawned.push(argv);
    let resolve!: (c: number) => void;
    const exited = new Promise<number>((r) => {
      resolve = r;
    });
    finish.push(resolve);
    return {
      kill: (signal) => {
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

describe("starting a session", () => {
  test("spawns ffmpeg with the plan's argv and makes it a directory", () => {
    const f = fakeSpawner();
    const s = mgr(f.spawn).start({ input: "/plex/a.mkv", plan: CHEAP });

    expect(f.spawned).toHaveLength(1);
    expect(f.spawned[0]?.[0]).toBe("ffmpeg");
    expect(f.spawned[0]?.join(" ")).toContain("/plex/a.mkv");
    expect(f.spawned[0]?.join(" ")).toContain(s.dir);
    expect(existsSync(s.dir)).toBe(true);
  });

  /**
   * THE JOIN. Two ffmpegs writing one index.m3u8 corrupt the playlist for both viewers, so
   * this is a correctness property rather than an efficiency one.
   */
  test("a second identical request joins the running session rather than spawning again", () => {
    const f = fakeSpawner();
    const m = mgr(f.spawn);
    const a = m.start({ input: "/plex/a.mkv", plan: CHEAP });
    const b = m.start({ input: "/plex/a.mkv", plan: CHEAP });

    expect(b.id).toBe(a.id);
    expect(b.dir).toBe(a.dir);
    expect(f.spawned).toHaveLength(1);
    expect(m.list()).toHaveLength(1);
  });

  test("joining counts as being wanted, so a busy session is never reaped under a viewer", () => {
    const f = fakeSpawner();
    const m = mgr(f.spawn);
    const a = m.start({ input: "/plex/a.mkv", plan: CHEAP });

    clock += IDLE_REAP_MS - 1;
    m.start({ input: "/plex/a.mkv", plan: CHEAP });
    clock += IDLE_REAP_MS - 1;

    expect(m.reap()).toBe(0);
    expect(m.get(a.id)).not.toBeNull();
  });

  /** A different seek is genuinely different output; sharing would hand over the wrong timeline. */
  test("a different seek offset is a different session", () => {
    const f = fakeSpawner();
    const m = mgr(f.spawn);
    m.start({ input: "/plex/a.mkv", plan: CHEAP });
    m.start({ input: "/plex/a.mkv", plan: CHEAP, seekSec: 600 });

    expect(f.spawned).toHaveLength(2);
    expect(m.list()).toHaveLength(2);
  });

  test("a different plan for the same file is a different session", () => {
    const f = fakeSpawner();
    const m = mgr(f.spawn);
    m.start({ input: "/plex/a.mkv", plan: CHEAP });
    m.start({ input: "/plex/a.mkv", plan: EXPENSIVE });
    expect(f.spawned).toHaveLength(2);
  });

  test("the key names every input that changes the output", () => {
    const base = { input: "/plex/a.mkv", plan: CHEAP };
    expect(sessionKey(base)).toBe(sessionKey({ ...base }));
    expect(sessionKey(base)).not.toBe(sessionKey({ ...base, seekSec: 1 }));
    expect(sessionKey(base)).not.toBe(sessionKey({ ...base, input: "/plex/b.mkv" }));
    expect(sessionKey(base)).not.toBe(sessionKey({ ...base, plan: EXPENSIVE }));
  });
});

describe("the two budgets", () => {
  /**
   * One number would either strangle the cheap case or admit enough of the expensive one to
   * take a Celeron down, which is why there are two.
   */
  test("expensive sessions are capped well below the total", () => {
    const f = fakeSpawner();
    const m = mgr(f.spawn);
    for (let i = 0; i < EXPENSIVE_SESSIONS; i++) {
      m.start({ input: `/plex/e${i}.mkv`, plan: EXPENSIVE });
    }
    expect(() => m.start({ input: "/plex/one-too-many.mkv", plan: EXPENSIVE })).toThrow(SessionRefused);
  });

  test("a cheap session is still admitted when the expensive budget is full", () => {
    const f = fakeSpawner();
    const m = mgr(f.spawn);
    for (let i = 0; i < EXPENSIVE_SESSIONS; i++) {
      m.start({ input: `/plex/e${i}.mkv`, plan: EXPENSIVE });
    }
    expect(() => m.start({ input: "/plex/cheap.mkv", plan: CHEAP })).not.toThrow();
  });

  test("the total is capped too", () => {
    const f = fakeSpawner();
    const m = mgr(f.spawn);
    for (let i = 0; i < MAX_SESSIONS; i++) m.start({ input: `/plex/c${i}.mkv`, plan: CHEAP });
    expect(() => m.start({ input: "/plex/over.mkv", plan: CHEAP })).toThrow(SessionRefused);
  });

  /** Refusing rather than queueing: a queued playback is a person watching a spinner. */
  test("the refusal names which budget it was", () => {
    const f = fakeSpawner();
    const m = mgr(f.spawn);
    for (let i = 0; i < EXPENSIVE_SESSIONS; i++) m.start({ input: `/plex/e${i}.mkv`, plan: EXPENSIVE });
    try {
      m.start({ input: "/plex/x.mkv", plan: EXPENSIVE });
      throw new Error("should have refused");
    } catch (err) {
      expect(err).toBeInstanceOf(SessionRefused);
      expect((err as SessionRefused).reason).toBe("too-many-expensive");
    }
  });

  /** An abandoned session must never keep a live viewer out. */
  test("start reaps before it refuses", () => {
    const f = fakeSpawner();
    const m = mgr(f.spawn);
    for (let i = 0; i < MAX_SESSIONS; i++) m.start({ input: `/plex/c${i}.mkv`, plan: CHEAP });

    clock += IDLE_REAP_MS + 1;
    expect(() => m.start({ input: "/plex/fresh.mkv", plan: CHEAP })).not.toThrow();
    expect(m.list()).toHaveLength(1);
  });
});

describe("ending a session", () => {
  test("stop signals ffmpeg and removes the directory", () => {
    const f = fakeSpawner();
    const m = mgr(f.spawn);
    const s = m.start({ input: "/plex/a.mkv", plan: CHEAP });
    const dir = s.dir;

    m.stop(s.id);

    expect(f.killed[0]?.signal).toBe(15);
    expect(m.get(s.id)).toBeNull();
    expect(existsSync(dir)).toBe(false);
  });

  test("stopping twice is harmless", () => {
    const f = fakeSpawner();
    const m = mgr(f.spawn);
    const s = m.start({ input: "/plex/a.mkv", plan: CHEAP });
    m.stop(s.id);
    expect(() => m.stop(s.id)).not.toThrow();
  });

  /**
   * ffmpeg finishing on its own has to give the slot back without waiting for the reaper,
   * or a server that transcoded MAX_SESSIONS short files an hour ago refuses the next one.
   */
  test("ffmpeg exiting on its own frees the slot", async () => {
    const f = fakeSpawner();
    const m = mgr(f.spawn);
    const s = m.start({ input: "/plex/a.mkv", plan: CHEAP });

    f.finish[0]?.(0);
    await s.exited;
    await Promise.resolve();

    expect(m.get(s.id)).toBeNull();
    expect(m.list()).toHaveLength(0);
  });

  test("an idle session is reaped", () => {
    const f = fakeSpawner();
    const m = mgr(f.spawn);
    const s = m.start({ input: "/plex/a.mkv", plan: CHEAP });

    clock += IDLE_REAP_MS - 1;
    expect(m.reap()).toBe(0);

    clock += 2;
    expect(m.reap()).toBe(1);
    expect(m.get(s.id)).toBeNull();
  });

  test("touch keeps a session alive", () => {
    const f = fakeSpawner();
    const m = mgr(f.spawn);
    const s = m.start({ input: "/plex/a.mkv", plan: CHEAP });

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
    const f = fakeSpawner();
    const m = mgr(f.spawn);
    const s = m.start({ input: "/plex/a.mkv", plan: CHEAP });

    while (clock - s.startedAt < HARD_TTL_MS) {
      clock += IDLE_REAP_MS / 2;
      m.touch(s.id);
      m.reap();
    }
    m.reap();
    expect(m.get(s.id)).toBeNull();
  });

  test("touching a session that no longer exists is null, not a throw", () => {
    const m = mgr(fakeSpawner().spawn);
    expect(m.touch("nope")).toBeNull();
  });

  test("stopAll clears everything", () => {
    const f = fakeSpawner();
    const m = mgr(f.spawn);
    m.start({ input: "/plex/a.mkv", plan: CHEAP });
    m.start({ input: "/plex/b.mkv", plan: CHEAP });
    m.stopAll();
    expect(m.list()).toHaveLength(0);
  });

  /** A stopped session's key must be free, or that file can never be played again. */
  test("a stopped session's key is released so the same file can start again", () => {
    const f = fakeSpawner();
    const m = mgr(f.spawn);
    const a = m.start({ input: "/plex/a.mkv", plan: CHEAP });
    m.stop(a.id);
    const b = m.start({ input: "/plex/a.mkv", plan: CHEAP });
    expect(b.id).not.toBe(a.id);
    expect(f.spawned).toHaveLength(2);
  });
});
