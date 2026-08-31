import { describe, expect, test } from "bun:test";
import { Sampler, Timings } from "./timings";

describe("Sampler", () => {
  test("counts everything and keeps the extremes over every sample", () => {
    const s = new Sampler();
    for (const ms of [10, 500, 20]) s.add(ms);
    const r = s.report();
    expect(r.n).toBe(3);
    expect(r.totalMs).toBe(530);
    expect(r.maxMs).toBe(500);
  });

  test("an empty sampler reports zeroes rather than NaN", () => {
    // A key with no samples is reachable the instant a report is taken between the first
    // `add` and its first value, and a NaN in the health payload is a broken dashboard.
    expect(new Sampler().report()).toEqual({ n: 0, totalMs: 0, maxMs: 0, p50Ms: 0, p95Ms: 0 });
  });

  test("percentiles are nearest-rank over the samples", () => {
    const s = new Sampler();
    for (let i = 1; i <= 100; i++) s.add(i);
    const r = s.report();
    expect(r.p50Ms).toBe(50);
    expect(r.p95Ms).toBe(95);
  });

  /**
   * The window is what makes this safe to call on every outbound request for the life of
   * the process. `n`, `totalMs` and `maxMs` stay cumulative on purpose -- a max that a ring
   * buffer forgot is a slow call nobody will ever hear about again.
   */
  test("past the window, percentiles follow recent samples while totals do not forget", () => {
    const s = new Sampler();
    for (let i = 0; i < 300; i++) s.add(1000); // pushed out of the window below
    for (let i = 0; i < 300; i++) s.add(10);
    const r = s.report();
    expect(r.n).toBe(600);
    expect(r.p50Ms).toBe(10);
    expect(r.maxMs).toBe(1000);
    expect(r.totalMs).toBe(300 * 1000 + 300 * 10);
  });
});

describe("Timings", () => {
  test("keeps a distribution per key and creates one on first sight", () => {
    const t = new Timings();
    t.add("a", 5);
    t.add("a", 15);
    t.add("b", 1);
    expect(t.keys().sort()).toEqual(["a", "b"]);
    expect(t.report().a?.n).toBe(2);
    expect(t.report().a?.totalMs).toBe(20);
  });

  test("reports worst total first, which is the order it is read in", () => {
    const t = new Timings();
    t.add("cheap", 1);
    t.add("expensive", 900);
    t.add("middling", 100);
    expect(Object.keys(t.report())).toEqual(["expensive", "middling", "cheap"]);
  });
});
