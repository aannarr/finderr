/**
 * The daily AI budget: the rule, the day boundary, and the words a refusal uses.
 *
 * `aiGate` takes its clock and its spend as arguments, so every branch here is exercised
 * without a database and without waiting for midnight. The ledger half is tested against a
 * real `Store`, because the thing worth pinning there is that the quota reads the TABLE --
 * a fake sink would prove the arithmetic and not the query.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AiCallSink,
  aiGate,
  chargeRefusal,
  chargeRun,
  dailyCapVerdict,
  localDay,
  outcomeOf,
  resetDelta,
} from "./ai-spend";
import { loadConfig } from "./config";
import { Store } from "./store";

const USER = "u_aannarr";

/** A sink that remembers, for the cases where the point is WHAT was written. */
function fakeSink(): AiCallSink & { rows: ReturnType<typeof chargeRefusal>[] } {
  const rows: ReturnType<typeof chargeRefusal>[] = [];
  return {
    rows,
    recordAiCall: (r) => {
      rows.push(r);
    },
    aiSpendUsd: (u, d) => rows.filter((r) => r.userId === u && r.day === d).reduce((a, r) => a + r.usd, 0),
  };
}

describe("the day boundary", () => {
  test("is the container's local calendar, not UTC", () => {
    // 23:30 local on the 4th is the 4th's budget, whatever UTC thinks the date is.
    const now = new Date(2026, 8, 4, 23, 30);
    expect(localDay(now)).toBe("2026-09-04");
  });

  test("pads to YYYY-MM-DD so the stored day sorts and compares as a string", () => {
    expect(localDay(new Date(2026, 0, 5, 12))).toBe("2026-01-05");
  });
});

describe("resetDelta -- a delta, never a wall clock", () => {
  test("hours and minutes", () => {
    expect(resetDelta(new Date(2026, 8, 4, 18, 48))).toBe("5h 12m");
  });
  test("minutes alone, under an hour", () => {
    expect(resetDelta(new Date(2026, 8, 4, 23, 47))).toBe("13m");
  });
  test("whole hours do not say '3h 0m'", () => {
    expect(resetDelta(new Date(2026, 8, 4, 21, 0))).toBe("3h");
  });
  test("the last minute of the day says something a person can read", () => {
    expect(resetDelta(new Date(2026, 8, 4, 23, 59, 45))).toBe("under a minute");
  });
});

describe("the gate, in the order it decides", () => {
  const base = { role: "user" as const, configured: true, limitUsd: 1 };

  test("no deployment key means the feature does not exist", () => {
    const v = aiGate({ ...base, configured: false, spentToday: () => 0 });
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toBe("not_configured");
  });

  test("an unconfigured deployment never touches the ledger", () => {
    let read = 0;
    aiGate({
      ...base,
      configured: false,
      spentToday: () => {
        read++;
        return 0;
      },
    });
    expect(read).toBe(0);
  });

  /**
   * THE AUDIENCE, since 2026-09-05.
   *
   * These three replace a pair asserting that a non-admin is refused whatever else is set.
   * That was the admin-only beta and it is over; the tests are rewritten rather than deleted
   * because the interesting property survived the change and merely inverted -- an ordinary
   * account's answer must now turn on the BUDGET and on nothing else.
   */
  test("an ordinary account is allowed, on the deployment key alone", () => {
    expect(aiGate({ ...base, spentToday: () => 0 }).allowed).toBe(true);
  });

  test("and is refused only once its own budget is spent", () => {
    const v = aiGate({ ...base, limitUsd: 1, spentToday: () => 1.5 });
    expect(v.allowed).toBe(false);
    // A budget is a wait rather than a wall, so the refusal has to carry when it lifts.
    if (!v.allowed) {
      expect(v.reason).toBe("over_daily_limit");
      expect(v.retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  test("no role is refused for its ROLE any more -- only the key and the budget decide", () => {
    // The regression guard for a re-added role check: same inputs, both roles, both allowed.
    expect(aiGate({ ...base, role: "user", spentToday: () => 0 }).allowed).toBe(true);
    expect(aiGate({ ...base, role: "admin", spentToday: () => 0 }).allowed).toBe(true);
  });

  test("admins are exempt from the CAP and from nothing else", () => {
    expect(aiGate({ ...base, role: "admin", spentToday: () => 999 }).allowed).toBe(true);
    // Still needs the deployment key. The exemption is exactly one gate wide.
    expect(aiGate({ ...base, role: "admin", configured: false, spentToday: () => 0 }).allowed).toBe(false);
  });
});

/*
  The cap's own branches, called directly.

  THIS SUITE IS WHAT STANDS BETWEEN A HOUSEHOLD AND AN UNBOUNDED BILL, and since 2026-09-05 it
  says so about production rather than about a hypothetical. None of it fired while the beta
  was admin-only -- the only people who reached the cap were the people exempt from it -- and
  it was written anyway so the rule would be right before the audience widened. It widened by
  deleting one early return in `aiGate`, and every branch below went live in that commit.
*/
describe("the daily cap, once somebody can reach it", () => {
  const cap = (spent: number, limitUsd = 1) => dailyCapVerdict({ limitUsd, spentToday: () => spent });

  test("under the limit is allowed", () => {
    expect(cap(0.42).allowed).toBe(true);
  });

  test("EXACTLY at the limit is still allowed -- the check is `spent > limit`", () => {
    // The plan states the naive form and this pins it: spend landing exactly on the cap has
    // not exceeded it.
    expect(cap(1).allowed).toBe(true);
  });

  test("over the limit is refused", () => {
    const v = cap(1.01);
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toBe("over_daily_limit");
  });

  test("zero or less is unlimited, the same reading every other limit here uses", () => {
    expect(cap(999, 0).allowed).toBe(true);
  });

  test("an admin passes the same spend the cap would refuse", () => {
    expect(cap(999).allowed).toBe(false);
    expect(aiGate({ role: "admin", configured: true, limitUsd: 1, spentToday: () => 999 }).allowed).toBe(
      true,
    );
  });
});

describe("what a refused person is told", () => {
  const v = dailyCapVerdict({
    limitUsd: 1,
    spentToday: () => 1.04,
    now: new Date(2026, 8, 4, 18, 48),
  });

  test("names the balance", () => {
    expect(v.allowed).toBe(false);
    if (v.allowed) return;
    expect(v.message).toContain("$1.04 of $1.00");
    expect(v.message).toContain("$0.00 left");
    expect(v.remainingUsd).toBe(0);
  });

  test("states the reset as a DELTA and never as a time of day", () => {
    if (v.allowed) return;
    expect(v.message).toContain("Resets in 5h 12m");
    // The thing that must NOT be there: a wall clock a reader has to convert.
    expect(v.message).not.toMatch(/\d{2}:\d{2}/);
    expect(v.message).not.toContain("UTC");
  });

  test("says what still works, because most of finderr does", () => {
    if (v.allowed) return;
    expect(v.message).toContain("Search, browse and requests are unaffected");
  });

  test("carries a Retry-After that is never zero", () => {
    if (v.allowed) return;
    expect(v.retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe("every outcome writes a row", () => {
  test("a completed run is 'ok'", () => {
    expect(outcomeOf({})).toBe("ok");
  });

  test.each(["max_turns", "max_tool_calls", "error"] as const)("a run that failed on %s is charged", (f) => {
    const sink = fakeSink();
    chargeRun(
      sink,
      { userId: USER, convId: "c_1" },
      {
        model: "z-ai/glm-5.3-flash",
        promptTokens: 4211,
        completionTokens: 88,
        cachedTokens: 3980,
        costUsd: 0.000181,
        ms: 2140,
        failure: f,
      },
    );
    expect(sink.rows).toHaveLength(1);
    expect(sink.rows[0]?.outcome).toBe(f);
    // The point of the whole rule: it FAILED and it still cost money.
    expect(sink.rows[0]?.usd).toBeGreaterThan(0);
  });

  test("a refusal writes a row too, at zero, so the wall is countable", () => {
    const sink = fakeSink();
    chargeRefusal(sink, { userId: USER, convId: "c_2", model: "z-ai/glm-5.3-flash" });
    expect(sink.rows[0]?.outcome).toBe("refused");
    expect(sink.rows[0]?.usd).toBe(0);
  });

  test("the row's day is stamped from the same clock the gate reads", () => {
    const sink = fakeSink();
    const now = new Date(2026, 8, 4, 23, 59);
    chargeRefusal(sink, { userId: USER, convId: "c_3", model: "m", now });
    expect(sink.rows[0]?.day).toBe("2026-09-04");
    // `at` stays a UTC instant. The two answer different questions and both are wanted.
    expect(sink.rows[0]?.at).toBe(now.toISOString());
  });
});

describe("the ledger is the quota's only input", () => {
  // Set up in `beforeAll` rather than in the describe body: the body runs at COLLECTION
  // time, so pointing FINDERR_DATA_DIR at a scratch directory there would redirect the
  // config every other suite in this process sees before any of them had run.
  let dir = "";
  let store: Store;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "finderr-ai-"));
    process.env.FINDERR_DATA_DIR = dir;
    store = new Store(loadConfig(true));
  });
  afterAll(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    // `= undefined` writes the STRING "undefined", which is a relative path and fails
    // validation on the next load. Delete it.
    delete process.env.FINDERR_DATA_DIR;
    loadConfig(true);
  });

  const now = new Date(2026, 8, 4, 12, 0);
  const day = localDay(now);

  test("an empty ledger is zero, not null", () => {
    // `sum()` over no rows is SQL NULL, and a NaN here compares false against every limit
    // and silently opens the gate.
    expect(store.aiSpendUsd("u_nobody", day)).toBe(0);
  });

  test("spend is the sum of the day's rows, whatever their outcome", () => {
    const run = { model: "m", promptTokens: 1, completionTokens: 1, cachedTokens: 0, ms: 1 };
    chargeRun(store, { userId: USER, convId: "c_a", now }, { ...run, costUsd: 0.4 });
    chargeRun(store, { userId: USER, convId: "c_b", now }, { ...run, costUsd: 0.3, failure: "max_turns" });
    chargeRefusal(store, { userId: USER, convId: "c_c", model: "m", now });
    expect(store.aiSpendUsd(USER, day)).toBeCloseTo(0.7, 6);
  });

  test("yesterday's spend does not count against today", () => {
    const yesterday = new Date(2026, 8, 3, 12, 0);
    chargeRun(
      store,
      { userId: USER, convId: "c_d", now: yesterday },
      { model: "m", promptTokens: 1, completionTokens: 1, cachedTokens: 0, ms: 1, costUsd: 5 },
    );
    expect(store.aiSpendUsd(USER, day)).toBeCloseTo(0.7, 6);
    expect(store.aiSpendUsd(USER, localDay(yesterday))).toBeCloseTo(5, 6);
  });

  test("one person's spend is not another's", () => {
    chargeRun(
      store,
      { userId: "u_other", convId: "c_e", now },
      { model: "m", promptTokens: 1, completionTokens: 1, cachedTokens: 0, ms: 1, costUsd: 9 },
    );
    expect(store.aiSpendUsd(USER, day)).toBeCloseTo(0.7, 6);
  });

  test("the cap reads the table end to end", () => {
    const verdict = dailyCapVerdict({
      limitUsd: 0.5,
      spentToday: () => store.aiSpendUsd(USER, day),
      now,
    });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.spentUsd).toBeCloseTo(0.7, 6);
  });
});
