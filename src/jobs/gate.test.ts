/**
 * The one rule in the gate that is a JUDGEMENT rather than a spawn: what "could not measure"
 * means.
 *
 * Everything else `gate.ts` does is run five commands and report the first non-zero exit,
 * which is only testable by spawning five commands. This is the part that decides whether a
 * machine with no index is allowed to call the run green, and it is the part that would be
 * quietly wrong in the dangerous direction -- a tolerated exit that stopped being announced
 * is indistinguishable from a check that passed.
 */

import { describe, expect, test } from "bun:test";
import { verdict } from "./gate";

const step = (name: string, code: number, tolerated?: string) => ({ name, code, tolerated, ms: 1 });

describe("the gate's verdict", () => {
  test("every command green is a pass with nothing unmeasured", () => {
    const v = verdict([step("test", 0), step("canary", 0)]);
    expect(v).toEqual({ ok: true, unmeasured: [] });
  });

  test("a real failure fails, whatever else passed", () => {
    expect(verdict([step("test", 0), step("canary", 1)]).ok).toBe(false);
  });

  test("a tolerated exit passes BUT is named, never silently", () => {
    // The whole point. A machine with no index may call the run green -- and the gate must
    // still say which check did not happen, or the green is a lie by omission.
    const v = verdict([step("test", 0), step("canary", 2, "no index on this machine")]);
    expect(v.ok).toBe(true);
    expect(v.unmeasured).toEqual(["canary"]);
  });

  test("a tolerated code is decided by the STEP, not by the number", () => {
    // Exit 2 from a step that never declared it tolerable is an ordinary failure. Keying the
    // rule on the code alone would let any command opt into being ignored by exiting 2.
    expect(verdict([step("lint", 2)]).ok).toBe(false);
  });
});
