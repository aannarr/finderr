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
 * What it prints is per-model: pass rate, median wall time, tool calls per question, tokens
 * and the cost OpenRouter itself reports. Cost is read from the response rather than
 * computed from a price table, because a price table is a fact with an expiry date.
 */

import { Database } from "bun:sqlite";
import { MemoryResumeStore } from "../lib/agent/connections";
import { type RunResult, run } from "../lib/agent/runner";
import { type Grade, grade, SCENARIOS, type Scenario } from "../lib/agent/scenarios";
import { loadConfig, paths } from "../lib/config";
import { SearchEngine } from "../lib/search";
import { prepareSqlite } from "../lib/spellfix";

interface Row {
  model: string;
  scenario: Scenario;
  result: RunResult;
  grade: Grade;
}

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function main(argv: readonly string[] = Bun.argv.slice(2)): Promise<number> {
  if (argv.includes("--list")) {
    for (const s of SCENARIOS) console.log(`${s.tier.padEnd(8)} ${s.id.padEnd(30)} ${s.question}`);
    return 0;
  }

  const models = (flag(argv, "--models") ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  if (models.length === 0) {
    console.error("Need --models <a,b,c>. Try --list to see the scenarios.");
    return 2;
  }
  if (!process.env.OPENROUTER_API_KEY) {
    console.error("OPENROUTER_API_KEY is not set.");
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

  const rows: Row[] = [];
  for (const model of models) {
    for (const scenario of cases) {
      const result = await run({
        model,
        question: scenario.question,
        ctx,
        store: new MemoryResumeStore(),
      });
      const g = grade(db, scenario, result);
      rows.push({ model, scenario, result, grade: g });
      const mark = g.pass ? "PASS" : "FAIL";
      const tools = result.toolCalls.map((c) => c.name).join(" -> ") || "(none)";
      console.log(
        `${mark}  ${model.padEnd(34)} ${scenario.id.padEnd(30)} ` +
          `${result.ms.toFixed(0).padStart(6)}ms ${String(result.toolCalls.length).padStart(2)} calls ` +
          `$${result.costUsd.toFixed(4)}`,
      );
      console.log(`      ${tools}`);
      if (!g.pass) for (const r of g.reasons) console.log(`      ! ${r}`);
      if (result.answer) console.log(`      "${result.answer.replaceAll("\n", " ").slice(0, 160)}"`);
      console.log();
    }
  }

  console.log(summary(rows));
  engine.close();
  db.close();
  return rows.every((r) => r.grade.pass) ? 0 : 1;
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
 * `resolve fails` is broken out from the pass rate on purpose: a model can get the right
 * answer while never calling a resolver, which is a PASS on the question and a failure of
 * the discipline -- and the second one predicts the next answer being wrong. Reporting them
 * as one number would hide exactly the behaviour this harness exists to detect.
 */
function summary(rows: Row[]): string {
  const models = [...new Set(rows.map((r) => r.model))];
  const head =
    "model".padEnd(34) +
    "pass".padStart(8) +
    "med ms".padStart(9) +
    "calls".padStart(7) +
    "tok in".padStart(9) +
    "tok out".padStart(9) +
    "cost".padStart(10) +
    "  from-memory";
  const lines = [head, "-".repeat(head.length)];

  for (const model of models) {
    const mine = rows.filter((r) => r.model === model);
    const passed = mine.filter((r) => r.grade.pass).length;
    const memory = mine.filter((r) => r.grade.unresolved.length > 0).length;
    lines.push(
      model.padEnd(34) +
        `${passed}/${mine.length}`.padStart(8) +
        median(mine.map((r) => r.result.ms))
          .toFixed(0)
          .padStart(9) +
        (mine.reduce((a, r) => a + r.result.toolCalls.length, 0) / mine.length).toFixed(1).padStart(7) +
        String(mine.reduce((a, r) => a + r.result.promptTokens, 0)).padStart(9) +
        String(mine.reduce((a, r) => a + r.result.completionTokens, 0)).padStart(9) +
        `$${mine.reduce((a, r) => a + r.result.costUsd, 0).toFixed(4)}`.padStart(10) +
        `  ${memory}`,
    );
  }
  return lines.join("\n");
}

if (import.meta.main) {
  process.exit(await main());
}
