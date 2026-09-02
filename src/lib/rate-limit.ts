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
 *
 * The two address helpers at the bottom live here rather than in a module of their own
 * because they answer the same question the limiter asks -- *where is this caller* -- and
 * `clientKey`'s `X-Forwarded-For` caution applies verbatim to both. Splitting them would put
 * that caution in one file and its second reader in another.
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

/**
 * The private IPv4 and IPv6 ranges, as `[first byte(s)]` tests, in one table.
 *
 * Written as predicates over the parsed octets rather than as CIDR strings, because there is
 * no CIDR matcher in this codebase and adding one for six fixed ranges would be more code
 * than the ranges. Loopback and link-local count as private for this purpose: the question
 * being answered is "did this come from off the internet", not "is this RFC1918 exactly".
 */
const PRIVATE_V4: ReadonlyArray<(o: readonly number[]) => boolean> = [
  (o) => o[0] === 10,
  (o) => o[0] === 127,
  (o) => o[0] === 172 && (o[1] ?? 0) >= 16 && (o[1] ?? 0) <= 31,
  (o) => o[0] === 192 && o[1] === 168,
  (o) => o[0] === 169 && o[1] === 254,
];

/**
 * Is this source address one that cannot have come from the public internet?
 *
 * The second layer behind the arr webhook's password -- see `config.webhook.lanOnly`. It is
 * a NARROWING and never an authentication: anyone already inside the network passes it, and
 * behind a proxy the address it is given is only as honest as `clientKey` made it.
 *
 * IPv4-mapped IPv6 (`::ffff:10.0.0.1`) is unwrapped and re-tested, because a dual-stack
 * listener reports every IPv4 peer that way and a check that missed it would refuse the LAN
 * on exactly the deployments this exists for.
 */
export function isPrivateAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  // Strip a `[...]` wrapper and an IPv6 zone id (`fe80::1%eth0`) before anything else.
  const addr =
    address
      .trim()
      .replace(/^\[|\]$/g, "")
      .split("%")[0]
      ?.toLowerCase() ?? "";
  if (addr === "") return false;

  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (mapped?.[1]) return isPrivateAddress(mapped[1]);

  if (addr.includes(":")) {
    // ::1 loopback, fc00::/7 unique-local, fe80::/10 link-local. Everything else routes.
    if (addr === "::1") return true;
    return /^f[cd]/.test(addr) || /^fe[89ab]/.test(addr);
  }

  const octets = addr.split(".").map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return PRIVATE_V4.some((test) => test(octets));
}
