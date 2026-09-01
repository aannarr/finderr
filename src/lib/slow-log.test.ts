import { describe, expect, test } from "bun:test";
import { SlowLog } from "./slow-log";

const entry = (at: number, label: string, ms: number, detail = "") => ({ at, label, ms, detail });

describe("SlowLog", () => {
  test("keeps what it is given, newest first", () => {
    const log = new SlowLog();
    log.record(entry(1_000, "GET /api/browse", 900, "?genre=Comedy"));
    log.record(entry(2_000, "GET /api/discover", 700));

    expect(log.recent().map((e) => e.label)).toEqual(["GET /api/discover", "GET /api/browse"]);
    expect(log.recent()[1]?.detail).toBe("?genre=Comedy");
  });

  test("counts every breach ever, not just the ones still held", () => {
    const log = new SlowLog(2);
    for (let i = 0; i < 5; i++) log.record(entry(i, `r${i}`, 600));

    expect(log.n).toBe(5);
    expect(log.recent()).toHaveLength(2);
  });

  test("a full ring drops the OLDEST, never the newest", () => {
    const log = new SlowLog(3);
    for (const i of [1, 2, 3, 4, 5]) log.record(entry(i * 1_000, `r${i}`, 600));

    // r1 and r2 are gone; recency is the property this keeps, so a long tail of the same
    // slow route must never push the most recent one off the end.
    expect(log.recent().map((e) => e.label)).toEqual(["r5", "r4", "r3"]);
  });

  test("truncates an oversized detail rather than refusing it", () => {
    const log = new SlowLog();
    log.record(entry(1, "GET /api/search", 600, "x".repeat(500)));

    const detail = log.recent()[0]?.detail ?? "";
    expect(detail.length).toBeLessThan(500);
    expect(detail.endsWith("…")).toBe(true);
  });

  test("rounds the duration, because a fractional millisecond is noise", () => {
    const log = new SlowLog();
    log.record(entry(1, "GET /api/browse", 903.7261));

    expect(log.recent()[0]?.ms).toBe(904);
  });

  test("limit takes the newest N", () => {
    const log = new SlowLog();
    for (const i of [1, 2, 3]) log.record(entry(i * 1_000, `r${i}`, 600));

    expect(log.recent(2).map((e) => e.label)).toEqual(["r3", "r2"]);
  });
});
