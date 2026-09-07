/**
 * One running ffmpeg, its output directory, and the rules that stop it owning the machine.
 *
 * ffmpeg writes HLS segments to a directory; the route hands those files out with
 * `Bun.file`, which is zero-copy, so **segment bytes never enter the JS heap and the event
 * loop pays a stat and an fd handoff per segment** rather than megabytes. That is the whole
 * reason a transcoder can live beside a render path that must stay fast: the expensive work
 * is in another process with its own CPU share, and the cheap work is what Bun is good at.
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
 * > [!IMPORTANT] THIS IS THE ONE LIMITER IN THE REPO THAT IS NOT COCKATIEL, AND THAT IS ARGUED
 * > The standing rule is that every timeout, semaphore and retry comes from `cockatiel`, and
 * > it is right everywhere it applies. It does not apply here. A cockatiel `bulkhead`
 * > executes a function and releases its slot when that function's promise settles -- but a
 * > transcode session **outlives the call that starts it** by minutes, and is released by an
 * > idle reaper or a client going away, neither of which is a promise `start()` could
 * > return. Wrapping the spawn would release the slot the instant ffmpeg was launched, which
 * > is a limiter that limits nothing.
 * >
 * > So the counter here is explicit and its release is explicit. What is NOT hand-rolled is
 * > the shape of the refusal: past the limit this throws rather than queueing, for the same
 * > reason `OUTBOUND_QUEUE_LIMIT` exists -- a queued playback request is a person watching a
 * > spinner for a minute, which is worse than being told the server is busy.
 *
 * > [!CAUTION] A SESSION IS KEYED BY ITS INPUTS, so two viewers of one thing cost one ffmpeg
 * > The key is the resolved path, the plan and the seek offset. Two clients asking for the
 * > same thing JOIN the running session instead of racing a second ffmpeg over the same
 * > output directory -- which would not merely be wasteful, it would have two processes
 * > writing one `index.m3u8` and produce a corrupt playlist for both of them.
 */

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
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

/** No client has asked for a segment in this long -- the session is abandoned. */
export const IDLE_REAP_MS = 60_000;

/**
 * Nothing lives past this, touched or not.
 *
 * A client that keeps polling a playlist forever is indistinguishable from a healthy viewer,
 * so the idle reaper alone cannot bound the total. This is the backstop that makes the
 * session table finite under any client behaviour at all.
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
  seekSec?: number;
  /** `/dev/dri/renderD128` when QuickSync is available. */
  vaapiDevice?: string;
  /** Seconds to burst-read before throttling; see `FfmpegOpts.readrateBurstSec`. */
  readrateBurstSec?: number;
  /** Who asked, for the health report. Never used for a decision. */
  owner?: string;
}

export interface Session {
  id: string;
  key: string;
  dir: string;
  plan: PlaybackPlan;
  expensive: boolean;
  startedAt: number;
  lastAccessAt: number;
  owner: string | null;
  /** Resolves when ffmpeg exits, either way. */
  exited: Promise<number>;
  stop(): void;
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

export class TranscodeSessions {
  private readonly sessions = new Map<string, Session>();
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
   * Start a session, or JOIN the one already producing exactly this output.
   *
   * The join is not an optimisation -- see the caution above; two ffmpegs writing one
   * playlist corrupt it for both viewers.
   */
  start(o: StartOpts): Session {
    const key = sessionKey(o);
    const existing = this.byKey.get(key);
    if (existing) {
      const s = this.sessions.get(existing);
      if (s) {
        s.lastAccessAt = this.now();
        return s;
      }
    }

    const expensive = isExpensive(o.plan);
    // Reap before refusing: an abandoned session must never keep a live viewer out.
    this.reap();
    if (this.sessions.size >= MAX_SESSIONS) throw new SessionRefused("too-many");
    if (expensive && this.expensiveCount() >= EXPENSIVE_SESSIONS) {
      throw new SessionRefused("too-many-expensive");
    }

    const dir = mkdtempSync(join(this.opts.root, "sess-"));
    const argv = [
      this.ffmpeg,
      ...ffmpegArgs(o.plan, {
        input: o.input,
        outDir: dir,
        seekSec: o.seekSec,
        vaapiDevice: o.vaapiDevice,
        readrateBurstSec: o.readrateBurstSec,
      }),
    ];
    const proc = this.spawn(argv);
    const id = crypto.randomUUID();
    const at = this.now();

    const session: Session = {
      id,
      key,
      dir,
      plan: o.plan,
      expensive,
      startedAt: at,
      lastAccessAt: at,
      owner: o.owner ?? null,
      exited: proc.exited,
      stop: () => this.stop(id),
    };

    // Self-cleanup when ffmpeg ends on its own -- the file finished, or it died. Either way
    // the directory and the slot must go back without waiting for the reaper, or a server
    // that transcoded eight short files an hour ago refuses the ninth.
    void proc.exited.then(() => {
      this.forget(id);
    });

    this.sessions.set(id, session);
    this.byKey.set(key, id);
    (session as Session & { proc: ReturnType<Spawner> }).proc = proc;
    return session;
  }

  /** Mark a session as still wanted. Called on every segment and playlist read. */
  touch(id: string): Session | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    s.lastAccessAt = this.now();
    return s;
  }

  get(id: string): Session | null {
    return this.sessions.get(id) ?? null;
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  expensiveCount(): number {
    return this.list().filter((s) => s.expensive).length;
  }

  /**
   * Stop a session: ask ffmpeg to finish, insist shortly after, drop the directory.
   *
   * SIGTERM first because ffmpeg closes its output cleanly on it. The SIGKILL is a backstop
   * for a process wedged on a stalled read -- a NAS share going away mid-stream is the real
   * case, and it is exactly when a hung ffmpeg would otherwise hold a slot forever.
   */
  stop(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    const proc = (s as Session & { proc?: ReturnType<Spawner> }).proc;
    try {
      proc?.kill(15);
    } catch {
      // Already gone. The forget below is what matters.
    }
    const timer = setTimeout(() => {
      try {
        proc?.kill(9);
      } catch {
        // Nothing to insist to.
      }
    }, SIGKILL_AFTER_MS);
    // Do not hold the process open for a grace period nobody is waiting on.
    (timer as unknown as { unref?: () => void }).unref?.();
    this.forget(id);
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
   * > [!CAUTION] A PROCESS THAT EXITS WITHOUT CALLING THIS ORPHANS EVERY RUNNING ffmpeg
   * > A child outlives its parent. When finderr goes away -- a redeploy, a `--watch`
   * > restart, an operator's Ctrl-C -- the new process starts with an empty session map
   * > while the old ffmpegs keep running, reparented to init, at whatever CPU they were
   * > using, forever. Nothing reaps them, because the only thing that knew about them was
   * > the map that just went away.
   * >
   * > Observed 2026-09-08 on the dev server: one orphan from a restart three edits earlier
   * > was still at 344% CPU when somebody noticed the fans. `bindShutdown` is what stops
   * > this being possible, and it is not optional wiring.
   */
  stopAll(): void {
    for (const s of this.list()) this.stop(s.id);
  }

  /**
   * Sweep session directories left by a PREVIOUS life of this process.
   *
   * Called at boot, before anything starts. A hard kill (SIGKILL, an OOM, a pulled plug)
   * skips `stopAll` by definition, so the disk keeps whatever those sessions had written --
   * and an HLS session is megabytes per minute. The directories are safe to remove
   * unconditionally because nothing durable lives here: the whole tree is regenerable
   * output, which is exactly why `paths.transcode` is its own directory rather than a
   * corner of the data root.
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

  private forget(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    if (this.byKey.get(s.key) === id) this.byKey.delete(s.key);
    try {
      rmSync(s.dir, { recursive: true, force: true });
    } catch {
      // A directory we cannot remove is litter rather than a failure; the slot is what
      // mattered and it is already back.
    }
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
 * The seek offset is part of it BECAUSE ffmpeg starts writing at that point: two viewers at
 * different positions genuinely need different output, and treating them as one would give
 * the second viewer the first one's timeline.
 */
export function sessionKey(o: StartOpts): string {
  const p = o.plan;
  return [
    o.input,
    o.seekSec ?? 0,
    // Pacing is part of the key because it changes the ARGV, and two sessions that would
    // run different ffmpegs must not share one output directory.
    o.readrateBurstSec ?? 0,
    p.video.action,
    p.video.sourceIndex,
    p.audio.action,
    p.audio.sourceIndex,
    p.subtitles.action,
    p.subtitles.sourceIndex,
    o.vaapiDevice ?? "",
  ].join("|");
}
