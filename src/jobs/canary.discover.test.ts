/**
 * Where the canary looks for an index when nobody told it.
 *
 * The bug: `config.dataDir` defaults to `/data` for the container, so a checkout with no
 * `FINDERR_DATA_DIR` reported "could not measure" with a 1.8 GB index one directory away --
 * and the gate printed NOT MEASURED on the only machine that could have measured.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findIndex } from "./canary";

const root = mkdtempSync(join(tmpdir(), "finderr-find-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A checkout with a real (empty-but-present) index file where one would be. */
function checkout(name: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "data"), { recursive: true });
  Bun.write(join(dir, "data", "titles.db"), "x");
  return dir;
}

describe("finding the index", () => {
  test("the configured path wins whenever it exists", () => {
    const dir = checkout("configured");
    expect(findIndex(join(dir, "data", "titles.db"), dir)).toBe(join(dir, "data", "titles.db"));
  });

  test("a checkout falls back to its own ./data", () => {
    const dir = checkout("local");
    expect(findIndex("/data/titles.db", dir)).toBe(join(dir, "data", "titles.db"));
  });

  test("a WORKTREE reaches up to the checkout it was cut from", () => {
    // The case that matters: every change is made in a worktree, a worktree has no data/, and
    // without this the search suite never runs on the branch that changes the search.
    const dir = checkout("worktree-parent");
    const wt = join(dir, ".claude", "worktrees", "some-branch");
    mkdirSync(wt, { recursive: true });
    expect(findIndex("/data/titles.db", wt)).toBe(join(dir, "data", "titles.db"));
  });

  test("with nothing anywhere it names the CONFIGURED path, not the last one tried", () => {
    // "no index at /data/titles.db" is what tells a container operator what is wrong. A
    // message naming some temp directory would send them somewhere that was never the answer.
    const empty = join(root, "bare");
    mkdirSync(empty, { recursive: true });
    expect(findIndex("/data/titles.db", empty)).toBe("/data/titles.db");
  });
});
