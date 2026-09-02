import { describe, expect, test } from "bun:test";
import { clientKey, isPrivateAddress, RateLimiter } from "./rate-limit";

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

describe("isPrivateAddress", () => {
  test("the RFC1918 ranges, at both of their edges", () => {
    for (const addr of [
      "10.0.0.0",
      "10.255.255.255",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.10",
      "127.0.0.1",
      "169.254.1.1",
    ]) {
      expect({ addr, private: isPrivateAddress(addr) }).toEqual({ addr, private: true });
    }
  });

  // 172.15 and 172.32 sit either side of the /12 and are ordinary public space. Getting
  // that boundary wrong is the classic way this check ends up letting the internet in.
  test("addresses just outside 172.16.0.0/12 are public", () => {
    for (const addr of ["172.15.255.255", "172.32.0.1", "8.8.8.8", "203.0.113.9"]) {
      expect({ addr, private: isPrivateAddress(addr) }).toEqual({ addr, private: false });
    }
  });

  /*
    A dual-stack listener reports every IPv4 peer as `::ffff:a.b.c.d`, so a check that
    missed the mapped form would refuse the LAN on exactly the deployments this exists for.
  */
  test("IPv4-mapped IPv6 is unwrapped and judged on the address inside", () => {
    expect(isPrivateAddress("::ffff:192.168.1.12")).toBe(true);
    expect(isPrivateAddress("::ffff:8.8.8.8")).toBe(false);
  });

  test("IPv6 loopback, unique-local and link-local are private; anything routable is not", () => {
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("fd12:3456::1")).toBe(true);
    expect(isPrivateAddress("fe80::1%eth0")).toBe(true);
    expect(isPrivateAddress("[fd00::1]")).toBe(true);
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
  });

  // `clientKey` answers "unknown" when it has no address at all, and an unknown caller
  // must not pass a check whose whole job is to know where they came from.
  test('nothing, empty and "unknown" are all public', () => {
    for (const addr of [null, undefined, "", "   ", "unknown", "not-an-address", "10.0.0"]) {
      expect({ addr, private: isPrivateAddress(addr) }).toEqual({ addr, private: false });
    }
  });
});
