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
 * DELIBERATELY NOT PART OF `bun run test`. It needs a built index, which CI, the Docker
 * build and a fresh worktree do not have, so wiring it into the four-command gate would
 * make that gate fail for the wrong reason -- which is the exact defect this job's own
 * degraded-tier reporting exists to end.
 *
 * Exits 0 when the suite is at or above the floor and 1 when it is not, so it works in a
 * gate and not only by eye. A missing index file is exit 2: "I could not measure" is a
 * different answer from "I measured and it is bad".
 */

import { runCanary } from "../lib/canary";
import { loadConfig, paths } from "../lib/config";

const NO_INDEX = 2;

export function main(argv: readonly string[] = Bun.argv.slice(2)): number {
  const cfg = loadConfig();
  const dbPath = argv[0] ?? paths(cfg).db;

  if (!Bun.file(dbPath).size) {
    console.error(`[canary] no index at ${dbPath} -- build one with \`bun run index:build\``);
    return NO_INDEX;
  }

  const r = runCanary(dbPath, cfg);
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

  return r.ok ? 0 : 1;
}

if (import.meta.main) process.exit(main());
