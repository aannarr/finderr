#!/usr/bin/env bun
/**
 * The pre-done gate: everything that must be true before work is called finished.
 *
 * ```
 * bun run gate
 * ```
 *
 * > [!IMPORTANT] THE SEARCH SUITE WAS NOT IN ANY GATE, AND THAT IS WHY THIS FILE EXISTS
 * > `.claude/CLAUDE.md` calls the canary "both the search regression suite and a build gate"
 * > that "must stay at 100%" -- and nothing ran it. `bun run test` does not (the 42 real
 * > queries need a built index, so `canary.test.ts` only exercises the REPORTING against an
 * > empty fixture), and neither does CI's gate job. The suite ran at index-build and promote
 * > time and nowhere else, which is a gate on the DATA and never on the CODE.
 * >
 * > Measured on 2026-09-06: `bun run test && bun run test:web && bun run typecheck &&
 * > bun run lint` was green on a tree where `"andrenochrome"` returned Ender's Game and
 * > `"xyzzyplughfoo"` returned Casablanca. Four green commands and a broken search.
 *
 * > [!CAUTION] "COULD NOT MEASURE" IS PRINTED LOUDLY AND IS NOT A PASS
 * > The canary needs a real index, and CI, the Docker build and a fresh worktree have none.
 * > Failing the gate there would make it red for the wrong reason -- the exact defect the
 * > canary's own degraded-tier reporting exists to end -- so a missing index (exit 2) does not
 * > fail the run. It does NOT pass quietly either: it prints `NOT MEASURED` with the reason
 * > and the summary line says so, because a gate that silently skips its most important check
 * > is worse than one that never had it.
 * >
 * > A fresh worktree also has no compiled `spellfix1`, and the canary reports that separately
 * > as a degraded run. Both are the same rule: say which check did not happen.
 */

const NO_INDEX = 2;

interface Step {
  name: string;
  argv: string[];
  /** Exit codes that are reported rather than fatal, with what to say about each. */
  tolerated?: Record<number, string>;
}

const STEPS: Step[] = [
  { name: "test", argv: ["bun", "run", "test"] },
  { name: "test:web", argv: ["bun", "run", "test:web"] },
  { name: "typecheck", argv: ["bun", "run", "typecheck"] },
  { name: "lint", argv: ["bun", "run", "lint"] },
  {
    name: "canary",
    argv: ["bun", "run", "canary"],
    tolerated: { [NO_INDEX]: "no index on this machine -- search was NOT MEASURED" },
  },
];

export interface StepResult {
  name: string;
  code: number;
  /** Set when the code was tolerated; the sentence to print instead of failing. */
  tolerated?: string;
  ms: number;
}

/** The verdict, split out so it can be tested without spawning five processes. */
export function verdict(results: readonly StepResult[]): { ok: boolean; unmeasured: string[] } {
  return {
    ok: results.every((r) => r.code === 0 || r.tolerated !== undefined),
    unmeasured: results.filter((r) => r.tolerated !== undefined).map((r) => r.name),
  };
}

export function main(): number {
  const results: StepResult[] = [];

  for (const step of STEPS) {
    const t0 = Bun.nanoseconds();
    // Inherited stdio: the point of a gate is that you can read WHY it failed, so the child's
    // own output is the output. Capturing it would mean re-printing it worse.
    const code = Bun.spawnSync(step.argv, { stdout: "inherit", stderr: "inherit" }).exitCode;
    const ms = (Bun.nanoseconds() - t0) / 1e6;
    const tolerated = step.tolerated?.[code];
    results.push({ name: step.name, code, tolerated, ms });

    if (code !== 0 && tolerated === undefined) {
      console.error(`\n[gate] FAIL at ${step.name} (exit ${code}) after ${(ms / 1000).toFixed(1)}s`);
      // Fail FAST. Running lint over a tree whose tests do not pass wastes a minute to tell
      // you something you already have to fix.
      return 1;
    }
    if (tolerated) console.error(`[gate] ${step.name}: ${tolerated}`);
  }

  const v = verdict(results);
  const total = results.reduce((n, r) => n + r.ms, 0) / 1000;
  console.error(
    `\n[gate] ${v.ok ? "PASS" : "FAIL"} ${results.map((r) => r.name).join(", ")} in ${total.toFixed(1)}s` +
      (v.unmeasured.length > 0 ? ` -- NOT MEASURED: ${v.unmeasured.join(", ")}` : ""),
  );
  return v.ok ? 0 : 1;
}

if (import.meta.main) process.exit(main());
