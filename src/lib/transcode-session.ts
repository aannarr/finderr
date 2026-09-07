/**
 * One playback: a plan, a timeline, an output directory, and the rules that stop it owning
 * the machine.
 *
 * A session here does NOT hold a running ffmpeg. It holds the DECISION -- which file, cut
 * how, into which segments -- and makes each segment when a player asks for it. ffmpeg runs
 * for the length of one segment and exits. `hls-timeline.ts` owns the segmentation,
 * `playback-plan.ts` owns the argv, and this module owns the bookkeeping between them.
 *
 * Segments are handed out by the route with `Bun.file`, which is zero-copy, so **segment
 * bytes never enter the JS heap and the event loop pays a stat and an fd handoff per
 * segment** rather than megabytes. That is the whole reason a transcoder can live beside a
 * render path that must stay fast.
 *
 * ## Why the process is short-lived now, and what that bought
 *
 * The first version ran one long ffmpeg per session, paced to roughly realtime so it could
 * not encode a whole film for somebody who watched nine seconds. It worked, and it made
 * seeking impossible: a player can only seek inside the playlist, the playlist grew as
 * ffmpeg wrote, and pacing kept the end of it near the playhead on purpose.
 *
 * Producing one segment per request fixes that and deletes the pacing problem rather than
 * solving it. Nothing runs while a viewer is paused, a viewer who quits has bought the
 * segments they watched and one more, and a scrub to 01:20:00 costs exactly the segment at
 * 01:20:00. Measured on the NAS over the array 2026-09-08: **0.07-0.08 s for one ten-second
 * copy-mode segment**, deep into a 3.4 GB file.
 *
 * ## The two budgets, and why one number would be wrong
 *
 * The measured library splits cleanly into a cheap majority and an expensive minority:
 * remuxing a container and re-encoding one audio track costs under 5% of a core, while
 * re-encoding video costs most of a Celeron J4125. **A single "max sessions" number would
 * either strangle the cheap case or admit enough of the expensive one to take the box
 * down.** So there are two limits and `isExpensive(plan)` decides which one a session
 * spends -- see `EXPENSIVE_SESSIONS` and `MAX_SESSIONS`.
 *
 * > [!CAUTION] A SESSION IS KEYED BY ITS INPUTS, so two viewers of one thing cost one session
 * > The key is the resolved path, the plan and the encoder. Two clients asking for the same
 * > thing JOIN, and then share every segment either of them causes to be produced -- which
 * > is not merely thrift: two sessions over one output directory would have two ffmpegs
 * > racing to write the same segment file.
 * >
 * > The seek offset is NOT part of the key any more, and that is the shape of the whole
 * > change. It used to be, because a session was a position; a session is now a whole film
 * > and a position is just which segment gets asked for first.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { EncoderChoice } from "./encoder";
import { initFileName, RUN_INIT_NAME, segmentFileName, segmentRange, type Timeline } from "./hls-timeline";
import { ffmpegArgs, isExpensive, type PlaybackPlan } from "./playback-plan";

/**
 * How many sessions may re-encode VIDEO at once.
 *
 * Two, because the deployment target's iGPU (UHD 600 on a Celeron J4125) does roughly one
 * to two 4K-to-1080p streams and nothing in SQLite's way. This is the number to raise once
 * somebody has MEASURED a real QSV transcode on that box; until then it is a floor chosen
 * from the hardware's known class rather than from a benchmark, and it says so.
 */
export const EXPENSIVE_SESSIONS = 2;

/**
 * How many sessions may exist at all.
 *
 * The cheap case is a container rewrite plus one audio track, measured at 28.7x and 57x
 * realtime on an M1 Max over SMB -- so this bound is about file descriptors and disk, not
 * CPU. It is deliberately not generous: every session holds a temp directory.
 */
export const MAX_SESSIONS = 8;

/**
 * How many segments one session may be producing at the same moment.
 *
 * Two, because a player asks for the initialisation segment and the first media segment
 * almost together and serialising those two is a visible delay. Past that it is
 * BACK-PRESSURE, and the case it exists for is the one the card named: a viewer dragging the
 * scrubber emits a seek per pointer move, and without a ceiling each one would spawn an
 * ffmpeg for a position the viewer has already left. A refused production is a 404, which is
 * what a player retries.
 */
export const SEGMENT_CONCURRENCY = 2;

/**
 * How many produced segments a session keeps on disk.
 *
 * A full watch-through of a remuxed 4K film would otherwise leave the whole film in the data
 * directory -- gigabytes, for a viewer who has already passed it. The oldest production is
 * dropped once this many exist, and re-producing one costs the measured 0.08 s, so a rewind
 * past the window is cheap rather than broken.
 */
export const SEGMENT_CACHE = 10;

/** How long one segment production may take before it is killed. */
export const SEGMENT_TIMEOUT_MS = 45_000;

/** No client has asked for a segment in this long -- the session is abandoned. */
export const IDLE_REAP_MS = 60_000;

/**
 * Nothing lives past this, touched or not.
 *
 * A client that keeps polling forever is indistinguishable from a healthy viewer, so the
 * idle reaper alone cannot bound the total. This is the backstop that makes the session
 * table finite under any client behaviour at all.
 */
export const HARD_TTL_MS = 6 * 60 * 60 * 1000;

/** Grace between asking ffmpeg to stop and insisting. */
const SIGKILL_AFTER_MS = 2_000;

export class SessionRefused extends Error {
  constructor(readonly reason: "too-many" | "too-many-expensive") {
    super(reason);
  }
}

export interface StartOpts {
  /** ALREADY resolved through `media-path.ts`. This module never validates a path. */
  input: string;
  plan: PlaybackPlan;
  /** Every segment of the title, from `hls-timeline.ts`. */
  timeline: Timeline;
  /** Which encoder to use for a re-encode. From `chooseEncoder`, probed once at boot. */
  encoder?: EncoderChoice;
  /** Who asked, for the health report. Never used for a decision. */
  owner?: string;
}

export interface Session {
  id: string;
  key: string;
  dir: string;
  input: string;
  plan: PlaybackPlan;
  timeline: Timeline;
  expensive: boolean;
  encoder?: EncoderChoice;
  startedAt: number;
  lastAccessAt: number;
  owner: string | null;
}

/** Injected so tests need no ffmpeg. */
export type Spawner = (argv: string[]) => { kill(signal?: number): void; exited: Promise<number> };

const defaultSpawner: Spawner = (argv) => {
  const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe" });
  return { kill: (s) => proc.kill(s), exited: proc.exited };
};

export interface ManagerOpts {
  /** Where session directories are made. Under the data dir in production. */
  root: string;
  spawn?: Spawner;
  now?: () => number;
  ffmpegPath?: string;
}

/** Everything a session keeps that a caller has no business seeing. */
interface SessionState {
  session: Session;
  /** Segment index -> the production in flight for it, so two requests cost one ffmpeg. */
  producing: Map<number, Promise<boolean>>;
  /** Produced segment indices in the order they landed, for eviction. */
  produced: number[];
  /** Live children, so shutdown can kill what is running rather than orphaning it. */
  running: Set<ReturnType<Spawner>>;
}

export class TranscodeSessions {
  private readonly states = new Map<string, SessionState>();
  private readonly byKey = new Map<string, string>();
  private readonly spawn: Spawner;
  private readonly now: () => number;
  private readonly ffmpeg: string;

  constructor(private readonly opts: ManagerOpts) {
    this.spawn = opts.spawn ?? defaultSpawner;
    this.now = opts.now ?? Date.now;
    this.ffmpeg = opts.ffmpegPath ?? "ffmpeg";
  }

  /**
   * Start a session, or JOIN the one already serving exactly this thing.
   *
   * Cheap by construction: no process is started here. What it spends is a slot and a
   * directory, and what it refuses is a ninth viewer or a third re-encode.
   */
  start(o: StartOpts): Session {
    const key = sessionKey(o);
    const joined = this.byKey.get(key);
    if (joined) {
      const state = this.states.get(joined);
      if (state) {
        state.session.lastAccessAt = this.now();
        return state.session;
      }
    }

    const expensive = isExpensive(o.plan);
    // Reap before refusing: an abandoned session must never keep a live viewer out.
    this.reap();
    if (this.states.size >= MAX_SESSIONS) throw new SessionRefused("too-many");
    if (expensive && this.expensiveCount() >= EXPENSIVE_SESSIONS) {
      throw new SessionRefused("too-many-expensive");
    }

    mkdirSync(this.opts.root, { recursive: true });
    const dir = mkdtempSync(join(this.opts.root, "sess-"));
    const at = this.now();
    const session: Session = {
      id: crypto.randomUUID(),
      key,
      dir,
      input: o.input,
      plan: o.plan,
      timeline: o.timeline,
      expensive,
      encoder: o.encoder,
      startedAt: at,
      lastAccessAt: at,
      owner: o.owner ?? null,
    };
    this.states.set(session.id, { session, producing: new Map(), produced: [], running: new Set() });
    this.byKey.set(key, session.id);
    return session;
  }

  /** Mark a session as still wanted. Called on every playlist and segment read. */
  touch(id: string): Session | null {
    const state = this.states.get(id);
    if (!state) return null;
    state.session.lastAccessAt = this.now();
    return state.session;
  }

  get(id: string): Session | null {
    return this.states.get(id)?.session ?? null;
  }

  list(): Session[] {
    return [...this.states.values()].map((s) => s.session);
  }

  expensiveCount(): number {
    return this.list().filter((s) => s.expensive).length;
  }

  /**
   * The path of segment `index`, producing it first if nobody has yet.
   *
   * Null means the caller should answer 404: no such session, no such segment, ffmpeg
   * failed, or too many productions are already in flight. Every one of those is a state a
   * player retries out of, which is why they share an answer.
   */
  segmentPath(id: string, index: number): Promise<string | null> {
    return this.published(id, index, segmentFileName(index));
  }

  /**
   * The path of segment `index`'s fMP4 initialisation segment, producing it if need be.
   *
   * Every run writes its own init and the session keeps it BESIDE its segment rather than
   * sharing one, for the measured reason in `vodPlaylist`'s note: the init carries an edit
   * list naming where its run started, so the wrong one shifts the whole segment. A player
   * asks for this immediately before the media, so on a cold session this call is usually
   * what pays for the segment too, and the request that follows it is already satisfied.
   */
  initPath(id: string, index: number): Promise<string | null> {
    return this.published(id, index, initFileName(index));
  }

  /**
   * One published file of segment `index` -- its media or its init -- produced if need be.
   *
   * Both come out of the SAME ffmpeg run, so both questions are the same question and asking
   * them through one method is what stops a player's init request and its media request
   * costing two transcodes of the same six seconds.
   */
  private async published(id: string, index: number, name: string): Promise<string | null> {
    const state = this.states.get(id);
    if (!state) return null;
    state.session.lastAccessAt = this.now();
    const path = join(state.session.dir, name);
    if (existsSync(path)) return path;
    await this.produce(state, index);
    return existsSync(path) ? path : null;
  }

  /**
   * Produce one segment, or join the production already making it.
   *
   * The dedupe is not an optimisation: two ffmpegs writing one segment file would hand a
   * player half of each.
   */
  private produce(state: SessionState, index: number): Promise<boolean> {
    const already = state.producing.get(index);
    if (already) return already;
    if (state.producing.size >= SEGMENT_CONCURRENCY) return Promise.resolve(false);
    const range = segmentRange(state.session.timeline, index);
    if (!range) return Promise.resolve(false);

    const run = this.runFfmpeg(state, index, range).finally(() => {
      state.producing.delete(index);
    });
    state.producing.set(index, run);
    return run;
  }

  /**
   * One ffmpeg, into a private working directory, published by rename.
   *
   * > [!IMPORTANT] THE RENAME IS WHAT MAKES A SEGMENT SAFE TO SERVE
   * > ffmpeg writes a segment progressively, so a route that served the file the moment it
   * > appeared would hand a player a truncated fragment -- which is not a retryable 404, it
   * > is a decode error. Writing into a directory nobody serves and moving the finished file
   * > in is atomic within one filesystem, so a segment is either absent or complete.
   */
  private async runFfmpeg(
    state: SessionState,
    index: number,
    range: { startSec: number; endSec: number },
  ): Promise<boolean> {
    const { session } = state;
    let work: string;
    try {
      work = mkdtempSync(join(session.dir, `w${index}-`));
    } catch {
      // The session directory is gone: it was stopped while this request was in flight.
      return false;
    }

    const proc = this.spawn([
      this.ffmpeg,
      ...ffmpegArgs(session.plan, {
        input: session.input,
        outDir: work,
        segment: { index, startSec: range.startSec, endSec: range.endSec },
        encoder: session.encoder,
      }),
    ]);
    state.running.add(proc);

    const timer = setTimeout(() => {
      try {
        proc.kill(9);
      } catch {
        // Already gone; the exit below is what the caller waits on.
      }
    }, SEGMENT_TIMEOUT_MS);
    (timer as unknown as { unref?: () => void }).unref?.();

    let code: number;
    try {
      code = await proc.exited;
    } finally {
      clearTimeout(timer);
      state.running.delete(proc);
    }

    const published = code === 0 && this.publish(state, work, index);
    rmSync(work, { recursive: true, force: true });
    return published;
  }

  /**
   * Move the finished media segment and its init out of the working directory.
   *
   * BOTH, together: an init belongs to the segment its run produced and is useless beside any
   * other one. The media is renamed LAST so that a segment file appearing implies its init is
   * already there -- a player asks for them in the other order, but nothing enforces that.
   */
  private publish(state: SessionState, work: string, index: number): boolean {
    const { dir } = state.session;
    const media = segmentFileName(index);
    try {
      if (!existsSync(join(work, RUN_INIT_NAME)) || !existsSync(join(work, media))) return false;
      renameSync(join(work, RUN_INIT_NAME), join(dir, initFileName(index)));
      renameSync(join(work, media), join(dir, media));
    } catch {
      return false;
    }
    state.produced.push(index);
    this.evict(state);
    return true;
  }

  /** Drop the oldest productions, both files of each, once a session holds too many. */
  private evict(state: SessionState): void {
    while (state.produced.length > SEGMENT_CACHE) {
      const oldest = state.produced.shift();
      if (oldest === undefined) return;
      rmSync(join(state.session.dir, segmentFileName(oldest)), { force: true });
      rmSync(join(state.session.dir, initFileName(oldest)), { force: true });
    }
  }

  /**
   * Stop a session: kill whatever it is running, drop its directory, free its slot.
   *
   * SIGTERM first because ffmpeg closes its output cleanly on it. The SIGKILL is a backstop
   * for a process wedged on a stalled read -- a NAS share going away mid-stream is the real
   * case, and it is exactly when a hung ffmpeg would otherwise hold a slot forever.
   */
  stop(id: string): void {
    const state = this.states.get(id);
    if (!state) return;
    for (const proc of state.running) {
      try {
        proc.kill(15);
      } catch {
        // Already gone. Dropping the directory below is what matters.
      }
      const timer = setTimeout(() => {
        try {
          proc.kill(9);
        } catch {
          // Nothing to insist to.
        }
      }, SIGKILL_AFTER_MS);
      // Do not hold the process open for a grace period nobody is waiting on.
      (timer as unknown as { unref?: () => void }).unref?.();
    }
    this.states.delete(id);
    if (this.byKey.get(state.session.key) === id) this.byKey.delete(state.session.key);
    try {
      rmSync(state.session.dir, { recursive: true, force: true });
    } catch {
      // A directory we cannot remove is litter rather than a failure; the slot is what
      // mattered and it is already back.
    }
  }

  /**
   * Drop every session that is abandoned or simply too old.
   *
   * Cheap and synchronous, and called from `start` rather than from a timer: the moment a
   * limit could bite is exactly the moment it is worth knowing what is really still alive,
   * and a manager with no traffic has nothing to reap.
   */
  reap(): number {
    const t = this.now();
    let dropped = 0;
    for (const s of this.list()) {
      const idle = t - s.lastAccessAt >= IDLE_REAP_MS;
      const old = t - s.startedAt >= HARD_TTL_MS;
      if (idle || old) {
        this.stop(s.id);
        dropped++;
      }
    }
    return dropped;
  }

  /**
   * Stop everything.
   *
   * > [!CAUTION] A PROCESS THAT EXITS WITHOUT CALLING THIS ORPHANS A RUNNING ffmpeg
   * > A child outlives its parent. When finderr goes away -- a redeploy, a `--watch`
   * > restart, an operator's Ctrl-C -- the new process starts with an empty session map
   * > while the old ffmpeg keeps running, reparented to init, forever. Nothing reaps it,
   * > because the only thing that knew about it was the map that just went away.
   * >
   * > Observed 2026-09-08 on the dev server: one orphan from a restart three edits earlier
   * > was still at 344% CPU when somebody noticed the fans. Segment runs are short, which
   * > narrows the window rather than closing it -- a 4K re-encode of one segment is still
   * > seconds of a Celeron. `bindShutdown` is not optional wiring.
   */
  stopAll(): void {
    for (const s of this.list()) this.stop(s.id);
  }

  /**
   * Sweep session directories left by a PREVIOUS life of this process.
   *
   * Called at boot, before anything starts. A hard kill (SIGKILL, an OOM, a pulled plug)
   * skips `stopAll` by definition, so the disk keeps whatever those sessions had written.
   * The directories are safe to remove unconditionally because nothing durable lives here:
   * the whole tree is regenerable output, which is exactly why `paths.transcode` is its own
   * directory rather than a corner of the data root.
   */
  sweepStale(): number {
    let removed = 0;
    try {
      for (const name of readdirSync(this.opts.root)) {
        if (!name.startsWith("sess-")) continue;
        rmSync(join(this.opts.root, name), { recursive: true, force: true });
        removed++;
      }
    } catch {
      // No directory yet, or no permission. Neither is worth failing a boot over.
    }
    return removed;
  }
}

/**
 * Make the process kill its transcodes before it dies.
 *
 * Separate from the class so the class stays testable without touching global process
 * state, and so the wiring is one visible line at the call site rather than a side effect
 * of construction.
 *
 * **Every one of these signals matters and they arrive from different places.** `SIGTERM` is
 * what `docker stop` and a redeploy send; `SIGINT` is Ctrl-C on the dev server; `exit`
 * catches an ordinary return and an uncaught throw. What CANNOT be caught is `SIGKILL` --
 * which is why `sweepStale` exists as the second half of this.
 *
 * The handlers do not exit the process themselves. Something else owns shutdown ordering
 * (the database has a checkpoint to finish, and hard-killing it has cost this project a
 * file before), so this only ever adds a cleanup and never takes over the sequence.
 */
export function bindShutdown(sessions: TranscodeSessions): void {
  const stop = () => sessions.stopAll();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.once("exit", stop);
}

/**
 * What makes two requests the same session.
 *
 * The file, the plan and the encoder -- everything that changes what a segment would
 * CONTAIN. The position is deliberately absent: a session is a whole film now, so two
 * viewers at different points in it share one session and every segment either of them
 * causes to be produced.
 */
export function sessionKey(o: StartOpts): string {
  const p = o.plan;
  return [
    o.input,
    p.video.action,
    p.video.sourceIndex,
    p.audio.action,
    p.audio.sourceIndex,
    p.subtitles.action,
    p.subtitles.sourceIndex,
    o.encoder?.encoder ?? "",
  ].join("|");
}
