/**
 * Build a new index and adopt it, as ONE operation with one owner.
 *
 * ## Why this is a module rather than three call sites
 *
 * Building and adopting are two halves of one act, and until 2026-09-01 only the daily cron
 * performed both. The boot-time build did its own half (`IndexBuild` then `live.open()`),
 * and an operator running `bun src/jobs/build-index.ts` by hand got the first half with no
 * second -- which is the sharpest edge in this whole area, because a hand-run build
 * PROMOTES. It renames the live file out from under the running server's open connection,
 * and that connection then throws on most reads and silently serves yesterday on the rest
 * (see the warning on `LiveIndex.reload()`). The server does not recover until somebody
 * restarts it, and nothing anywhere says so.
 *
 * So the fix is not a warning in a doc. It is having a path that does both, and pointing
 * every caller at it.
 *
 * ## One at a time, and the second caller waits rather than starting a second build
 *
 * A refresh downloads up to a gigabyte and rewrites a 667 MB file. Two of them at once
 * would race on `titles.new.db` and on the promote itself. The boot stage check and the
 * daily cron can now genuinely coincide -- a container restarted at 08:59 UTC onto an index
 * missing a stage does exactly that -- so this is a real case rather than a defensive one.
 *
 * The guard is a shared PROMISE rather than a boolean: a second caller joins the run
 * already in flight and gets its outcome, instead of being told "busy" and having to decide
 * what that means. `refreshing()` is there so `/api/health` can report it.
 */

import { type Config, paths } from "../lib/config";
import { describeStale, staleStagesOf } from "../lib/index-stages";
import type { LiveIndex, ReloadOutcome } from "./live-index";

/** What a refresh did, in the order it did it. */
export interface RefreshOutcome {
  /** Exit code of the build job. 0 means it promoted, or found nothing worth building. */
  exitCode: number;
  /** The adoption attempt, absent when the build did not exit 0 and nothing was promoted. */
  reload?: ReloadOutcome;
  /** Wall time for the whole thing. */
  ms: number;
  /** Set when this call JOINED a refresh that was already running rather than starting one. */
  joined?: boolean;
}

export interface RefreshDeps {
  cfg: Config;
  live: LiveIndex;
  log: (msg: string) => void;
  /** Absolute path to `build-index.ts`. Injected so a test needs no real 25-minute build. */
  script: string;
  /** Injected by tests. Defaults to spawning the real job. */
  runBuild?: (script: string) => Promise<number>;
  /** Called after a swap actually happened. The front page is a function of the index. */
  onSwapped?: () => void;
}

/** Spawn the build job, inheriting stdio. Nobody is watching a browser for this one. */
async function spawnBuild(script: string): Promise<number> {
  const proc = Bun.spawn(["bun", script], {
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  return proc.exited;
}

/**
 * The one way to go from "the index should change" to "the index has changed".
 *
 * Owns the serialisation, so callers do not each invent their own guard.
 */
export class IndexRefresher {
  private readonly deps: RefreshDeps;
  private inFlight: Promise<RefreshOutcome> | null = null;

  constructor(deps: RefreshDeps) {
    this.deps = deps;
  }

  /** Is a refresh running right now? For `/api/health`, and for tests. */
  refreshing(): boolean {
    return this.inFlight !== null;
  }

  /**
   * Build, then adopt whatever was promoted.
   *
   * A second concurrent call does NOT start a second build -- it awaits the one already
   * running and gets its outcome with `joined: true`.
   */
  run(reason: string): Promise<RefreshOutcome> {
    const existing = this.inFlight;
    if (existing) {
      this.deps.log(`index refresh (${reason}) joined the one already running`);
      return existing.then((o) => ({ ...o, joined: true }));
    }

    const started = this.execute(reason).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = started;
    return started;
  }

  private async execute(reason: string): Promise<RefreshOutcome> {
    const { live, log, script } = this.deps;
    const t0 = Bun.nanoseconds();
    log(`index refresh starting (${reason})`);

    const runBuild = this.deps.runBuild ?? spawnBuild;
    const exitCode = await runBuild(script);
    log(`index refresh build exited ${exitCode}`);

    // A non-zero exit means a gate refused the build and `promote()` never ran, so the file
    // on disk is still the one already open. Reloading would be a wasted canary against our
    // own index -- and on the boot path there may be no engine to reload at all.
    if (exitCode !== 0) return { exitCode, ms: (Bun.nanoseconds() - t0) / 1e6 };

    // `open()` and `reload()` are deliberately different operations and the difference is
    // whether there is an outgoing engine whose file was renamed away. Asking the holder
    // rather than tracking it here keeps that rule in the one place that documents it.
    const reload = live.ready ? live.reload() : live.open();
    if (reload.swapped) this.deps.onSwapped?.();

    return { exitCode, reload, ms: (Bun.nanoseconds() - t0) / 1e6 };
  }
}

/**
 * Should this boot rebuild, and why?
 *
 * Returns `null` when the index is current, or when there is no index at all -- a missing
 * index is the boot BUILD's job and ordering a refresh for it would mean two builds racing
 * on one file.
 *
 * Split out from the wiring so the decision is testable without a server, and so the reason
 * string that reaches the log is the same string a test asserts on.
 */
export function staleIndexReason(cfg: Config): string | null {
  const p = paths(cfg);
  const stale = staleStagesOf(p.db, cfg);
  return stale.length > 0 ? `the open index is missing: ${describeStale(stale)}` : null;
}
