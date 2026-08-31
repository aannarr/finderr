import { describe, expect, test } from "bun:test";
import { clientKey, RateLimiter } from "./rate-limit";

/** A clock we own, so no test waits for a real minute to pass. */
function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("RateLimiter", () => {
  test("allows up to the limit, then refuses", () => {
    const c = clock();
    const rl = new RateLimiter(3, 60_000, c.now);
    expect([rl.take("a"), rl.take("a"), rl.take("a"), rl.take("a")]).toEqual([true, true, true, false]);
  });

  test("keys are independent -- one noisy address does not lock out the household", () => {
    const c = clock();
    const rl = new RateLimiter(1, 60_000, c.now);
    expect(rl.take("a")).toBe(true);
    expect(rl.take("a")).toBe(false);
    expect(rl.take("b")).toBe(true);
  });

  test("the window rolls over", () => {
    const c = clock();
    const rl = new RateLimiter(1, 60_000, c.now);
    rl.take("a");
    expect(rl.take("a")).toBe(false);
    c.advance(60_000);
    expect(rl.take("a")).toBe(true);
  });

  test("retryAfter is the seconds left in the window, never zero for a live key", () => {
    const c = clock();
    const rl = new RateLimiter(1, 60_000, c.now);
    rl.take("a");
    expect(rl.retryAfter("a")).toBe(60);
    c.advance(59_500);
    expect(rl.retryAfter("a")).toBe(1);
  });

  test("a successful sign-in clears the key, so one person's typos are not a lockout", () => {
    const c = clock();
    const rl = new RateLimiter(2, 60_000, c.now);
    rl.take("a");
    rl.take("a");
    expect(rl.take("a")).toBe(false);
    rl.clear("a");
    expect(rl.take("a")).toBe(true);
  });

  test("a limit of zero means unlimited, not blocked -- a config typo must not take the app down", () => {
    const rl = new RateLimiter(0);
    expect(Array.from({ length: 50 }, () => rl.take("a")).every(Boolean)).toBe(true);
  });

  /*
    The limiter must not become the leak it exists to prevent: one entry per distinct IP,
    kept forever, is a slow memory exhaustion on a public surface.
  */
  test("expired windows are swept rather than accumulating one entry per address", () => {
    const c = clock();
    const rl = new RateLimiter(5, 60_000, c.now);
    for (let i = 0; i < 100; i++) rl.take(`ip-${i}`);
    expect(rl.size()).toBe(100);
    c.advance(120_000);
    rl.take("someone-new");
    expect(rl.size()).toBe(1);
  });
});

describe("clientKey", () => {
  const req = (xff?: string) =>
    new Request("http://localhost/api/auth/state", xff ? { headers: { "x-forwarded-for": xff } } : {});

  test("without a trusted proxy the socket address is the only honest answer", () => {
    // Trusting a client-supplied header hands every attacker an unlimited supply of
    // identities, which is the same as having no limiter at all.
    expect(clientKey(req("1.2.3.4"), "10.0.0.9")).toBe("10.0.0.9");
  });

  test("with a trusted proxy the LAST hop wins -- everything left of it is client-written", () => {
    expect(clientKey(req("1.2.3.4, 10.0.0.1"), "10.0.0.9", { trustProxy: true })).toBe("10.0.0.1");
  });

  test("a missing address is still a key, so an unknown caller is limited rather than exempt", () => {
    expect(clientKey(req(), null)).toBe("unknown");
  });
});
