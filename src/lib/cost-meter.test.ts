import { describe, expect, test } from "bun:test";
import { CostMeter } from "./cost-meter";

/** A clock the test drives, so nothing here waits on wall time. */
function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const meter = (clock: { now: () => number }, opts = {}) =>
  new CostMeter({ now: clock.now, contendedMs: 1_000, budgetMs: 500, soloBudgetMs: 5_000, ...opts });

describe("accounting", () => {
  test("attributes milliseconds to the caller that spent them", () => {
    const c = fakeClock();
    const m = meter(c);
    m.record("alice", 120);
    m.record("bob", 30);
    expect(m.spent("alice")).toBe(120);
    expect(m.spent("bob")).toBe(30);
    expect(m.busy()).toBe(150);
  });

  test("a caller nobody has seen has spent nothing, and asking does not create them", () => {
    const m = meter(fakeClock());
    expect(m.spent("nobody")).toBe(0);
    expect(m.report().tracked).toBe(0);
  });

  test("spend rolls off the far end of the window", () => {
    const c = fakeClock();
    const m = meter(c);
    m.record("alice", 400);
    expect(m.spent("alice")).toBe(400);
    c.advance(61_000);
    expect(m.spent("alice")).toBe(0);
    expect(m.busy()).toBe(0);
  });

  test("spend rolls off GRADUALLY, one bucket at a time", () => {
    const c = fakeClock();
    const m = meter(c);
    // One bucket is a tenth of a minute. Spend in three consecutive buckets.
    for (let i = 0; i < 3; i++) {
      m.record("alice", 100);
      c.advance(10_000);
    }
    expect(m.spent("alice")).toBe(300);
    // Walk far enough that the first of the three has aged out and the others have not.
    c.advance(40_000);
    expect(m.spent("alice")).toBeLessThan(300);
    expect(m.spent("alice")).toBeGreaterThan(0);
  });

  test("ignores a zero or negative measurement rather than trusting the clock", () => {
    const m = meter(fakeClock());
    m.record("alice", 0);
    m.record("alice", -5);
    expect(m.report().tracked).toBe(0);
  });
});

describe("the refusal is CONTENTION-gated", () => {
  test("a caller ALONE on the server is not refused for being over budget", () => {
    // THE CASE THE FAIRNESS RULE MUST NOT BREAK. Alice is four times over her own budget
    // and has pushed the server past the contention floor single-handedly -- but there is
    // nobody else in the window, so there is nobody she is denying. Refusing her here
    // would protect nothing and make the product worse on a quiet evening.
    const m = meter(fakeClock());
    m.record("alice", 2_000);
    expect(m.spent("alice")).toBeGreaterThan(m.budgetMs);
    expect(m.busy()).toBeGreaterThan(m.contendedMs);
    expect(m.shouldRefuse("alice")).toBe(false);
  });

  test("...but a RUNAWAY alone is still stopped, because the victim is the machine", () => {
    const m = meter(fakeClock());
    m.record("loop", 5_000);
    expect(m.shouldRefuse("loop")).toBe(true);
  });

  test("under the contention floor nobody is refused", () => {
    const m = meter(fakeClock());
    m.record("alice", 600); // over her 500 ms budget
    m.record("bob", 100); // ...and bob is here, so the victim clause is satisfied
    expect(m.busy()).toBeLessThan(m.contendedMs);
    expect(m.shouldRefuse("alice")).toBe(false);
  });

  test("the greedy caller is refused and the quiet one beside them is not", () => {
    const m = meter(fakeClock());
    m.record("greedy", 900);
    m.record("quiet", 200);
    expect(m.busy()).toBeGreaterThanOrEqual(m.contendedMs);
    expect(m.shouldRefuse("greedy")).toBe(true);
    expect(m.shouldRefuse("quiet")).toBe(false);
  });

  test("a refused caller recovers once their spend rolls off", () => {
    const c = fakeClock();
    const m = meter(c);
    m.record("greedy", 900);
    m.record("other", 200);
    expect(m.shouldRefuse("greedy")).toBe(true);
    c.advance(61_000);
    expect(m.shouldRefuse("greedy")).toBe(false);
  });

  test("a budget of zero disables refusal entirely -- the zero-is-unlimited convention", () => {
    const m = meter(fakeClock(), { budgetMs: 0 });
    m.record("greedy", 999_999);
    expect(m.shouldRefuse("greedy")).toBe(false);
  });
});

describe("the meter cannot become the leak it measures", () => {
  test("tracked keys are capped", () => {
    const m = meter(fakeClock(), { maxKeys: 10 });
    for (let i = 0; i < 100; i++) m.record(`caller-${i}`, 1);
    expect(m.report().tracked).toBeLessThanOrEqual(10);
  });

  test("eviction drops the CHEAPEST caller, never the newest", () => {
    // The failure this pins: evicting the newest lets an attacker rotating addresses
    // push their own record out of the meter, which is exactly backwards.
    const m = meter(fakeClock(), { maxKeys: 3 });
    m.record("whale", 5_000);
    m.record("minnow-a", 1);
    m.record("minnow-b", 1);
    m.record("newcomer", 10);
    expect(m.spent("whale")).toBe(5_000);
    expect(m.spent("newcomer")).toBe(10);
  });

  test("shouldRefuse does not get slower as the caller count grows", () => {
    /*
      THE GUARD'S OWN COST MUST NOT BE CHOSEN BY THE ATTACKER.

      `busy()` used to sum the per-caller map, so `shouldRefuse` was O(tracked callers) --
      1,998 ns at 51 callers on the M1 Max, 2026-09-07 -- and the caller count is exactly
      what somebody rotating source addresses controls. A ratio rather than an absolute
      number, because this has to pass on CI hardware nobody has benchmarked: the shape is
      the assertion, not the speed.
    */
    const time = (callers: number) => {
      const m = new CostMeter();
      for (let i = 0; i < callers; i++) m.record(`c${i}`, 1);
      const N = 20_000;
      const t0 = Bun.nanoseconds();
      for (let i = 0; i < N; i++) m.shouldRefuse("c0");
      return (Bun.nanoseconds() - t0) / N;
    };
    time(10); // warm the JIT so the first real sample is not the slow one
    const few = time(10);
    const many = time(2_000);
    // 200x the callers. Linear would be ~200x; a generous 8x still catches it.
    expect(many).toBeLessThan(few * 8);
  });

  test("one caller making many calls costs one fixed record", () => {
    const m = meter(fakeClock());
    for (let i = 0; i < 10_000; i++) m.record("alice", 0.01);
    expect(m.report().tracked).toBe(1);
    expect(m.spent("alice")).toBeCloseTo(100, 1);
  });
});

describe("report", () => {
  test("ranks callers by spend and gives each a share", () => {
    const m = meter(fakeClock());
    m.record("big", 750);
    m.record("small", 250);
    const r = m.report();
    expect(r.callers[0].key).toBe("big");
    expect(r.callers[0].share).toBeCloseTo(0.75, 2);
    expect(r.busyMs).toBe(1000);
  });

  test("says whether the server is contended, which is the field to alert on", () => {
    const c = fakeClock();
    const m = meter(c);
    expect(m.report().contended).toBe(false);
    m.record("alice", 1_500);
    expect(m.report().contended).toBe(true);
  });

  test("counts refusals per caller, which is the evidence a slow evening is explained by", () => {
    const m = meter(fakeClock());
    m.record("greedy", 900);
    m.record("other", 200);
    m.shouldRefuse("greedy");
    m.shouldRefuse("greedy");
    expect(m.report().refusals).toEqual([{ key: "greedy", count: 2 }]);
  });

  test("an idle meter reports zero saturation and no callers", () => {
    const r = meter(fakeClock()).report();
    expect(r.busyMs).toBe(0);
    expect(r.saturation).toBe(0);
    expect(r.callers).toEqual([]);
  });

  test("caps the caller list without capping the accounting behind it", () => {
    const m = meter(fakeClock());
    for (let i = 0; i < 50; i++) m.record(`c${i}`, i + 1);
    const r = m.report(5);
    expect(r.callers.length).toBe(5);
    expect(r.tracked).toBe(50);
    // The total is over EVERY caller, not just the five reported.
    expect(r.busyMs).toBe((50 * 51) / 2);
  });
});

describe("measure", () => {
  test("times the work and hands back what it returned", () => {
    const m = new CostMeter();
    const out = m.measure("alice", () => {
      let n = 0;
      for (let i = 0; i < 200_000; i++) n += i;
      return n;
    });
    expect(out).toBe((199_999 * 200_000) / 2);
    expect(m.spent("alice")).toBeGreaterThan(0);
  });

  test("charges the caller even when the work THROWS -- a failed expensive call still cost", () => {
    const m = new CostMeter();
    expect(() =>
      m.measure("alice", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(m.spent("alice")).toBeGreaterThan(0);
  });
});
