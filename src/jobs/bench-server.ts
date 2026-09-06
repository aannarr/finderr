/**
 * Booting a real finderr to measure it, and a second one from an older commit to compare.
 *
 * ## Why every route bench drives a live server
 *
 * The number worth having is the one a browser waits for, which includes routing, `withAuth`,
 * `withTiming`, JSON serialisation and the loopback. Handlers are not exported and there is no
 * reason to export them. And the BEFORE arm has to be a second live server built from
 * `git archive <ref>`, because arithmetic on separately-timed parts is not a before/after.
 *
 * This file is that plumbing and nothing else -- it knows how to start a server, how to
 * materialise an old tree, how to read the server's own timings and how to take a percentile.
 * What to measure and what to assert about it belongs to each bench: `bench-requests.ts` is
 * the request log, `bench-discover.ts` is the front page.
 *
 * It was extracted when the second bench needed the same four things. One owner for "how do we
 * boot the thing we are measuring" is what stops two benches drifting into measuring two
 * subtly different servers and reporting both as finderr.
 */

import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * The admin bearer token a bench hands its servers, so it can read their own instruments.
 *
 * `/api/health` serves `timings` only to an admin, and the obvious way to be one -- making the
 * no-auth account an admin -- would change what is being measured, since several routes answer
 * an admin differently. The system API key is an admin principal that the SESSION is not, so
 * the samples stay an ordinary reader's while the instrument stays readable.
 *
 * A constant rather than a secret: the bench process mints it, hands it to children on
 * 127.0.0.1, and kills them. It is padded to clear the 24-character floor `validate()` puts on
 * any admin key, which the server refuses to boot under.
 */
export const BENCH_ADMIN_KEY = "bench-admin-key-for-localhost-only";

/** A running finderr, and the only safe way to stop it. */
export interface Instance {
  url: string;
  stop(): Promise<void>;
}

export interface BootOptions {
  /** Checkout to run. `import.meta.dir/../..` for HEAD, or a tree from `materialiseTree`. */
  tree: string;
  dataDir: string;
  port: number;
  /** Anything on top of the defaults below -- `FINDERR_NO_AUTH`, a feature flag, a key. */
  env?: Record<string, string>;
}

/**
 * Boot one finderr and wait until it answers.
 *
 * `/api/health` is the readiness probe because it is the one route that answers an
 * unauthenticated caller -- which is exactly what a bench's no-auth-off red proof is.
 *
 * Every upstream is blanked by default so no reconcile pass, calendar sync or trending fetch
 * can add network time to a sample. A bench that wants one back sets it in `env`.
 *
 * > [!IMPORTANT] SIGTERM and then WAIT, never a hard kill
 * > A SIGKILL mid-WAL-checkpoint overwrote page 1 of the real `finderr.db` twice. A bench's
 * > database is scratch and could be thrown away, but the shutdown path is not worth having
 * > two spellings of, and a bench that teaches the wrong one is worse than no bench.
 */
export async function boot(opts: BootOptions): Promise<Instance> {
  const child = Bun.spawn(["bun", join(opts.tree, "src/server/index.ts")], {
    cwd: opts.tree,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      FINDERR_DATA_DIR: opts.dataDir,
      FINDERR_PORT: String(opts.port),
      FINDERR_HOST: "127.0.0.1",
      FINDERR_ADMIN_API_KEY: BENCH_ADMIN_KEY,
      FINDERR_RADARR_URL: "",
      FINDERR_SONARR_URL: "",
      FINDERR_PROWLARR_URL: "",
      FINDERR_PLEX_URL: "",
      ...opts.env,
    },
  });

  const url = `http://127.0.0.1:${opts.port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `server at ${opts.tree} exited ${child.exitCode}: ${await new Response(child.stderr).text()}`,
      );
    }
    try {
      if ((await fetch(`${url}/api/health`)).ok) {
        return {
          url,
          stop: async () => {
            child.kill("SIGTERM");
            await child.exited;
          },
        };
      }
    } catch {
      // Not listening yet. The deadline above is the only thing that gives up.
    }
    await Bun.sleep(150);
  }
  child.kill("SIGTERM");
  throw new Error(`server at ${opts.tree} never became ready on ${opts.port}`);
}

/**
 * A tree at `ref`, extracted with `git archive` and lent this checkout's dependencies.
 *
 * `git archive` rather than `git worktree add`, deliberately: a worktree is git state in the
 * shared checkout that somebody then has to remove, and this needs nothing but the bytes. The
 * two symlinks are what make the extracted tree runnable without a second `bun install` --
 * both are read-only to the child.
 */
export async function materialiseTree(ref: string, dest: string, here: string): Promise<string> {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const archive = Bun.spawn(["git", "archive", ref], { cwd: here, stdout: "pipe", stderr: "pipe" });
  const untar = Bun.spawn(["tar", "-x", "-C", dest], { stdin: archive.stdout, stderr: "pipe" });
  if ((await untar.exited) !== 0 || (await archive.exited) !== 0) {
    throw new Error(`could not extract ${ref}: ${await new Response(archive.stderr).text()}`);
  }
  // `vendor/` is tracked and arrives in the archive; `node_modules` never is. Lending only
  // what the extract did not bring keeps this true whichever way that goes in future.
  for (const shared of ["node_modules", "vendor"]) {
    if (existsSync(join(here, shared)) && !existsSync(join(dest, shared))) {
      symlinkSync(join(here, shared), join(dest, shared));
    }
  }
  return dest;
}

/** Running totals for one route out of a server's own `Timings`, read over the admin key. */
export interface HandlerTotals {
  n: number;
  totalMs: number;
}

/**
 * What the SERVER thinks it spent on `route`, cumulatively.
 *
 * `withTiming` keys on the route PATTERN, so every shape of one route lands in one bucket --
 * which is why this returns running totals and the caller diffs them around each arm rather
 * than reading a per-arm number that does not exist.
 *
 * It exists because the client's wall clock includes reading the body, and a change that makes
 * the body bigger is not the same finding as one that makes the handler slower.
 */
export async function handlerTotals(url: string, route: string): Promise<HandlerTotals> {
  const res = await fetch(`${url}/api/health`, { headers: { Authorization: `Bearer ${BENCH_ADMIN_KEY}` } });
  const body = (await res.json()) as {
    timings?: { requests?: Record<string, HandlerTotals> };
  };
  const entry = body.timings?.requests?.[route];
  if (!entry) throw new Error(`${url}/api/health served no timings for ${route} -- key not accepted?`);
  return { n: entry.n, totalMs: entry.totalMs };
}

/** The `q`-quantile of a sample, e.g. `quantile(ms, 0.5)` for the median. */
export function quantile(times: readonly number[], q: number): number {
  const sorted = [...times].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
}
