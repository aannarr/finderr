/**
 * Building the title index while the server is already answering.
 *
 * A fresh install has no `titles.db`, and until 2026-08-31 that was fatal: the process
 * printed a two-line remedy and exited 1. Under `restart: always` that becomes a crash
 * loop, and `docker compose exec` cannot break it -- the thing that would stop the
 * restarting is the command being attempted. The documented escape was `docker compose
 * run --rm finderr bun src/jobs/build-index.ts`, which is a step nobody guesses.
 *
 * So: `index.refreshOnBoot` now means what its name says. No index and the flag on, and the
 * server comes up anyway, serves a page explaining itself, and builds one.
 *
 * > [!IMPORTANT] The build runs as a SUBPROCESS, and that is not a style choice
 * > `buildIndex` streams its dumps with `for await`, so it does yield -- but the SQLite
 * > writes between those yields are synchronous, and the whole job is 103 s on a Mac and
 * > **376 s on the Synology**. Running it in this process would mean the progress page it
 * > exists to serve stutters for six minutes, and `/api/health` blocks with it, so the
 * > container would fail its own healthcheck while doing exactly what it was told.
 * >
 * > Spawning is also the SAME code path an operator runs by hand and the same one the daily
 * > refresh already uses (see the `Bun.cron` block in `./index.ts`). One builder, three
 * > callers, no second implementation to drift.
 *
 * What this module does NOT do: decide when to build, or what to do afterwards. It spawns,
 * it reports, and it resolves. Adopting the finished index is `LiveIndex.open()`'s job.
 */

/** Where a boot-time build has got to. `phase` is the only thing a client needs to branch on. */
export interface IndexBuildState {
  /**
   * `building` while the child runs, `done` once it exited 0, `failed` otherwise.
   *
   * There is deliberately no `idle`: this state only exists once a build has been started,
   * and a server with an index has no `IndexBuild` at all.
   */
  phase: "building" | "done" | "failed";
  /** When the child was spawned. */
  startedAt: string;
  /** How long it has been running, or how long it took. */
  elapsedMs: number;
  /** Exit code, once there is one. */
  exitCode: number | null;
  /**
   * The most recent progress line, already trimmed of the job's `\r` redraws.
   *
   * ONE line rather than the whole log: this is rendered on a page an anonymous visitor can
   * reach before anybody has signed in, so it must carry no path, no host and no credential.
   * The build job's own lines are percentages and gate verdicts, which are safe -- but the
   * cap is what keeps that true if the job ever grows a chattier line.
   */
  lastLine: string | null;
}

/** Everything `IndexBuild` needs, so a test can hand it a fake child instead of a process. */
export interface IndexBuildOptions {
  /** Absolute path to `build-index.ts`. */
  script: string;
  log: (msg: string) => void;
  /** Injected by tests. Defaults to `Bun.spawn`. */
  spawn?: (cmd: string[]) => IndexBuildChild;
  /** Injected by tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** The slice of a spawned process this uses. `Bun.spawn`'s return satisfies it as-is. */
export interface IndexBuildChild {
  readonly exited: Promise<number>;
  readonly stdout: ReadableStream<Uint8Array> | number | null | undefined;
  readonly stderr: ReadableStream<Uint8Array> | number | null | undefined;
  kill(): void;
}

/**
 * A single boot-time index build, and the progress a page can poll.
 *
 * One per process and not restartable: a failed build is an operator problem, and quietly
 * retrying a job that downloads 235 MB would turn one bad afternoon into a bandwidth bill.
 * The failure is reported and stays reported.
 */
export class IndexBuild {
  private readonly opts: Required<Pick<IndexBuildOptions, "script" | "log">> &
    Pick<IndexBuildOptions, "spawn" | "now">;
  private readonly startedAtMs: number;
  private readonly startedAt: string;
  private child: IndexBuildChild | null = null;
  private phase: IndexBuildState["phase"] = "building";
  private exitCode: number | null = null;
  private finishedAtMs: number | null = null;
  private lastLine: string | null = null;

  /** Resolves with the child's exit code. Never rejects -- a spawn failure resolves non-zero. */
  readonly exited: Promise<number>;

  constructor(opts: IndexBuildOptions) {
    this.opts = opts;
    const now = opts.now ?? Date.now;
    this.startedAtMs = now();
    this.startedAt = new Date(this.startedAtMs).toISOString();
    this.exited = this.run();
  }

  private async run(): Promise<number> {
    const spawn =
      this.opts.spawn ??
      ((cmd: string[]) =>
        Bun.spawn(cmd, {
          // Piped rather than inherited, because the progress line has to reach the page.
          // The daily refresh inherits instead -- nobody is watching a browser for that one.
          stdout: "pipe",
          stderr: "pipe",
          env: process.env,
        }) as IndexBuildChild);

    try {
      this.child = spawn(["bun", this.opts.script]);
    } catch (err) {
      this.opts.log(`index build could not start: ${(err as Error).message}`);
      return this.finish(1);
    }

    // Both streams, because the job splits its output: gate verdicts and totals go to
    // stdout, and the download percentage is written to stderr with a `\r` so it redraws
    // in place. Losing stderr would lose the only progress there is for the first minute.
    const pumps = [this.child.stdout, this.child.stderr]
      .filter((s): s is ReadableStream<Uint8Array> => s instanceof ReadableStream)
      .map((stream) => this.pump(stream));

    const code = await this.child.exited;
    // Drain what is left before reporting, so the final line is the one the job meant to
    // leave on screen rather than whatever happened to have flushed.
    await Promise.all(pumps).catch(() => {});
    return this.finish(code);
  }

  /** Read a stream to the end, keeping only the newest non-empty line. */
  private async pump(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      // `\r` as well as `\n`: the download progress redraws in place and would otherwise
      // arrive as one unbounded line that never ends until the dump finishes.
      const parts = buffer.split(/[\r\n]+/);
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const line = part.trim();
        if (line) this.lastLine = line;
      }
    }
    const tail = buffer.trim();
    if (tail) this.lastLine = tail;
  }

  private finish(code: number): number {
    this.exitCode = code;
    this.finishedAtMs = (this.opts.now ?? Date.now)();
    this.phase = code === 0 ? "done" : "failed";
    this.opts.log(
      code === 0
        ? `index build finished in ${Math.round(this.elapsedMs() / 1000)}s -- opening it now`
        : `index build FAILED (exit ${code}). The server is up but has nothing to search. ` +
            `Its output is above; fix the cause and restart.`,
    );
    return code;
  }

  private elapsedMs(): number {
    const end = this.finishedAtMs ?? (this.opts.now ?? Date.now)();
    return end - this.startedAtMs;
  }

  get state(): IndexBuildState {
    return {
      phase: this.phase,
      startedAt: this.startedAt,
      elapsedMs: this.elapsedMs(),
      exitCode: this.exitCode,
      lastLine: this.lastLine,
    };
  }

  /** Stop the child, for shutdown. Safe to call when it never started or already exited. */
  stop(): void {
    try {
      this.child?.kill();
    } catch {
      // Already gone. Nothing to release.
    }
  }
}

/**
 * Refuse every route that would need an index, for as long as there is not one.
 *
 * > [!IMPORTANT] This wraps OUTSIDE `withAuth`, and the order is the decision
 * > Inside it, an anonymous caller during a build would get 401 -- an answer about their
 * > credentials for a server that has no data to protect yet, and one that sends them
 * > hunting for a sign-in problem they do not have. Outside it, everyone gets the same
 * > 503 naming the real reason. Nothing is disclosed by that: the progress page is public
 * > and says the same thing in prose.
 *
 * Only `/api/health` and `/api/index-status` survive. The container probe needs the first
 * and the progress page needs the second; every other route either reads the index or
 * belongs to a sign-in that has nothing to sign in to yet.
 */
export function withIndexGate<T extends Record<string, unknown>>(
  routes: T,
  opts: { ready: () => boolean; state: () => IndexBuildState | null; open: readonly string[] },
): T {
  const open = new Set(opts.open);

  // Variadic inside, generic outside -- the same shape as `withAuth`, and for the same
  // reason: a `Record<string, Handler>` parameter would erase Bun's `req.params` inference
  // for every route in the table.
  const wrap =
    (path: string, handler: (...args: never[]) => unknown) =>
    (...args: unknown[]): unknown => {
      if (open.has(path) || opts.ready()) {
        return (handler as (...a: unknown[]) => unknown)(...args);
      }
      return Response.json(
        { error: "the title index is still being built", build: opts.state() },
        { status: 503, headers: { "Retry-After": "10" } },
      );
    };

  const out: Record<string, unknown> = {};
  for (const [path, entry] of Object.entries(routes)) {
    if (typeof entry === "function") {
      out[path] = wrap(path, entry as (...args: never[]) => unknown);
      continue;
    }
    if (entry && typeof entry === "object") {
      const methods: Record<string, unknown> = {};
      for (const [method, handler] of Object.entries(entry as Record<string, unknown>)) {
        methods[method] = wrap(path, handler as (...args: never[]) => unknown);
      }
      out[path] = methods;
      continue;
    }
    out[path] = entry;
  }
  return out as T;
}

/**
 * The page every path gets while there is no index, as ONE self-contained document.
 *
 * Deliberately not a third vite entry beside `index.html` and `login.html`. It is shown
 * once in an installation's lifetime, it needs no router and no component, and adding a
 * bundle for it would mean the build has to have succeeded before the page that explains
 * why the build has not succeeded can render.
 *
 * It says nothing an anonymous visitor should not see: no path, no host, no version. The
 * progress line comes from the build job, which prints percentages and gate verdicts.
 */
export function buildingPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Preparing</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         background:#0b0d10; color:#e6e8eb;
         font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width:34rem; padding:2rem; text-align:center; }
  h1 { font-size:1.25rem; font-weight:600; margin:0 0 .75rem; }
  p { margin:0 0 1rem; color:#9aa4b2; }
  .bar { height:2px; background:#1c2229; border-radius:2px; overflow:hidden; margin:1.5rem 0; }
  .bar i { display:block; height:100%; width:40%; background:#5b8def; border-radius:2px;
           animation:slide 1.6s ease-in-out infinite; }
  @keyframes slide { 0%{transform:translateX(-100%)} 100%{transform:translateX(250%)} }
  code { display:block; font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;
         color:#7d8794; word-break:break-word; min-height:1.5em; }
  .failed .bar i { animation:none; width:100%; background:#c9564f; }
</style>
</head>
<body>
<main id="m">
  <h1 id="h">Building the search index</h1>
  <p id="p">This happens once, on a new installation. It takes a few minutes; the page refreshes itself.</p>
  <div class="bar"><i></i></div>
  <code id="l"></code>
</main>
<script>
// Poll rather than hold a socket: the server is about to swap its index in, and a page
// waiting on a long-lived connection is one more thing to reason about during that.
async function tick() {
  try {
    const r = await fetch('/api/index-status', { headers: { accept: 'application/json' } });
    const s = await r.json();
    if (s.ready) { location.reload(); return; }
    document.getElementById('l').textContent = s.build && s.build.lastLine ? s.build.lastLine : '';
    if (s.build && s.build.phase === 'failed') {
      document.getElementById('m').className = 'failed';
      document.getElementById('h').textContent = 'The index build failed';
      document.getElementById('p').textContent =
        'The server is running but has nothing to search. The cause is in the server log.';
      return;
    }
  } catch (e) { /* the server may be busy swapping the index in; try again */ }
  setTimeout(tick, 2000);
}
tick();
</script>
</body>
</html>`;
}
