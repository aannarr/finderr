/**
 * A per-key request limiter, in memory.
 *
 * Two callers, two reasons. The AUTH routes are limited because an invite token is a
 * bearer secret an attacker can retry as fast as the network allows -- 32 random bytes are
 * not guessable, and the limiter is what makes that a fact about the system rather than a
 * fact about arithmetic. `/api/search` is limited because a fuzzy query is real CPU work
 * over a 1.27M-row index, so a loop of typos pins a core; that one predates any user
 * account and stays true no matter who is signed in.
 *
 * A FIXED WINDOW, not a token bucket, and the difference is deliberate: a fixed window
 * lets a burst through at a boundary but it is one integer and one timestamp per key, so
 * the limiter cannot itself become the memory leak it exists to prevent. Every entry is
 * dropped the moment its window is older than the sweep horizon.
 *
 * IN MEMORY, which means it resets on restart and does not span replicas. Both are fine
 * here -- there is exactly one finderr process and a restart is not an attack -- and both
 * are the reason this is a floor rather than a wall. A public deployment should still have
 * CloudFlare in front of it.
 */

interface Window {
  count: number;
  /** ms epoch when this window opened. */
  startedAt: number;
}

export class RateLimiter {
  private readonly windows = new Map<string, Window>();
  private lastSweep = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Consume one unit. `false` means refuse.
   *
   * A limit of 0 or less disables the limiter entirely rather than blocking everything --
   * "unlimited" is the readable meaning of a zero here, and the alternative is a config
   * typo that takes the whole app down.
   */
  take(key: string): boolean {
    if (this.limit <= 0) return true;
    const t = this.now();
    this.sweep(t);
    const w = this.windows.get(key);
    if (!w || t - w.startedAt >= this.windowMs) {
      this.windows.set(key, { count: 1, startedAt: t });
      return true;
    }
    if (w.count >= this.limit) return false;
    w.count += 1;
    return true;
  }

  /** Seconds until the caller's window rolls over. For `Retry-After`. */
  retryAfter(key: string): number {
    const w = this.windows.get(key);
    if (!w) return 0;
    return Math.max(1, Math.ceil((w.startedAt + this.windowMs - this.now()) / 1000));
  }

  /** Forget a key -- used after a SUCCESSFUL sign-in, so one person's typo is not a lockout. */
  clear(key: string): void {
    this.windows.delete(key);
  }

  size(): number {
    return this.windows.size;
  }

  /**
   * Drop expired windows, at most once per window length.
   *
   * Sweeping on every call would make each request O(keys); sweeping never would grow the
   * map by one entry per distinct IP forever, which on a public surface is the leak.
   */
  private sweep(t: number): void {
    if (t - this.lastSweep < this.windowMs) return;
    this.lastSweep = t;
    for (const [k, w] of this.windows) {
      if (t - w.startedAt >= this.windowMs) this.windows.delete(k);
    }
  }
}

/**
 * The key a limiter counts against: the caller's IP, as best we can know it.
 *
 * > [!CAUTION] `X-Forwarded-For` is a CLIENT-SUPPLIED header and trusting it blindly hands
 * > every attacker an unlimited number of identities
 * > It is read ONLY when `trustProxy` is set, which is on exactly when finderr sits behind
 * > Caddy or CloudFlare -- and then the LAST hop is the one to trust, because everything
 * > left of it was written by whoever was upstream, including the client. Without a proxy
 * > the socket address is the only honest answer.
 */
export function clientKey(
  req: Request,
  socketAddress: string | null,
  opts: { trustProxy: boolean } = { trustProxy: false },
): string {
  if (opts.trustProxy) {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) {
      const hops = xff
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const last = hops[hops.length - 1];
      if (last) return last;
    }
  }
  return socketAddress ?? "unknown";
}
