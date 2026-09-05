/**
 * The live index, swapped in place -- no restart, no downtime.
 *
 * The daily refresh already built, gated and promoted a new index file before this is
 * ever called (`src/jobs/build-index.ts`: build to a candidate, gate on volume, gate on
 * the 42-case canary, then `promote()` renames it over the live path). What was missing
 * was the last step: the running process went on holding the OLD file open and logged
 * "NOTE: restart to pick up the new index". This is that step.
 *
 * ## Why in-process rather than exit-and-let-Docker-restart
 *
 * The restart route was the documented plan for months because a second `SearchEngine`
 * used to cost ~550 MB -- a 205k-entry fuzzy pool and a 22k-trigram inverted index, both
 * rebuilt in RAM at boot -- and holding two at once would have breached the 1500m compose
 * limit. **That state no longer exists.** The `LEV` tier and its trigram index were
 * replaced by disk-backed `spellfix1` (see the header of `src/lib/search.ts`), which
 * removed a measured 1,514 MB and 14.5% of a core in GC. A second engine is now
 * approximately a second open file handle, so the option that was too expensive is now
 * the cheap one.
 *
 * It is also the safer change. A process that kills itself to reload cannot observe
 * whether its replacement came up, so `restart: unless-stopped` will happily restart
 * forever into an index that kills it at boot. Here a bad index is caught by a component
 * that is still running and can do something about it.
 *
 * ## The thing that is NOT true, and that this file was nearly built on
 *
 * The obvious design -- "validate the candidate, and if it is bad just keep serving the
 * engine we already have" -- **does not work, because the engine we already have is no
 * longer answering for the file it opened.** Once the live path has been renamed out from
 * under an open connection it usually throws `SQLITE_IOERR_VNODE` / "disk I/O error", and
 * the rest of the time it hands back yesterday's row with no error at all. The numbers,
 * and why the quiet outcome is the dangerous one, are on `reload()`.
 *
 * That also means the log line this code replaces -- *"restart to pick up the new index
 * (the engine holds the old file open)"* -- was describing a behaviour that does not
 * exist. The process was never reliably serving yesterday's index between the refresh and
 * a restart; it was erroring on most queries and lying on the rest.
 *
 * So a refusal has to RESTORE the previous file and open that, which is what `recover`
 * is for and what `rollback()` in `src/lib/index-builder.ts` was written for and never
 * called to do. See the warning on `reload()`.
 *
 * ## Synchronous on purpose, and that is what makes the retirement safe
 *
 * `bun:sqlite` is synchronous, so construction, `prepareFuzzy` and the canary all are.
 * That means a reload cannot interleave with a request or with another reload, and there
 * is no window in which the holder is half-swapped. The cost is that the event loop is
 * blocked for the length of the canary -- 42 real queries against the real index, which
 * is the same work `build-index.ts` already does on every refresh. Once a day, at
 * 09:00 UTC, that is a far better trade than a 15-second restart.
 *
 * It also settles a question this file used to answer the other way. **A handler can never
 * be INSIDE a call on the outgoing engine when the swap happens** -- one thread, no
 * yielding -- so closing that engine on the spot cannot race anybody. It can only be
 * BETWEEN calls, holding a reference it should not have held, which is precisely the case
 * we want to fail loudly. See `swap()`.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { runCanaryOn } from "../lib/canary";
import type { Config } from "../lib/config";
import { readMemoryUsage, type StorageTuning } from "../lib/memory-budget";
import { SearchEngine } from "../lib/search";

/**
 * `meta` that cannot throw, and that will not read an engine we do not trust.
 *
 * Two jobs, and the second one is newer than the first.
 *
 * The reporting path must never be the thing that fails. An engine whose file was replaced
 * UNDERNEATH it -- see the warning on `reload()` -- throws `SQLITE_IOERR_VNODE` on most
 * queries including this one, and a refusal that dies while composing its own explanation
 * takes the cron callback with it and kills every later refresh.
 *
 * But "most" is not "all", so a `try`/`catch` alone makes this the exact trap the rest of
 * this file exists to avoid: the same call returns `{}` or yesterday's numbers depending on
 * machine load, and `/api/health` reports whichever it got as fact. **Measured 2026-08-31,
 * 400 runs of the refusal path under load: 399 reported `builtAt: null`, 1 reported
 * `2026-08-30` with `rows: 1`.** That one run is not a better answer than the other 399 --
 * it is the same non-answer wearing a timestamp. Passing `null` for an engine whose file
 * has moved is how the caller says so, and it is why every refusal path below does.
 */
function safeMeta(engine: SearchEngine | null): Record<string, string> {
  if (!engine) return {};
  try {
    return engine.meta();
  } catch {
    return {};
  }
}

/**
 * `built_at` straight out of an index file, without building an engine for it.
 *
 * Deliberately a bare `Database` and one query: this runs before every reload to answer
 * "is this the file we already have open?", and answering it by constructing a
 * `SearchEngine` would mean paying the cost the question exists to avoid. Returns `null`
 * for a file that will not open or carries no `meta` -- the caller then goes on to the
 * real attempt, which is where a broken index should be diagnosed properly.
 */
function builtAtOf(path: string): string | null {
  try {
    const db = new Database(path, { readonly: true });
    try {
      const row = db.query("select value from meta where key = 'built_at'").get() as
        | { value: string }
        | undefined;
      return row?.value ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export interface ReloadOutcome {
  /** Are we serving a good index? False ONLY when a candidate was refused. */
  ok: boolean;
  /**
   * Did the reference actually move?
   *
   * `ok: true, swapped: false` is the common case and not a failure -- it means the file
   * on disk is the one already open, because the refresh found no upstream drift and
   * promoted nothing. Distinguishing the two is what keeps the daily no-op free: without
   * it, every refresh that changed nothing would still pay for a full canary run.
   */
  swapped: boolean;
  /** ISO timestamp of the attempt. */
  at: string;
  /** Wall time for construct + validate + swap. */
  ms: number;
  /** Why nothing was swapped -- a refusal, or simply that there was nothing new. */
  reason?: string;
  /** How the candidate scored. Absent when it did not construct at all. */
  canary?: { passed: number; total: number; ratio: number };
  /** `built_at` of the engine serving AFTER this attempt -- unchanged on a refusal. */
  builtAt: string | null;
  /** Row count of the engine serving after this attempt. */
  rows: number;
}

export interface LiveIndexOptions {
  path: string;
  cfg: Config;
  log?: (msg: string) => void;
  /**
   * Canary floor for a swap. Deliberately the same 0.9 the build gate uses -- a second,
   * looser number here would mean an index good enough to promote but not good enough to
   * serve, which is a state nobody wants to reason about.
   */
  floor?: number;
  /**
   * Put the PREVIOUS index file back at `path`, synchronously.
   *
   * Wired to `rollback()` from `src/lib/index-builder.ts`. Without it a refused candidate
   * leaves the process serving nothing at all -- see the vnode warning on `reload()` --
   * so this is not an optional nicety on the daily refresh path. It is optional only so a
   * test can exercise the no-rollback branch.
   */
  recover?: () => void;
  /**
   * Read the index into the OS page cache after opening or swapping it. Defaults to ON.
   *
   * Opt-OUT rather than opt-in because the machine that needs it least (an SSD dev box,
   * where it costs a second of background I/O) is the one a developer is looking at, and
   * the machine that needs it most is the unattended NAS nobody is watching. A test turns
   * it off so a fixture index is not read end to end on every construction.
   */
  prefault?: boolean;
  /**
   * Start with NO engine, because there is no index file yet.
   *
   * The boot-time build path (`./index-build.ts`) needs the server listening before an
   * index exists, so this holder has to have a state in which it is serving nothing. It is
   * opt-in rather than inferred from the file being absent: everywhere else, a missing
   * index is a fault and constructing quietly into a dead holder would hide it.
   *
   * While `ready` is false, `current` THROWS. Nothing is expected to catch that -- the
   * route gate in `./index.ts` refuses those requests before a handler runs, and this
   * throw is the backstop for a path that forgets to.
   */
  allowMissing?: boolean;
}

/**
 * Owns the one `SearchEngine` every handler reads through.
 *
 * Call sites MUST go through `current` at the moment of use rather than destructuring it
 * once at module scope -- that is what makes the swap invisible to them.
 */
export class LiveIndex {
  /** `null` ONLY before the first successful open on the `allowMissing` path. */
  private engine: SearchEngine | null;
  private readonly path: string;
  private readonly cfg: Config;
  private readonly log: (msg: string) => void;
  private readonly floor: number;
  private readonly recover?: () => void;
  private last: ReloadOutcome | null = null;
  /**
   * Has the file under `this.engine` been replaced by something else?
   *
   * Only ever true after a refused reload, because a successful one swaps to an engine
   * opened on the new file. While it is true this holder has no idea what it is serving,
   * and `meta()` says exactly that instead of asking an engine whose answer is a coin
   * flip. It is not a substitute for `recover` -- it is what stops the reporting path
   * from disagreeing with itself between two calls.
   */
  private fileMovedUnderUs = false;

  constructor(opts: LiveIndexOptions) {
    this.path = opts.path;
    this.cfg = opts.cfg;
    this.log = opts.log ?? (() => {});
    this.floor = opts.floor ?? 0.9;
    this.recover = opts.recover;
    this.prefault = opts.prefault ?? null;
    if (opts.allowMissing && !existsSync(this.path)) {
      this.engine = null;
    } else {
      this.engine = new SearchEngine(this.path, this.cfg);
      this.engine.prepareFuzzy((m) => this.log(m));
      // Say what was derived, ONCE, at the point it takes effect. The failure this replaces
      // was silent by construction: a container told to map 2 GB inside a 1.5 GB cgroup
      // logged nothing at all, and the only symptom was queries reading a disk nobody
      // thought they were touching.
      for (const note of this.engine.tuning.notes) this.log(`index tuning: ${note}`);
      this.warmPageCache();
    }
  }

  /**
   * Force the prefault on or off, or `null` to follow the engine's own derivation.
   *
   * `null` rather than `true`, because the answer now comes from `resolveTuning` over the
   * real memory budget and the real file size -- and the holder must not be a second opinion
   * about it. A test passes `false` to keep a fixture index off the page-cache read.
   */
  private readonly prefault: boolean | null;

  /** Whether to prefault right now: an explicit override, else the open engine's tuning. */
  private shouldPrefault(): boolean {
    return this.prefault ?? this.engine?.tuning.prefault ?? false;
  }

  /** The prefault in flight, so a swap during one does not start a second. */
  private warming: Promise<void> | null = null;

  /**
   * What the last prefault DID, for `/api/health`.
   *
   * The prefault is worth up to 32x on first reads from a spinning array and, until this
   * shipped, nothing outside a log line said whether it had run -- so a container serving
   * every query off the disk looked identical to a healthy one. `null` means it has not
   * completed (or was never going to), which is itself the thing worth alerting on.
   */
  private lastWarm: { readMb: number; ms: number; residentMb: number | null } | null = null;

  /** The prefault's own report, and the settings it ran under. Both `null` before an engine. */
  warmStatus(): {
    prefault: boolean;
    last: { readMb: number; ms: number; residentMb: number | null } | null;
    tuning: StorageTuning | null;
  } {
    return {
      prefault: this.shouldPrefault(),
      last: this.lastWarm,
      tuning: this.engine?.tuning ?? null,
    };
  }

  /**
   * Read the index file end to end, so the OS page cache holds it before a reader arrives.
   *
   * > [!IMPORTANT] This is the single biggest win available on SPINNING DISKS, and it is measured
   * > A query that misses the page cache pays a random seek per page it touches, and on a
   * > 7200rpm array that is ~10ms each. Measured on the deployment Synology -- a Celeron
   * > J4125 with nine SATA disks in RAID5 -- against a freshly cloned index the page cache
   * > had never read: **every scenario cost between 0.6 and 3.5 SECONDS cold**, against
   * > 0.02-49ms warm. `discover.topGenres` alone was 4,635ms cold and 13ms warm.
   * >
   * > Reading the whole file SEQUENTIALLY costs **2.41s at 303 MB/s** for a 730 MB index on
   * > that same array (0.17s once cached, at 4.2 GB/s). So one background read replaces the
   * > random-seek tax on every distinct query the first users happen to make. Sequential is
   * > the whole trick: a striped array is fast at it and terrible at the seeks it replaces.
   *
   * **Fire and forget, and deliberately not awaited.** The server must answer during it --
   * a request that arrives mid-warm is no worse off than it would have been with no warm at
   * all, because it competes for the same disk it was going to seek on anyway.
   *
   * **It also runs after a SWAP**, which is the case that is easy to miss: a promoted index
   * is a different inode the cache has never seen, so a nightly refresh would otherwise hand
   * every user the cold penalty back at 09:00 UTC.
   *
   * Not `posix_fadvise(WILLNEED)`, which is what this wants to be and which Bun does not
   * expose -- so the bytes are read into userspace and dropped. The extra cost is one memcpy
   * of the file, which is noise next to the seeks it removes.
   */
  private warmPageCache(): void {
    if (!this.shouldPrefault() || this.warming) return;
    const path = this.path;
    const t0 = Date.now();
    this.warming = (async () => {
      let bytes = 0;
      try {
        // Streamed rather than read whole: `Bun.file().arrayBuffer()` would hold the entire
        // index in the heap at once, which is exactly the 1,514 MB mistake the trigram index
        // made. The chunks here are discarded as they arrive and nothing accumulates.
        const stream = Bun.file(path).stream();
        for await (const chunk of stream) bytes += chunk.length;
      } catch (err) {
        // A warm that fails costs nothing but the warm -- the index is open and serving, and
        // the next reader simply pays the seeks it would have paid anyway.
        this.log(`index warm: skipped -- ${(err as Error).message}`);
        return;
      } finally {
        this.warming = null;
      }
      const ms = Date.now() - t0;
      /*
        REPORT WHAT STAYED, NOT WHAT WAS READ, because under a memory cap they are different
        numbers and the difference is invisible from inside the process.

        This line used to say "1892 MB into the page cache" unconditionally. On the live
        deployment -- a 1.5 GB cgroup serving an 1,892 MB index -- roughly a fifth of that had
        already been reclaimed by the time the line was written, and the log was the only place
        anybody would have looked. Reading the cgroup back turns a claim into a measurement.
        Where there is no cgroup to read, it says only what it did.
      */
      const resident = readMemoryUsage().cacheMb;
      this.lastWarm = { readMb: Math.round(bytes / 1e6), ms, residentMb: resident };
      this.log(
        `index warm: read ${(bytes / 1e6).toFixed(0)} MB in ${(ms / 1000).toFixed(1)}s ` +
          `(${(bytes / 1e6 / (ms / 1000)).toFixed(0)} MB/s)` +
          (resident === null ? "" : `; ${resident} MB resident in the page cache afterwards`),
      );
    })();
  }

  /**
   * The engine to serve this request from. Never cache it across an `await`.
   *
   * Throws while `ready` is false, which happens only on the boot-build path before the
   * first index exists. A handler must never reach this in that state -- the route gate
   * refuses first -- so the throw is a backstop, not a case to handle.
   */
  /**
   * The current engine's raw handle, for a caller that needs SQL the engine does not expose.
   *
   * Goes through the holder for the same reason every other read does: it is the one owner
   * of which file is live, so a caller that asks HERE at the moment of use can never be
   * left holding a connection to a file that has been renamed out from under it.
   */
  rawDb(): Database {
    return this.current.rawDb;
  }

  get current(): SearchEngine {
    if (!this.engine) {
      throw new Error("no title index is open yet -- the boot-time build has not finished");
    }
    return this.engine;
  }

  /** Is there an engine to serve from at all? False only before the first index exists. */
  get ready(): boolean {
    return this.engine !== null;
  }

  /**
   * Open the index for the FIRST time, once something else has produced the file.
   *
   * Deliberately separate from `reload()` rather than a branch inside it. `reload()` is
   * about a file that was replaced UNDERNEATH an open connection, and every hard-won rule
   * in it -- `fileMovedUnderUs`, the rollback, the refusal to trust the engine it already
   * holds -- describes that situation and none of them are true here. There is no outgoing
   * engine, nothing to roll back to, and a refusal simply leaves us where we already are.
   *
   * The canary still runs. The build gated on it before promoting, so this can only fail if
   * the file changed between the gate and here -- but validating what we are about to serve
   * costs one pass and is the same bar `reload()` applies.
   */
  open(): ReloadOutcome {
    const t0 = Bun.nanoseconds();
    const at = new Date().toISOString();
    const result = this.attempt();

    if (!("engine" in result)) {
      this.log(`index open REFUSED -- ${result.error}`);
      const out: ReloadOutcome = {
        ok: false,
        swapped: false,
        at,
        ms: (Bun.nanoseconds() - t0) / 1e6,
        reason: result.error,
        canary: result.canary,
        builtAt: null,
        rows: 0,
      };
      this.last = out;
      return out;
    }

    this.swap(result.engine);
    const meta = safeMeta(result.engine);
    const out: ReloadOutcome = {
      ok: true,
      swapped: true,
      at,
      ms: (Bun.nanoseconds() - t0) / 1e6,
      canary: result.canary,
      builtAt: meta.built_at ?? null,
      rows: Number(meta.rows ?? 0),
    };
    this.last = out;
    this.log(
      `index opened -- ${out.rows.toLocaleString()} titles, built ${out.builtAt ?? "?"}, ` +
        `canary ${result.canary?.passed}/${result.canary?.total}, ${out.ms.toFixed(0)}ms.`,
    );
    return out;
  }

  /** What the last reload attempt did, or `null` if none has run in this process. */
  get lastReload(): ReloadOutcome | null {
    return this.last;
  }

  /**
   * The fuzzy pool's own report, or `null` while there is no engine to ask.
   *
   * > [!CAUTION] This exists because two call sites read `live.current` on the boot-build
   * > path and BOTH took the container down. Measured in Docker on 2026-09-01.
   * > A data directory with no `titles.db` exited 1 within seconds of boot, every time, on
   * > `main` as well as on the branch that found it -- and under `restart: always` that is
   * > a crash loop rather than a slow start. `ResourceMonitor`'s callback asks for these
   * > stats on a timer, and `/api/health` builds them into every response including the
   * > anonymous one. Both ran while the boot build was still going, when `current` throws
   * > by design. So `refreshOnBoot` and the progress page it exists to serve were
   * > unreachable: nothing lived long enough to render them.
   * >
   * > The note in the project brief saying the cold-boot path had never been run live was
   * > the only thing keeping this hidden, and running it is what found it.
   *
   * The holder answers this rather than each caller checking `ready` first, for the same
   * reason `meta()` does: it is the one thing that knows whether there is an engine, and
   * "ask the engine, but only if there is one" is precisely the rule two call sites got
   * wrong. `null` is the shape a caller must handle -- there is no pool to report on.
   */
  poolStats(): string | null {
    if (!this.engine || this.fileMovedUnderUs) return null;
    try {
      return this.engine.poolStats();
    } catch {
      // Same rule as `safeMeta`: a diagnostic must never be the thing that fails.
      return null;
    }
  }

  /**
   * `meta` of whatever is serving right now, as `/api/health` reports it.
   *
   * Empty once a reload has been refused: at that point the file we opened is not the file
   * at `path`, and the only honest report is that we cannot say. `index.reload.reason`
   * beside it carries what went wrong.
   */
  meta(): Record<string, string> {
    return safeMeta(this.fileMovedUnderUs ? null : this.engine);
  }

  /** Open the live path, prove the engine answers, and hand it back unswapped. */
  private attempt():
    | { engine: SearchEngine; canary?: ReloadOutcome["canary"] }
    | { error: string; canary?: ReloadOutcome["canary"] } {
    let candidate: SearchEngine;
    try {
      candidate = new SearchEngine(this.path, this.cfg);
      candidate.prepareFuzzy();
    } catch (err) {
      return { error: `it would not open: ${(err as Error).message}` };
    }

    let canary: ReloadOutcome["canary"];
    try {
      const res = runCanaryOn(candidate, this.floor);
      canary = { passed: res.passed, total: res.total, ratio: res.ratio };
      if (!res.ok) {
        candidate.close();
        const misses = res.failures
          .slice(0, 3)
          .map((f) => `"${f.query}" wanted ~${f.want}, got ${f.got}`)
          .join("; ");
        return {
          error:
            `canary ${res.passed}/${res.total} is below the ${(res.floor * 100).toFixed(0)}% floor -- ${misses}` +
            // Say what was NOT measured before the reader reasons about what was.
            (res.degraded ? ` (${res.degraded})` : ""),
          canary,
        };
      }
    } catch (err) {
      candidate.close();
      return { error: `it opened but could not answer: ${(err as Error).message}`, canary };
    }

    return { engine: candidate, canary };
  }

  /**
   * Open the file at `path` again, prove it answers, and serve from it.
   *
   * > [!WARNING] **After `promote()` the engine we are already holding is UNUSABLE -- but
   * > it fails in TWO ways, and the quiet one is the dangerous one.**
   * >
   * > Measured on 2026-08-31 against a real `SearchEngine` and the real promote (rename
   * > ours aside, rename the candidate in), 40 trials on an idle machine: **40/40 threw**
   * > `SQLITE_IOERR_VNODE` / "disk I/O error". SQLite pins the inode it opened.
   * >
   * > **Under CPU load the same code returns the STALE ROW instead, with no error at
   * > all.** Same measurement, same day, with the machine busy: the retired engine handed
   * > back `{tconst: "tt-before", title: "Before"}` -- yesterday's index, silently -- on
   * > **4 of 14 runs**, against **0 of 15** on an idle machine. It is a race, not a
   * > constant: the open connection can serve the page it already cached without ever
   * > touching the filesystem, and so never discovers the file moved.
   * >
   * > This CORRECTS the wording that stood here until 2026-08-31, which
   * > said **every** call throws and cited the same test as proof. That claim was measured
   * > honestly and was true of every run somebody happened to watch, but it was measured
   * > on an idle machine, and it is what made `live-index.test.ts` flake roughly one run
   * > in three under load. **Observed facts beat a documented claim, including this one:
   * > re-measure before trusting the numbers above.**
   * >
   * > **The consequence, and it is worse than the old wording implied.** A loud error is
   * > caught by any error path at all. A stale row is caught by NOTHING in this tree: it
   * > is a well-formed answer from yesterday's index, and no caller can tell it apart from
   * > a correct one. So the danger of a retired engine is not that it stops working -- it
   * > is that it sometimes appears to.
   *
   * > **The one thing a retired engine never does is answer out of the PROMOTED file.**
   * > Measured 2026-08-31 under load, 1,000 first-reads through a retired engine across
   * > five read paths -- cached statement, a fresh parameter, `meta()`, `search()` and a
   * > statement the connection had never prepared: **918 threw, 82 answered, and all 82
   * > answered out of the pre-promote file.** No read path is reliably fatal, so there is
   * > no probe that tells you which mode you are in; and once one call throws, that
   * > connection never answers again. That disjunction -- *throws, or serves the old file,
   * > never the new one* -- is the only invariant here, and it is what
   * > `live-index.test.ts` now pins instead of the coin flip it used to assert.
   *
   * The consequence for this method is unchanged: **"refuse the candidate and keep the old
   * engine" is not an available outcome.** The old engine either errors or lies, and
   * neither is serving. A refusal must RESTORE the previous file and open that instead,
   * which is exactly the job `rollback()` in `src/lib/index-builder.ts` was written for and
   * never called to do.
   *
   * What IS new: a refusal now also stops this holder quoting that engine's numbers (see
   * `meta()`), and a successful swap closes the outgoing engine immediately rather than a
   * minute later (see `swap()`), so a handler holding a stale reference fails loudly
   * instead of sometimes serving yesterday.
   */
  reload(): ReloadOutcome {
    const t0 = Bun.nanoseconds();
    const at = new Date().toISOString();
    // `null` for "there is no engine whose numbers we are willing to quote" -- see
    // `safeMeta`. Every refusal below passes it, and that is what makes `builtAt` on a
    // refusal a constant instead of a 1-in-400 coin flip.
    const finish = (
      o: Pick<ReloadOutcome, "ok" | "swapped" | "reason" | "canary">,
      engine: SearchEngine | null,
    ): ReloadOutcome => {
      const meta = safeMeta(engine);
      const out: ReloadOutcome = {
        ...o,
        at,
        ms: (Bun.nanoseconds() - t0) / 1e6,
        builtAt: meta.built_at ?? null,
        rows: Number(meta.rows ?? 0),
      };
      this.last = out;
      return out;
    };

    // Is there anything new at all? The refresh exits 0 both when it promoted a build and
    // when it found no upstream drift, so without this check the daily no-op would pay for
    // a full 42-query canary and a pointless swap. It is also the ONLY path on which the
    // engine we hold is still known-good, because nothing was renamed under it.
    const onDisk = builtAtOf(this.path);
    if (onDisk !== null && onDisk === (this.meta().built_at ?? null)) {
      this.log(`index reload skipped -- the index on disk is the one already open (built ${onDisk}).`);
      return finish({ ok: true, swapped: false, reason: `unchanged on disk (built ${onDisk})` }, this.engine);
    }

    // Past that check, the file at `path` is NOT the file this engine opened -- either it
    // was promoted over, or it stopped being readable. Either way this holder can no
    // longer say what it is serving, and it must not pretend otherwise while it finds out.
    // A successful swap below clears it, because that engine opened the file that is there.
    this.fileMovedUnderUs = true;

    const first = this.attempt();
    if ("engine" in first) {
      this.swap(first.engine);
      const out = finish({ ok: true, swapped: true, canary: first.canary }, first.engine);
      this.log(
        `index reloaded in place -- ${out.rows.toLocaleString()} titles, built ${out.builtAt ?? "?"}, ` +
          `canary ${first.canary?.passed}/${first.canary?.total}, ${out.ms.toFixed(0)}ms. No restart.`,
      );
      return out;
    }

    this.log(`index reload REFUSED -- the promoted index is no good: ${first.error}`);

    // The promoted index is bad AND the engine we hold no longer answers for the file it
    // opened, so standing pat leaves the server erroring on most requests and quietly
    // serving yesterday on the rest. Put the previous file back.
    if (!this.recover) {
      this.log(
        "no rollback is configured -- the process is now serving a broken index and must be restarted.",
      );
      return finish({ ok: false, swapped: false, reason: first.error, canary: first.canary }, null);
    }

    try {
      this.recover();
    } catch (err) {
      this.log(`rollback FAILED -- ${(err as Error).message}. Restart required.`);
      return finish(
        { ok: false, swapped: false, reason: `${first.error}; rollback failed`, canary: first.canary },
        null,
      );
    }

    const second = this.attempt();
    if (!("engine" in second)) {
      this.log(`the restored index is no good either: ${second.error}. Restart required.`);
      return finish(
        { ok: false, swapped: false, reason: `${first.error}; restored index also bad: ${second.error}` },
        null,
      );
    }

    this.swap(second.engine);
    const out = finish(
      { ok: true, swapped: true, reason: `rolled back after: ${first.error}`, canary: second.canary },
      second.engine,
    );
    this.log(
      `ROLLED BACK to the previous index -- ${out.rows.toLocaleString()} titles, built ${out.builtAt ?? "?"}. ` +
        "Serving again without a restart.",
    );
    return out;
  }

  /**
   * Point `current` at a new engine and CLOSE the old one, on the spot.
   *
   * > [!IMPORTANT] The close is immediate, and that is the whole defence
   * > This used to defer for `CLOSE_GRACE_MS` (60 s), on the reasoning that a handler
   * > which read `current` before the swap and resumed after an `await` "will get a
   * > clearer error from a stale connection than from one this method closed under it".
   * > Both halves of that turned out to be wrong.
   * >
   * > **A stale connection is not a clearer error. It is not reliably an error at all.**
   * > Measured 2026-08-31, 1,000 reads through a retired engine under load: **918 threw
   * > `SQLITE_IOERR_VNODE`, 82 answered** -- and every one of the 82 answered out of the
   * > PRE-promote file. So the grace window was 60 seconds during which a mistaken handler
   * > had roughly a 1-in-12 chance of serving yesterday's data with a 200. Closing first
   * > makes it `Cannot use a closed database`, **300 times out of 300**, and turns a
   * > silent wrong answer back into a loud one.
   * >
   * > **Nothing can be mid-call when this runs.** `bun:sqlite` is synchronous and this is
   * > one thread, so `reload()` cannot interleave with a request -- see the header. A
   * > handler is either before its call (and will read `current`, which is `next`) or
   * > after it. There is no in-flight statement for a close to race, which is what the old
   * > comment was guarding against and what cannot happen here.
   * >
   * > The "one path where the outgoing engine IS healthy" the old comment reserved for
   * > does not exist either: `reload()` only reaches a swap once `built_at` on disk
   * > differs from the engine's own, which means the file was replaced.
   */
  private swap(next: SearchEngine): void {
    const outgoing = this.engine;
    this.engine = next;
    this.fileMovedUnderUs = false;
    // A promoted index is a DIFFERENT INODE the page cache has never read, so without this
    // the nightly refresh hands every reader the cold-disk penalty back at 09:00 UTC --
    // 0.6 to 3.5 seconds a query on the deployment array. See `warmPageCache`.
    this.warmPageCache();
    // `null` on the first open of a boot-time build -- there was never an engine to retire.
    if (!outgoing) return;
    try {
      outgoing.close();
    } catch {
      // A handle that is already gone is the outcome we wanted anyway. Measured harmless:
      // `close()` on an engine whose file was renamed away neither throws nor complains,
      // and a second `close()` is a no-op.
    }
  }

  /**
   * Shutdown must not throw. A handle whose file was replaced underneath it fails on
   * close as readily as on query, and `SIGTERM` turning into a stack trace would make a
   * clean stop look like a crash in `docker logs`.
   */
  close(): void {
    try {
      this.engine?.close();
    } catch {
      // Already gone, or gone unreachable. Either way there is nothing left to release.
    }
  }
}
