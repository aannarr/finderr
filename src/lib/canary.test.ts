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
import { CANARY_CASES, runCanaryOn } from "./canary";
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
  ]);
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

test("a missing spellfix1 is reported as a missing spellfix1, with the command that builds it", () => {
  // The wording every reporter shares, pinned once. This is the sentence whose ABSENCE
  // cost a seat a fruitless hunt through the ranker.
  expect(SPELLFIX_MISSING).toContain("spellfix1");
  expect(SPELLFIX_MISSING).toContain("bun run spellfix:build");
});
