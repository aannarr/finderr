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
import {
  isQuotaValue,
  quotaApplies,
  quotaLimitFor,
  quotaVerdict,
  utcDayReset,
  utcDayStart,
  utcDayStartDaysAgo,
} from "./request-quota";
import { siteSettingsSeed } from "./site-settings";

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

  /**
   * The env key is now a SEED rather than the value, so the reader it must have moved: the
   * request route reads the stored site setting, and `siteSettingsSeed` is what makes the env
   * var decide that setting until an operator saves one. Both halves are asserted, because
   * either one missing is the same lie -- a quota somebody sets that nothing consumes.
   */
  test("the request route reads the site setting the env key seeds", () => {
    expect(serverSource).toContain("siteSettings.read().requestQuotaPerDay");
    expect(siteSettingsSeed(loadConfig()).requestQuotaPerDay).toBe(loadConfig().requests.quotaPerDay);
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

  test("a window of N days walks back whole days, across a month end", () => {
    const now = new Date("2026-09-02T13:45:12.921Z");
    // Six days back from the day `now` falls in is the seven-day window INCLUDING today,
    // which is what "this week" means on the people list.
    expect(utcDayStartDaysAgo(6, now)).toBe("2026-08-27T00:00:00.000Z");
  });

  test("zero days back is today, so it cannot disagree with utcDayStart", () => {
    const now = new Date("2026-09-02T13:45:12.921Z");
    expect(utcDayStartDaysAgo(0, now)).toBe(utcDayStart(now));
  });
});

/**
 * The two exemptions, asserted on their own rather than only through a verdict.
 *
 * They are read by a SECOND caller now -- `/api/admin/users/:id` sends the answer to the
 * admin user page, so it can say "no daily limit applies" without working the rule out for
 * itself. A page that re-derived it would be free to disagree with the endpoint that refuses
 * the request, which is the exact drift `quotaApplies` exists to prevent.
 */
describe("quotaApplies", () => {
  test("a limit of zero or less is unlimited, for anybody", () => {
    expect(quotaApplies("user", 0)).toBe(false);
    expect(quotaApplies("user", -1)).toBe(false);
    expect(quotaApplies("admin", 0)).toBe(false);
  });

  test("an admin is exempt even where a limit is set", () => {
    expect(quotaApplies("admin", 5)).toBe(false);
  });

  test("it binds a member with a limit, and only them", () => {
    expect(quotaApplies("user", 5)).toBe(true);
  });

  test("the verdict agrees with it -- one rule, not two", () => {
    for (const role of ["admin", "user"] as const) {
      for (const limit of [-1, 0, 5]) {
        // `usedToday` returns a count at the limit, so the ONLY thing that can let this
        // through is the exemption. Agreement is then a property rather than a coincidence.
        const verdict = quotaVerdict({ role, limit, usedToday: () => Math.max(limit, 0) });
        expect({ role, limit, allowed: verdict.allowed }).toEqual({
          role,
          limit,
          allowed: !quotaApplies(role, limit),
        });
      }
    }
  });
});

/**
 * The fallback from a person's own allowance to the site's, which has four readers.
 *
 * The cases worth pinning are the two where `??` and `||` disagree, because that is the only
 * mistake this function can make and both spellings look right: an override of ZERO is an
 * explicit "unlimited for this person" and must beat a site limit, and NULL is the absence of
 * an opinion and must not.
 */
describe("quotaLimitFor", () => {
  test("no override follows the site", () => {
    expect(quotaLimitFor(null, 5)).toBe(5);
    expect(quotaLimitFor(null, 0)).toBe(0);
  });

  test("an override wins, including a zero that means unlimited", () => {
    expect(quotaLimitFor(2, 5)).toBe(2);
    expect(quotaLimitFor(0, 5)).toBe(0);
    // ...and it works in the other direction too: a personal cap on an uncapped site.
    expect(quotaLimitFor(3, 0)).toBe(3);
  });

  test("the rule then reads the resolved number, whichever it came from", () => {
    // The composition is what actually refuses a request, so it is asserted rather than
    // assumed: an override of 0 exempts a member from a site-wide limit of 5.
    expect(quotaApplies("user", quotaLimitFor(0, 5))).toBe(false);
    expect(quotaApplies("user", quotaLimitFor(null, 5))).toBe(true);
  });
});

/**
 * What an operator is allowed to TYPE, which two fields on the admin surface share.
 *
 * The per-user override and the site default are edited four lines apart on the same screen,
 * so a rule that lived in one of the two route handlers would eventually accept a fraction in
 * whichever handler nobody re-read.
 */
describe("isQuotaValue", () => {
  test("a whole number of zero or more, zero included", () => {
    expect(isQuotaValue(0)).toBe(true);
    expect(isQuotaValue(5)).toBe(true);
  });

  test("a fraction, a negative and a non-number are all refused", () => {
    expect(isQuotaValue(2.5)).toBe(false);
    expect(isQuotaValue(-1)).toBe(false);
    expect(isQuotaValue("5")).toBe(false);
    expect(isQuotaValue(null)).toBe(false);
    expect(isQuotaValue(undefined)).toBe(false);
    expect(isQuotaValue(Number.NaN)).toBe(false);
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
