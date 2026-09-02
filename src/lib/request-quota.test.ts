/**
 * The daily quota rule, exercised without a database or a clock.
 *
 * `quotaVerdict` takes the count as a THUNK and the time as an argument, so every branch
 * below is reachable from a plain value -- including the two that matter most and are the
 * hardest to provoke against a live server: the day rollover, and the reads that never
 * happen because the limit does not apply.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config";
import { quotaVerdict, utcDayReset, utcDayStart } from "./request-quota";

/** A thunk that records whether it was called, so "never counted" is an assertion. */
function counter(value: number): (() => number) & { calls: number } {
  const fn = (() => {
    fn.calls += 1;
    return value;
  }) as (() => number) & { calls: number };
  fn.calls = 0;
  return fn;
}

/**
 * A config key nothing consumes is a lie told to whoever reads the README.
 *
 * The same defence `boot-config.test.ts` puts around `refreshOnBoot`, and for the same
 * reason: the failure mode is the ABSENCE of a reader, which no behavioural test can see
 * because the behaviour never runs. An operator who sets a quota and watches it do nothing
 * has no way to tell that from a quota they set too high.
 */
describe("FINDERR_REQUEST_QUOTA_PER_DAY", () => {
  const serverSource = readFileSync(join(import.meta.dir, "..", "server", "index.ts"), "utf8");

  test("is a real config key, defaulting to unlimited", () => {
    expect(loadConfig().requests.quotaPerDay).toBe(0);
  });

  test("the request route actually reads it", () => {
    expect(serverSource).toContain("cfg.requests.quotaPerDay");
  });

  test("the count it is compared against comes from the request log", () => {
    // Pins the decision, not just the wiring: there is no quota counter to keep in step
    // with the log, so nothing can drift out of step with it.
    expect(serverSource).toContain("store.countRequestsSince(");
  });
});

describe("the UTC day boundary", () => {
  test("starts at midnight, in the format request.created_at is written in", () => {
    // Matters because the comparison is done by SQLite as a STRING compare -- a start
    // spelled any other way silently matches nothing or everything.
    expect(utcDayStart(new Date("2026-09-02T13:45:12.921Z"))).toBe("2026-09-02T00:00:00.000Z");
    expect(utcDayStart(new Date("2026-09-02T00:00:00.000Z"))).toBe("2026-09-02T00:00:00.000Z");
  });

  test("the last millisecond of a day still belongs to that day", () => {
    expect(utcDayStart(new Date("2026-09-02T23:59:59.999Z"))).toBe("2026-09-02T00:00:00.000Z");
  });

  test("resets at the next midnight, across a month and a year end", () => {
    expect(utcDayReset(new Date("2026-09-02T13:45:12.921Z"))).toBe("2026-09-03T00:00:00.000Z");
    expect(utcDayReset(new Date("2026-09-30T23:00:00.000Z"))).toBe("2026-10-01T00:00:00.000Z");
    expect(utcDayReset(new Date("2026-12-31T23:00:00.000Z"))).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("quotaVerdict", () => {
  const now = new Date("2026-09-02T21:00:00.000Z");

  test("lets a user through below the limit", () => {
    expect(quotaVerdict({ role: "user", limit: 5, usedToday: counter(4), now })).toEqual({
      allowed: true,
    });
  });

  test("refuses a user who has spent the day's allowance", () => {
    const verdict = quotaVerdict({ role: "user", limit: 5, usedToday: counter(5), now });
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error("unreachable");
    expect(verdict.used).toBe(5);
    expect(verdict.limit).toBe(5);
    expect(verdict.resetsAt).toBe("2026-09-03T00:00:00.000Z");
    // Three hours to midnight.
    expect(verdict.retryAfterSeconds).toBe(10_800);
    // The card asked for a message naming the limit and the reset; both are in it.
    expect(verdict.message).toContain("5 of 5 titles");
    expect(verdict.message).toContain("2026-09-03T00:00:00.000Z");
  });

  test("refuses a user already over the limit, which a lowered setting can produce", () => {
    const verdict = quotaVerdict({ role: "user", limit: 3, usedToday: counter(9), now });
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error("unreachable");
    expect(verdict.message).toContain("9 of 3 titles");
  });

  test("Retry-After is never 0, however close to midnight the refusal lands", () => {
    const verdict = quotaVerdict({
      role: "user",
      limit: 1,
      usedToday: counter(1),
      now: new Date("2026-09-02T23:59:59.999Z"),
    });
    if (verdict.allowed) throw new Error("unreachable");
    // A 0 would invite an instant retry into the same refusal.
    expect(verdict.retryAfterSeconds).toBe(1);
  });

  test("the day rolls over: the same used-count passes once the date moves on", () => {
    // The rollover is the whole of the reset mechanism -- there is no sweep and no job.
    // Yesterday's five requests stop being counted because `utcDayStart` moved, which the
    // store test pins; here the point is that the RULE reads whatever it is handed.
    const spent = quotaVerdict({ role: "user", limit: 5, usedToday: counter(5), now });
    const fresh = quotaVerdict({
      role: "user",
      limit: 5,
      usedToday: counter(0),
      now: new Date("2026-09-03T00:00:00.000Z"),
    });
    expect(spent.allowed).toBe(false);
    expect(fresh.allowed).toBe(true);
  });

  describe("who is never counted", () => {
    test("an admin, however many they have asked for", () => {
      const used = counter(9_999);
      expect(quotaVerdict({ role: "admin", limit: 5, usedToday: used, now })).toEqual({
        allowed: true,
      });
      // Not merely allowed: the count is never READ, so the exemption costs no query.
      expect(used.calls).toBe(0);
    });

    test("anybody, when the limit is unset", () => {
      const used = counter(9_999);
      expect(quotaVerdict({ role: "user", limit: 0, usedToday: used, now })).toEqual({
        allowed: true,
      });
      expect(used.calls).toBe(0);
    });

    test("anybody, when the limit is negative -- a typo opens the gate, never closes it", () => {
      expect(quotaVerdict({ role: "user", limit: -1, usedToday: counter(9_999), now })).toEqual({
        allowed: true,
      });
    });
  });
});
