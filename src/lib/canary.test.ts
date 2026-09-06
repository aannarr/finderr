/**
 * What the canary says when the fuzzy tier is not there to run.
 *
 * THE BUG THIS EXISTS FOR: `spellfix1.dylib` is a gitignored build artifact, so a fresh
 * worktree has none, and the suite answered that with `FAIL 37/42` listing five typo
 * queries as misses. That reads as a ranking regression the reader just caused -- on a
 * suite the project treats as a build gate that must stay at 100% -- and a seat went
 * hunting through `rank()` for a bug it had not written. A missing capability is not a
 * ranking failure, and the gate now says which one it is looking at.
 *
 * The fixture index deliberately has no vocabulary table and the test process has no
 * guarantee of an extension, so `fuzzyOff` here is genuinely absent -- WHICH cause depends
 * on the machine, which is why the assertions below pin the reporting rather than one
 * platform's reason. The wording of the extension case itself is pinned through
 * `SPELLFIX_MISSING`, the single constant every reporter of that absence prints.
 */

import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANARY_CASES, CASE_BUDGET_MS, type NanoClock, runCanaryOn, slowLine } from "./canary";
import { loadConfig } from "./config";
import { buildTitleSearchIndex, SCHEMA } from "./index-builder";
import { SearchEngine } from "./search";
import { SPELLFIX_MISSING } from "./spellfix";

const dir = mkdtempSync(join(tmpdir(), "finderr-canary-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/**
 * An empty but structurally real index, opened as a real engine.
 *
 * Empty on purpose: this file is about what the gate REPORTS, never about which titles it
 * finds -- the corpus questions belong to the real index and `search-exact.test.ts`. What
 * matters is that `prepareFuzzy` ran and could not attach a fuzzy tier, which is the state
 * every fresh worktree is in.
 */
function engineWithoutFuzzy(): SearchEngine {
  const path = join(dir, `${crypto.randomUUID()}.db`);
  const db = new Database(path, { create: true });
  db.run(SCHEMA);
  buildTitleSearchIndex(db);
  db.close();
  const engine = new SearchEngine(path, loadConfig());
  engine.prepareFuzzy();
  return engine;
}

const FUZZY_ONLY = CANARY_CASES.filter((c) => c.fuzzyOnly);

test("the fuzzy-only cases are a measured minority, not every typo", () => {
  // Guards the annotation itself. Marking all ten typo cases would silently drop five that
  // FTS answers perfectly well, and a suite that quietly stops testing things is the
  // failure this whole file is about -- in the other direction.
  expect(FUZZY_ONLY.map((c) => c.query)).toEqual([
    "interstelar",
    "izombee",
    "matrics",
    "strager thigs",
    "brigerton",
    "andrenochrome",
  ]);
});

test("a `want: null` case is not marked fuzzy-only, because FTS answers it too", () => {
  // The two nonsense cases are the ONLY ones asserting that nothing comes back, and it would
  // be easy to reach for `fuzzyOnly` on the grounds that they were written for a fuzzy bug.
  // Measured instead: with no fuzzy tier, FTS finds nothing for either string and both pass
  // trivially -- so marking them would skip a case that runs perfectly well, which is the same
  // "quietly stops testing things" failure this file guards from the other direction.
  for (const c of CANARY_CASES.filter((x) => x.want === null)) expect(c.fuzzyOnly).toBeUndefined();
  // And the assertion is a real one somewhere: at least one case must make it.
  expect(CANARY_CASES.some((c) => c.want === null)).toBe(true);
});

test("with no fuzzy tier, the unrunnable cases are skipped rather than scored", () => {
  const engine = engineWithoutFuzzy();
  try {
    expect(engine.fuzzyOff).not.toBeNull();
    const r = runCanaryOn(engine);

    expect(r.skipped.map((s) => s.query)).toEqual(FUZZY_ONLY.map((c) => c.query));
    // Nothing is lost in the split: every case is either run or explicitly accounted for.
    expect(r.total + r.skipped.length).toBe(CANARY_CASES.length);
    // The five never reach `failures`, which is what made them read as a ranking bug.
    const failed = new Set(r.failures.map((f) => f.query));
    for (const c of FUZZY_ONLY) expect(failed.has(c.query)).toBe(false);
  } finally {
    engine.close();
  }
});

test("the degraded line names the missing capability and how to get it back", () => {
  const engine = engineWithoutFuzzy();
  try {
    const r = runCanaryOn(engine);
    const degraded = r.degraded ?? "";

    expect(degraded).toStartWith("fuzzy tier absent --");
    // The cause the engine actually diagnosed, verbatim -- so the message can never name a
    // different missing thing from the one that is missing.
    expect(degraded).toContain(engine.fuzzyOff?.detail ?? "");
    // And it says which queries stopped being measured, because a score that quietly
    // changed denominator is worse than one that failed loudly.
    for (const c of FUZZY_ONLY) expect(degraded).toContain(`"${c.query}"`);
  } finally {
    engine.close();
  }
});

/**
 * A clock that advances a fixed step on EVERY read, so each case's elapsed time is that step.
 *
 * `runCanaryOn` reads it once before the loop and twice per case, and only the per-case pair
 * feeds a budget, so a step above `CASE_BUDGET_MS` breaches every case that answered
 * correctly. This is the only way to reach the timing branch: the fixture index below answers
 * in microseconds, so no honest fixture can breach 400 ms, and a branch that cannot be shown
 * RED is one nobody should trust green.
 */
function steppingClock(stepMs: number): NanoClock {
  let ns = 0;
  return () => {
    const read = ns;
    ns += stepMs * 1e6;
    return read;
  };
}

/**
 * `floor: 0` makes ACCURACY pass on an index that finds nothing.
 *
 * That is the point rather than a dodge: the two `want: null` cases genuinely answer
 * correctly on an empty index (nothing is there, and nothing came back), so they are the
 * cases that get TIMED -- `runCanaryOn` only times a case once it is correct. So this fixture
 * is the exact shape the NAS hit on 2026-09-06: correct answers, over budget.
 */
const NONSENSE = CANARY_CASES.filter((c) => c.want === null).map((c) => c.query);

test("a correct-but-slow suite is ACCURATE and NOT withinBudget -- the two verdicts split", () => {
  // THE REGRESSION THIS FILE EXISTS FOR, in its second form. A single `ok` folded these two
  // together, so the NAS logged `FAIL -- 46/46 (100%, floor 90%)` and threw away 455 seconds
  // of work while printing an accuracy verdict for a latency failure.
  const engine = engineWithoutFuzzy();
  try {
    const r = runCanaryOn(engine, 0, steppingClock(CASE_BUDGET_MS + 100));

    expect(r.accurate).toBe(true);
    expect(r.withinBudget).toBe(false);
    // And the breach is attributable: every slow case is named, with the budget it broke.
    expect(r.slow.map((s) => s.query).sort()).toEqual([...NONSENSE].sort());
    for (const s of r.slow) expect(s.ms).toBeGreaterThan(s.budgetMs);
    // A slow case is NOT also a miss. Two verdicts, two lists, no double-counting.
    expect(r.failures.map((f) => f.query)).not.toContain(NONSENSE[0]);
  } finally {
    engine.close();
  }
});

test("the same run at a real-speed clock is withinBudget -- the fixture is not slow by nature", () => {
  // Guards the guard. Without this, the test above would pass just as well against a clock
  // bug, and would be measuring itself rather than the gate.
  const engine = engineWithoutFuzzy();
  try {
    const r = runCanaryOn(engine, 0);
    expect(r.accurate).toBe(true);
    expect(r.withinBudget).toBe(true);
    expect(r.slow).toEqual([]);
  } finally {
    engine.close();
  }
});

test("an inaccurate suite fails on ACCURACY whether or not it was fast", () => {
  // The other direction of the same fixture: the real 0.9 floor against an index that finds
  // nothing. Timing is irrelevant here and must not rescue it.
  const engine = engineWithoutFuzzy();
  try {
    const r = runCanaryOn(engine, 0.9);
    expect(r.accurate).toBe(false);
    expect(r.withinBudget).toBe(true);
    expect(r.failures.length).toBeGreaterThan(0);
  } finally {
    engine.close();
  }
});

test("`slowLine` names every breach and its budget, and is null when nothing breached", () => {
  // The sentence whose ABSENCE was the whole first bug: the gate refused on `slow` and printed
  // only the accuracy numbers, so the operator had a self-contradicting line and nothing to
  // act on. One owner for the wording, exactly as `degradedLine` is for the other absence.
  expect(slowLine([])).toBeNull();
  const line = slowLine([
    { query: "seven samuri", ms: 512.4, budgetMs: 400 },
    { query: "Nile City", ms: 901, budgetMs: 800 },
  ]);
  expect(line).toContain('"seven samuri" 512ms over its 400ms budget');
  expect(line).toContain('"Nile City" 901ms over its 800ms budget');
  // It must say the answers were RIGHT, or a reader takes it for a ranking failure again.
  expect(line).toContain("CORRECTLY");
});

test("a missing spellfix1 is reported as a missing spellfix1, with the command that builds it", () => {
  // The wording every reporter shares, pinned once. This is the sentence whose ABSENCE
  // cost a seat a fruitless hunt through the ranker.
  expect(SPELLFIX_MISSING).toContain("spellfix1");
  expect(SPELLFIX_MISSING).toContain("bun run spellfix:build");
});
