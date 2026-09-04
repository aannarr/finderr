/**
 * Benchmark models against the agent tool surface. No UI, no server, no network but OpenRouter.
 *
 * ```bash
 * bun run agent:eval --models anthropic/claude-haiku-4.5,openai/gpt-5-mini
 * bun run agent:eval --models x/y --scenario S8-the-furious-query   # one case
 * bun run agent:eval --models x/y --tier advanced                   # one tier
 * bun run agent:eval --list                                         # what cases exist
 * ```
 *
 * `FINDERR_DATA_DIR` picks the index. Point it at a scratch build rather than at `./data`
 * while the container is up: two processes on one SQLite file over a Docker bind mount is
 * how this project's database has been corrupted twice.
 *
 * What it prints is per-model: the two verdicts (`correct` and `route` -- see `Grade`),
 * median wall time, tool calls per question, tokens and the cost OpenRouter itself reports.
 * Cost is read from the response rather than computed from a price table, because a price
 * table is a fact with an expiry date.
 */

import { Database } from "bun:sqlite";
import { MemoryResumeStore } from "../lib/agent/connections";
import { type CompactMode, type RunResult, run } from "../lib/agent/runner";
import { type Grade, grade, SCENARIOS, type Scenario } from "../lib/agent/scenarios";
import { loadConfig, paths } from "../lib/config";
import { SearchEngine } from "../lib/search";
import { prepareSqlite } from "../lib/spellfix";

interface Row {
  model: string;
  mode: Mode;
  scenario: Scenario;
  result: RunResult;
  grade: Grade;
}

/**
 * Which transcript treatment an arm ran under -- see `CompactMode` in the runner.
 *
 * `--compact off,results` runs each scenario once per named mode so the delta is measured
 * rather than argued about, which is the only reason this flag exists. The FIRST mode named
 * is the baseline every other arm is compared against.
 */
type Mode = CompactMode;

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function main(argv: readonly string[] = Bun.argv.slice(2)): Promise<number> {
  if (argv.includes("--list")) {
    for (const s of SCENARIOS) console.log(`${s.tier.padEnd(8)} ${s.id.padEnd(30)} ${s.question}`);
    return 0;
  }

  // No --models benchmarks whatever this deployment would actually use, which is the more
  // useful default: `FINDERR_AI_MODELS` is the list the server calls, so the harness and
  // production cannot silently be measuring different things.
  const models = (flag(argv, "--models") ?? loadConfig().ai.models.join(","))
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  if (models.length === 0) {
    console.error("Need --models <a,b,c>, or set FINDERR_AI_MODELS. Try --list for the scenarios.");
    return 2;
  }
  /*
    Either name works, and that is not laziness.

    `FINDERR_OPENROUTER_API_KEY` is what the container sees, so a shell on a deployed host
    already has the right variable exported and the benchmark runs with no extra step. Bare
    `OPENROUTER_API_KEY` is what a `.env` in this repo carries, because .env names are
    deliberately unprefixed here -- a FINDERR_ name in that file configures every `bun test`
    on the host, which `env-hygiene.test.ts` fails the suite over.
  */
  const apiKey = loadConfig().ai.openrouterApiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("Set OPENROUTER_API_KEY (or FINDERR_OPENROUTER_API_KEY).");
    return 2;
  }

  const only = flag(argv, "--scenario");
  const tier = flag(argv, "--tier");
  const cases = SCENARIOS.filter((s) => (!only || s.id === only) && (!tier || s.tier === tier));
  if (cases.length === 0) {
    console.error(`No scenario matched. --scenario ${only ?? "(any)"} --tier ${tier ?? "(any)"}`);
    return 2;
  }

  const cfg = loadConfig();
  const dbPath = paths(cfg).db;
  // Before the engine opens anything: the fuzzy tier needs an extension-permitting
  // libsqlite3 and that choice is process-global. Same order as `runCanary`.
  prepareSqlite();
  const engine = new SearchEngine(dbPath, cfg);
  engine.prepareFuzzy();
  const db = new Database(dbPath, { readonly: true });
  const ctx = { db, engine };

  console.log(`index   ${dbPath}`);
  console.log(`cases   ${cases.length}  (${cases.map((c) => c.id).join(", ")})`);
  console.log(`models  ${models.join(", ")}\n`);

  const compactFlag = flag(argv, "--compact") ?? "off";
  const modes: Mode[] = (compactFlag === "all" ? "off,results,ledger" : compactFlag)
    .split(",")
    .map((m) => m.trim())
    .filter((m): m is Mode => m === "off" || m === "results" || m === "ledger");
  if (modes.length === 0) {
    console.error('--compact takes "off", "results", "ledger", a comma list of them, or "all".');
    return 2;
  }
  const cacheSystem = argv.includes("--cache");

  const rows: Row[] = [];
  for (const model of models) {
    for (const scenario of cases) {
      for (const mode of modes) {
        const result = await run({
          model,
          question: scenario.question,
          ctx,
          store: new MemoryResumeStore(),
          compact: mode,
          cacheSystem,
          apiKey,
        });
        const g = grade(db, scenario, result);
        rows.push({ model, mode, scenario, result, grade: g });
        // Two marks, because they are two verdicts. A correct answer that took a wasteful
        // route reads as `PASS/slow` rather than being scored as wrong -- which is the whole
        // reason the grader was split. See `Grade` in ../lib/agent/scenarios.ts.
        const mark = `${g.correct ? "PASS" : "FAIL"}/${g.efficient ? "route" : "slow "}`;
        const tools = result.toolCalls.map((c) => c.name).join(" -> ") || "(none)";
        console.log(
          `${mark}  ${model.padEnd(30)} ${mode.padEnd(8)} ${scenario.id.padEnd(28)} ` +
            `${result.ms.toFixed(0).padStart(6)}ms ${String(result.toolCalls.length).padStart(2)} calls ` +
            `${String(result.promptTokens).padStart(6)}tok $${result.costUsd.toFixed(4)}`,
        );
        console.log(`      ${tools}`);
        if (!g.correct) for (const r of g.reasons) console.log(`      ! ${r}`);
        if (!g.efficient) for (const r of g.routeNotes) console.log(`      ~ route: ${r}`);
        if (result.answer) console.log(`      "${result.answer.replaceAll("\n", " ").slice(0, 160)}"`);
        console.log();
      }
    }
  }

  console.log(summary(rows));
  engine.close();
  db.close();
  // CORRECTNESS owns the exit code and the route does not. A model that answered every
  // question truthfully by a path no case author predicted has not failed a benchmark.
  return rows.every((r) => r.grade.correct) ? 0 : 1;
}

function median(ns: number[]): number {
  if (ns.length === 0) return 0;
  const s = [...ns].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/**
 * The comparison table.
 *
 * FOUR numbers describe a model here and each answers a question the others cannot.
 *
 * - `correct` -- was the answer true and backed by the tools. The headline.
 * - `route` -- did it get there the way the case expected. A model can be correct and
 *   wasteful, which costs money and latency without being wrong, and folding this into the
 *   pass rate is what previously scored a right answer as a failure.
 * - `memory` -- answered while never resolving a proper noun. Right today, wrong next week.
 * - `inferred` -- stated a connection no tool result carried. The one that a correct-looking
 *   answer hides completely: every noun checks out and the sentence is still false.
 */
function summary(rows: Row[]): string {
  const models = [...new Set(rows.map((r) => r.model))];
  const modes = [...new Set(rows.map((r) => r.mode))];
  const head =
    "model".padEnd(30) +
    "mode".padEnd(9) +
    "correct".padStart(8) +
    "route".padStart(8) +
    "med ms".padStart(8) +
    "calls".padStart(7) +
    "tok in".padStart(9) +
    "cached".padStart(8) +
    "tok out".padStart(9) +
    "cost".padStart(10) +
    "  memory  inferred";
  const lines = [head, "-".repeat(head.length)];

  const bucket = (model: string, mode: Mode) => rows.filter((r) => r.model === model && r.mode === mode);

  for (const model of models) {
    for (const mode of modes) {
      const mine = bucket(model, mode);
      if (mine.length === 0) continue;
      const correct = mine.filter((r) => r.grade.correct).length;
      const efficient = mine.filter((r) => r.grade.efficient).length;
      const memory = mine.filter((r) => r.grade.unresolved.length > 0).length;
      const inferred = mine.filter((r) => r.grade.inferredJoins.length > 0).length;
      lines.push(
        model.padEnd(30) +
          mode.padEnd(9) +
          `${correct}/${mine.length}`.padStart(8) +
          `${efficient}/${mine.length}`.padStart(8) +
          median(mine.map((r) => r.result.ms))
            .toFixed(0)
            .padStart(8) +
          (mine.reduce((a, r) => a + r.result.toolCalls.length, 0) / mine.length).toFixed(1).padStart(7) +
          String(mine.reduce((a, r) => a + r.result.promptTokens, 0)).padStart(9) +
          String(mine.reduce((a, r) => a + r.result.cachedTokens, 0)).padStart(8) +
          String(mine.reduce((a, r) => a + r.result.completionTokens, 0)).padStart(9) +
          `$${mine.reduce((a, r) => a + r.result.costUsd, 0).toFixed(4)}`.padStart(10) +
          `  ${String(memory).padStart(6)}  ${String(inferred).padStart(8)}`,
      );
    }
  }

  // The A/B line only exists when both arms actually ran; a delta against one arm is a
  // number with nothing to compare to, and printing it anyway is how a benchmark starts lying.
  // The FIRST mode that ran is the baseline; every other arm is reported against it.
  const baseline = modes[0];
  if (modes.length > 1 && baseline) {
    lines.push("", `delta vs "${baseline}" (negative is better):`);
    for (const model of models) {
      for (const arm of modes.slice(1)) {
        const plain = bucket(model, baseline);
        const comp = bucket(model, arm);
        if (plain.length === 0 || comp.length === 0) continue;
        const sum = (rs: Row[], f: (r: Row) => number) => rs.reduce((a, r) => a + f(r), 0);
        const tokBase = sum(plain, (r) => r.result.promptTokens);
        const tokArm = sum(comp, (r) => r.result.promptTokens);
        const outBase = sum(plain, (r) => r.result.completionTokens);
        const outArm = sum(comp, (r) => r.result.completionTokens);
        const costBase = sum(plain, (r) => r.result.costUsd);
        const costArm = sum(comp, (r) => r.result.costUsd);
        const pass = `${comp.filter((r) => r.grade.correct).length}/${comp.length} vs ${plain.filter((r) => r.grade.correct).length}/${plain.length}`;
        lines.push(
          `  ${model.padEnd(28)} ${arm.padEnd(8)} in ${pct(tokArm, tokBase).padStart(7)}   ` +
            `out ${pct(outArm, outBase).padStart(7)}   cost ${pct(costArm, costBase).padStart(7)}   pass ${pass}`,
        );
      }
    }
  }
  return lines.join("\n");
}

function pct(now: number, before: number): string {
  if (before === 0) return "n/a";
  const d = ((now - before) / before) * 100;
  return `${d > 0 ? "+" : ""}${d.toFixed(0)}%`;
}

if (import.meta.main) {
  process.exit(await main());
}
