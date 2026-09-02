import { describe, expect, test } from "bun:test";
import { PreviewResolver } from "./preview-resolver";

const never = () => Promise.reject(new Error("must not be called"));

describe("PreviewResolver", () => {
  test("lets a steady stream through", async () => {
    const r = new PreviewResolver(60);
    for (let i = 0; i < 10; i++) expect(await r.tryResolve(async () => "poster")).toBe("poster");
    expect(r.stats()).toEqual({ resolutions: 10, refusals: 0 });
  });

  test("refuses past the volume bound WITHOUT calling the work", async () => {
    const r = new PreviewResolver(3);
    for (let i = 0; i < 3; i++) await r.tryResolve(async () => "ok");
    // The point of the assertion is the callback, not the null: a bound that still runs
    // the lookup and throws the answer away protects nothing at all.
    expect(await r.tryResolve(never)).toBeNull();
    expect(r.stats().refusals).toBe(1);
  });

  test("zero disables resolution entirely", async () => {
    // `RateLimiter` treats <= 0 as UNLIMITED, so a resolver built naively on it would read
    // `resolvePerMinute: 0` as "no bound" -- the opposite of what an operator means. The
    // server wires the disable, and this pins the limiter's own meaning so the day someone
    // moves that check they find out here.
    const unlimited = new PreviewResolver(0);
    expect(await unlimited.tryResolve(async () => "ok")).toBe("ok");
  });

  test("a burst past the concurrency bound is DROPPED, never queued", async () => {
    const r = new PreviewResolver(100, 2);
    let running = 0;
    let peak = 0;
    const slow = async () => {
      running++;
      peak = Math.max(peak, running);
      await Bun.sleep(20);
      running--;
      return "poster";
    };

    const results = await Promise.all(Array.from({ length: 10 }, () => r.tryResolve(slow)));

    // Two ran, eight were refused on the spot. If the bulkhead had a queue these would all
    // eventually succeed -- slowly -- which is the failure mode this is built against.
    expect(peak).toBeLessThanOrEqual(2);
    expect(results.filter((x) => x === "poster")).toHaveLength(2);
    expect(results.filter((x) => x === null)).toHaveLength(8);
  });

  test("a failing lookup reads as a refusal rather than throwing at the page", async () => {
    const r = new PreviewResolver(10);
    expect(await r.tryResolve(async () => Promise.reject(new Error("radarr down")))).toBeNull();
    expect(r.stats().refusals).toBe(1);
  });
});
