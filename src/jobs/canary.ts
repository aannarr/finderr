#!/usr/bin/env bun
/**
 * Run the canary suite against an index and say whether it still passes.
 *
 * ```
 * bun run canary                     # the configured index
 * bun run canary path/to/titles.db   # some other one -- a candidate, a colleague's copy
 * ```
 *
 * THE POINT OF THIS FILE IS THAT IT EXISTS. `.claude/CLAUDE.md` calls the canary both the
 * search regression suite and a build gate that must stay at 100%, and until now the only
 * ways to run it were to trigger a full index build or to hand-write a throwaway script --
 * so a card whose acceptance says "canary unchanged" was asking for something no documented
 * command could produce. It answers in about two seconds against the real 1.27M-row index.
 *
 * DELIBERATELY NOT PART OF `bun run test`, and that is still right: it needs a built index,
 * which CI, the Docker build and a fresh worktree do not have, so a red `bun run test` there
 * would be red for the wrong reason -- the exact defect this job's own degraded-tier
 * reporting exists to end.
 *
 * **`bun run gate` runs it anyway, and that is the difference.** Staying out of `test` was
 * read as staying out of every gate, so for a long time nothing ran these queries except an
 * index build -- a gate on the DATA and never on the CODE. `src/jobs/gate.ts` runs the four
 * commands and then this one, treating the exit 2 below as "NOT MEASURED, loudly" rather than
 * as either a pass or a failure.
 *
 * Exits 0 when the suite is at or above the floor and 1 when it is not, so it works in a
 * gate and not only by eye. A missing index file is exit 2: "I could not measure" is a
 * different answer from "I measured and it is bad".
 */

import { runCanary } from "../lib/canary";
import { loadConfig, paths } from "../lib/config";

const NO_INDEX = 2;

/**
 * THE DEVELOPER GATE DEMANDS 100%, and that is a different question from the promote gate.
 *
 * `runCanary`'s own default is 0.9 and it stays there, because the caller it was written for
 * is `build-index` deciding whether a CANDIDATE INDEX is fit to serve -- and an index that is
 * a shade off still beats having none, so a tolerance there is a real judgement.
 *
 * Nobody is choosing between two indexes here. This asks "did search regress on the one we
 * have", `.claude/CLAUDE.md` has always answered that with *"it must stay at 100%; a card is
 * not done if it moved"*, and the code disagreed with the document in the lenient direction.
 * Measured 2026-09-06: with the three `andrenochrome` cases failing, this job reported
 * **`PASS 43/46 (93%, floor 90%)`** -- three known-broken queries and a green gate.
 */
const DEV_FLOOR = 1;

/**
 * The configured index, or the checkout's own `./data` one if that is where it actually is.
 *
 * > [!IMPORTANT] Without this the gate says NOT MEASURED on the one machine that CAN measure
 * > `config.dataDir` defaults to `/data` and is validated as an absolute path, because that is
 * > where `docker-compose.yml` mounts the volume -- correct for the container and wrong for
 * > every developer, whose index sits at `./data/titles.db` beside the repo. So a checkout
 * > with no `FINDERR_DATA_DIR` exported looked for `/data/titles.db`, found nothing, and
 * > reported "could not measure" while a 1.8 GB index sat one directory away. Measured on main
 * > immediately after the gate landed, 2026-09-06, which is exactly the shape of quiet
 * > non-check the gate exists to end.
 *
 * The fallback is READ-ONLY and job-local. `config.dataDir` is not touched: changing that
 * default would move the server's database, the poster cache and the build's scratch space to
 * follow a convenience for one script.
 *
 * **A WORKTREE IS THE CASE THAT MATTERS**, and it is the third candidate. The WORK MODE
 * covenant puts every change in `.claude/worktrees/<name>/`, so that is where the gate
 * actually runs -- and a worktree has its own `node_modules`, its own `spellfix1.dylib` and
 * NO `data/`. Finding only the checkout's own `./data` would mean the suite never measured
 * anything on the branch where the search was being changed. The parent checkout is a fixed
 * distance up (`<root>/.claude/worktrees/<name>`), so it is derived rather than guessed at.
 *
 * Reading the live index from a worktree is safe and is what the dev server already does: the
 * engine opens it `readonly` with `query_only`, and the corruption this repo has twice paid
 * for needs two WRITERS. It also means the branch is measured against the same corpus the
 * deployment serves, which is the point.
 *
 * An explicit path argument always wins and is never second-guessed -- pointing this at a
 * candidate or at somebody else's copy is the reason it takes one.
 */
export function findIndex(configured: string, cwd: string = process.cwd()): string {
  const worktreeAt = cwd.indexOf("/.claude/worktrees/");
  for (const candidate of [
    configured,
    `${cwd}/data/titles.db`,
    ...(worktreeAt === -1 ? [] : [`${cwd.slice(0, worktreeAt)}/data/titles.db`]),
  ]) {
    if (Bun.file(candidate).size) return candidate;
  }
  // Nothing found: report against the CONFIGURED path, because "no index at /data/titles.db"
  // is the sentence that tells a container operator what is wrong.
  return configured;
}

export function main(argv: readonly string[] = Bun.argv.slice(2)): number {
  const cfg = loadConfig();
  // The path is the first argument that is not a flag. Reading `argv[0]` blindly made
  // `bun run canary --timings` report "no index at --timings", which is a confusing way to
  // say "that was a flag".
  const explicit = argv.find((a) => !a.startsWith("--"));
  const dbPath = explicit ?? findIndex(paths(cfg).db);

  if (!Bun.file(dbPath).size) {
    console.error(`[canary] no index at ${dbPath} -- build one with \`bun run index:build\``);
    return NO_INDEX;
  }

  const r = runCanary(dbPath, cfg, DEV_FLOOR);
  console.log(`[canary] ${dbPath}`);

  // The absence goes ABOVE the score, because it is what makes the score mean something
  // other than what a reader would assume.
  if (r.degraded) console.log(`[canary] ${r.degraded}`);

  console.log(
    `[canary] ${r.ok ? "PASS" : "FAIL"} ${r.passed}/${r.total} ` +
      `(${(r.ratio * 100).toFixed(0)}%, floor ${(r.floor * 100).toFixed(0)}%) in ${r.ms.toFixed(0)}ms`,
  );
  for (const f of r.failures) {
    console.log(`[canary]   miss: "${f.query}" wanted ~${f.want}, got ${f.got} [${f.tier}]`);
  }
  for (const s of r.slow) {
    console.log(`[canary]   SLOW: "${s.query}" ${s.ms.toFixed(0)}ms over its ${s.budgetMs}ms budget`);
  }

  // The cost side of the same run. Printed always rather than only on a breach, because the
  // point of the table is to be READ while it is still green -- a budget nobody looks at until
  // it trips is a budget nobody can set honestly. `--timings` opens the whole list.
  const slowest = r.timings.slice(0, argv.includes("--timings") ? r.timings.length : 5);
  const io =
    r.readBytes === null ? "not visible on this platform" : `${(r.readBytes / 1e6).toFixed(1)} MB read`;
  console.log(
    `[canary] slowest: ${slowest.map((t) => `${t.query} ${t.ms.toFixed(0)}ms [${t.tier}]`).join(", ")}`,
  );
  console.log(`[canary] I/O: ${io}`);

  return r.ok ? 0 : 1;
}

if (import.meta.main) process.exit(main());
