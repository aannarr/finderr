/**
 * The finished threshold: 5% of the runtime or 3 minutes, whichever is SMALLER. Each branch is
 * pinned from both sides of its edge, because an off-by-one here is a watched check that appears
 * a minute early or never.
 */

import { describe, expect, test } from "bun:test";
import { FINISHED_FRACTION, FINISHED_MAX_REMAINING_SEC, isFinished } from "./watch-progress";

describe("isFinished", () => {
  test("a short runtime uses the 5% branch", () => {
    // 45 minutes: 5% is 135 s, smaller than 180.
    const d = 2700;
    expect(d * FINISHED_FRACTION).toBeLessThan(FINISHED_MAX_REMAINING_SEC);
    expect(isFinished(d - 135, d)).toBe(true);
    expect(isFinished(d - 136, d)).toBe(false);
    // Would be finished under the 3-minute branch; must not be here.
    expect(isFinished(d - 170, d)).toBe(false);
  });

  test("a long runtime uses the 3-minute branch", () => {
    // Two hours: 5% is 360 s, so 180 s wins.
    const d = 7200;
    expect(isFinished(d - 180, d)).toBe(true);
    expect(isFinished(d - 181, d)).toBe(false);
    // Would be finished under the 5% branch; must not be here.
    expect(isFinished(d - 300, d)).toBe(false);
  });

  test("the end and past it are finished", () => {
    expect(isFinished(3600, 3600)).toBe(true);
    expect(isFinished(3605, 3600)).toBe(true);
  });

  test("no usable runtime is never finished", () => {
    expect(isFinished(0, 0)).toBe(false);
    expect(isFinished(10, -1)).toBe(false);
    expect(isFinished(Number.NaN, 100)).toBe(false);
    expect(isFinished(100, Number.POSITIVE_INFINITY)).toBe(false);
  });
});
