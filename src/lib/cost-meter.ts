/**
 * How much of the machine each caller actually ATE in the last minute, and whether that is
 * starving anybody else.
 *
 * > [!IMPORTANT] `RateLimiter` counts REQUESTS. This counts MILLISECONDS. They are not two
 * > spellings of one idea and neither replaces the other.
 * > A request limit is the right defence against a bearer token being retried, because
 * > there every attempt costs the same. It is the WRONG defence against expense, because
 * > requests on this server differ in cost by three orders of magnitude: a cached shelf read
 * > is ~0.1 ms and a 32-token fuzzy search over 1.27M rows is tens of ms. Measured
 * > 2026-09-07, the same 25-request budget buys either 2 ms or 26 seconds of the event loop
 * > depending only on what the caller typed -- so a limiter counting requests reports both
 * > callers as equally well behaved while one of them owns the box.
 * >
 * > `src/lib/input-guards.ts` caps how expensive a SINGLE call can be. This caps how much a
 * > caller may spend in AGGREGATE. Both are needed: 400 legal 25 ms searches cost the same
 * > ten seconds as one illegal payload, and no per-request cap can see that.
 *
 * **CONTENTION IS PART OF THE RULE, and it is what makes this fair rather than merely
 * strict.** A single reader alone on an idle server may use the whole thing -- refusing
 * them protects nobody and the machine was doing nothing else. The refusal only arms once
 * the window's total metered time crosses `contendedMs`, which is the point at which one
 * caller's next query genuinely delays somebody else's. So the failure mode this defends
 * against is the real one (several callers, one of them greedy) and the ordinary case
 * (one household member searching hard on a quiet evening) is untouched.
 *
 * IN MEMORY, resetting on restart, not spanning replicas -- the same three caveats
 * `RateLimiter` states and for the same reasons. One finderr process, one event loop.
 */

/**
 * How the window is cut up.
 *
 * Six buckets of ten seconds rather than a list of timestamped events: a caller's whole
 * history is a fixed six-element array that is overwritten in place, so a caller making
 * 10,000 calls a minute costs exactly as much memory as one making a single call. An event
 * list is the shape that lets the meter become the leak it exists to measure.
 *
 * The price of bucketing is that the window is granular -- a "60 second" window is really
 * between 50 and 60 seconds of history depending on where in a bucket you ask. That is
 * irrelevant to every decision made here and it is why `RateLimiter` accepts the same
 * imprecision in its own fixed window.
 */
const BUCKETS = 6;

interface Spend {
  /** Milliseconds attributed to each bucket, indexed by absolute bucket number mod BUCKETS. */
  readonly ms: Float64Array;
  /** The absolute bucket number each slot currently holds, so a stale slot reads as zero. */
  readonly at: Float64Array;
}

/**
 * Add `ms` to a ring's slot for `bucket`.
 *
 * A slot still holding an OLDER bucket number is history that has rolled off the far end of
 * the window, so it is overwritten rather than added to. That single line is what makes the
 * ring self-expiring with no sweep, no timer and no allocation.
 */
function add(s: Spend, bucket: number, ms: number): void {
  const slot = bucket % BUCKETS;
  if (s.at[slot] !== bucket) {
    s.at[slot] = bucket;
    s.ms[slot] = 0;
  }
  s.ms[slot] += ms;
}

/**
 * What to do about a caller's next call.
 *
 * `slow` is not a soft refusal, it is a SERVED request that arrives late -- the handler runs
 * and the caller gets the right answer. That distinction is the whole point: see `verdict`.
 */
export interface Verdict {
  action: "allow" | "slow" | "refuse";
  /** Milliseconds to wait before running the handler. Zero for `allow` and for `refuse`. */
  delayMs: number;
}

export interface CallerSpend {
  key: string;
  ms: number;
  /** This caller's share of everything metered in the window, 0-1. `0` when nothing was. */
  share: number;
}

export interface MeterReport {
  windowSeconds: number;
  /** Total metered milliseconds in the window, across every caller. */
  busyMs: number;
  /** How much of the window's single-threaded time that is, 0-1. */
  saturation: number;
  /** Whether the meter is currently arming refusals at all. */
  contended: boolean;
  /** Callers, biggest spender first. Capped -- see `topN`. */
  callers: CallerSpend[];
  /** Distinct callers currently tracked. */
  tracked: number;
  /** Refusals issued since boot, per caller, biggest first. Empty is the healthy answer. */
  refusals: { key: string; count: number }[];
  /**
   * Tarpitted calls since boot, per caller.
   *
   * NOT a problem to alert on -- it is the system working, and a fast agent living here
   * permanently is the DESIGNED outcome rather than a failure. It is reported because it is
   * the answer to "why does that client feel slow", and without it the honest answer is
   * available only by reading the source.
   */
  slowed: { key: string; count: number }[];
}

export interface CostMeterOptions {
  /** Window length. 60s, because that is the question aannarr asked. */
  windowMs?: number;
  /**
   * Metered milliseconds in the window past which the server counts as CONTENDED and
   * refusals arm. Below it nobody is refused however much they spend.
   *
   * The honest denominator is one core-minute, because Bun runs one event loop and a
   * SQLite read blocks it -- so 60,000 ms is the whole window and this default of 6,000 is
   * 10% of it. Ten percent of the event loop spent on metered work is the point at which a
   * second caller starts waiting on the first.
   */
  contendedMs?: number;
  /**
   * What ONE caller may spend in the window once the server is contended.
   *
   * 3,000 ms is 5% of a core-minute. Measured 2026-09-07: a real search on the real index
   * runs 0.1-8 ms, so this is somewhere between 400 and 30,000 searches a minute -- no
   * human reaches it and no sane client does either. It is a wall for a loop, not a budget
   * a person is meant to feel.
   */
  budgetMs?: number;
  /**
   * What one caller may spend when they are the ONLY caller, before being refused anyway.
   *
   * The fairness rule above needs somebody to be unfair TO -- so it cannot fire for a
   * single reader alone on a quiet server, and it should not. But "nobody else is here" is
   * not a licence to pin the event loop forever: a runaway client in a retry loop at 3am
   * has no victim except the machine, and it should still be stopped.
   *
   * So this is the second, far higher ceiling that applies whoever is or is not about --
   * 12,000 ms, 20% of a core-minute, four times `budgetMs`. A human cannot reach it and a
   * loop reaches it in seconds.
   */
  soloBudgetMs?: number;
  /**
   * Where the tarpit stops and the refusal starts.
   *
   * Between `budgetMs` and here a contended over-spender is DELAYED and served. Past it
   * they are refused, because a delay long enough to matter to somebody this far over would
   * be longer than the socket lives.
   *
   * Defaults to four times `budgetMs`. A well-behaved fast agent never leaves the delay
   * band: the delay paces its own loop and its spend falls back under budget within a
   * bucket or two.
   */
  refuseAtMs?: number;
  /**
   * The longest a tarpit may hold one request.
   *
   * Two ceilings decide this and the lower one wins. `Bun.serve`'s `idleTimeout` is 30
   * seconds, so anything approaching it turns a delay into a dropped connection -- a
   * refusal with the added cost of having held a socket to deliver it. And a person waiting
   * on a search gives up long before that. Two seconds is enough to halve a fast agent's
   * rate and short enough that a human who somehow reaches it sees a slow page rather than
   * a broken one.
   */
  maxDelayMs?: number;
  /**
   * The most requests that may sit in the tarpit at one time. Past it, refuse instead.
   *
   * See `admit` for why this cap is not optional. 64 matches `OUTBOUND_QUEUE_LIMIT` in
   * `plugin-fetch.ts` deliberately -- both answer "how much waiting work is this process
   * willing to hold", and two different answers to one question is two numbers to keep in
   * step.
   */
  maxConcurrentTarpits?: number;
  /**
   * The most callers tracked at once. The meter must not become the leak.
   *
   * On overflow the CHEAPEST caller is dropped, never the newest -- dropping the newest
   * would let an attacker rotating source addresses evict the record of their own spend,
   * which is precisely backwards.
   */
  maxKeys?: number;
  now?: () => number;
}

export class CostMeter {
  private readonly spends = new Map<string, Spend>();
  private readonly refusals = new Map<string, number>();
  /**
   * The same six-bucket ring again, for EVERY caller summed together.
   *
   * > [!IMPORTANT] This exists for cost, not for tidiness, and it was measured
   * > `busy()` originally summed the per-caller map, which made it O(tracked callers) --
   * > and `shouldRefuse` calls it on every single search. Measured 2026-09-07 on the M1
   * > Max with 51 callers tracked: **1,998 ns per `shouldRefuse`**, against 41 ns for a
   * > `record`. At the 4,096-key cap that is roughly 160 us added to every search, on a
   * > query that costs 2 ms -- an 8% tax.
   * >
   * > **And it got WORSE exactly under the load it defends against**, because the tracked
   * > key count is what an attacker rotating addresses controls. A guard whose cost is
   * > chosen by the attacker is a second denial-of-service with extra steps.
   * >
   * > Keeping the total as its own ring makes `busy()` six additions whoever is calling.
   * > Re-measured on the same machine after the change: **78 ns**, 25x better and flat in
   * > the caller count. `cost-meter.test.ts` pins the flatness, because a number in a
   * > comment cannot notice somebody putting the walk back.
   */
  private readonly totals: Spend = { ms: new Float64Array(BUCKETS), at: new Float64Array(BUCKETS).fill(-1) };
  readonly windowMs: number;
  readonly contendedMs: number;
  readonly budgetMs: number;
  readonly soloBudgetMs: number;
  readonly refuseAtMs: number;
  readonly maxDelayMs: number;
  readonly maxConcurrentTarpits: number;
  private inTarpit = 0;
  private readonly slowed = new Map<string, number>();
  private readonly maxKeys: number;
  private readonly now: () => number;
  private readonly bucketMs: number;

  constructor(opts: CostMeterOptions = {}) {
    this.windowMs = opts.windowMs ?? 60_000;
    this.contendedMs = opts.contendedMs ?? 6_000;
    this.budgetMs = opts.budgetMs ?? 3_000;
    this.soloBudgetMs = opts.soloBudgetMs ?? 12_000;
    this.refuseAtMs = opts.refuseAtMs ?? this.budgetMs * 4;
    this.maxDelayMs = opts.maxDelayMs ?? 2_000;
    this.maxConcurrentTarpits = opts.maxConcurrentTarpits ?? 64;
    this.maxKeys = opts.maxKeys ?? 4_096;
    this.now = opts.now ?? Date.now;
    this.bucketMs = this.windowMs / BUCKETS;
  }

  /**
   * Attribute `ms` of work to `key`.
   *
   * Called AFTER the work, with what it actually cost -- never with an estimate. An
   * estimate is the thing this exists to replace.
   */
  record(key: string, ms: number): void {
    if (!(ms > 0)) return;
    const bucket = Math.floor(this.now() / this.bucketMs);
    let s = this.spends.get(key);
    if (!s) {
      if (this.spends.size >= this.maxKeys) this.evictCheapest();
      s = { ms: new Float64Array(BUCKETS), at: new Float64Array(BUCKETS).fill(-1) };
      this.spends.set(key, s);
    }
    add(s, bucket, ms);
    add(this.totals, bucket, ms);
  }

  /** What this caller has spent inside the window. */
  spent(key: string): number {
    const s = this.spends.get(key);
    return s ? this.sum(s) : 0;
  }

  /**
   * Everything metered in the window, across every caller.
   *
   * Six additions, whoever is calling and however many of them there are -- see `totals`
   * for why that is the property that matters here rather than an optimisation.
   */
  busy(): number {
    return this.sum(this.totals);
  }

  /**
   * What should happen to this caller's next call?
   *
   * > [!IMPORTANT] THREE ANSWERS, NOT TWO, AND THE MIDDLE ONE IS THE IMPORTANT ONE
   * > aannarr, 2026-09-07: *"we should be able to 429 or tarpit bad users (or agents!!!)..
   * > users are probably good, but agents can be BAD - not because of intentions, just
   * > because they are fast!"*
   * >
   * > That is the whole design brief for this method. **The realistic heavy caller is not
   * > an attacker, it is a correct client with no sense of pace** -- an agent walking a
   * > filmography, a script backfilling a watchlist, a retry loop that works. A 429 is the
   * > wrong tool for all three: it BREAKS them, they surface an error to somebody, and a
   * > well-written one retries immediately and arrives back here in a millisecond having
   * > learned nothing.
   * >
   * > A DELAY teaches what a refusal cannot. The caller keeps getting correct answers, its
   * > own loop paces itself against our response time with no client-side change at all,
   * > and the machine stops being eaten. The refusal is kept for what a delay cannot fix:
   * > a caller so far over that waiting for them is worse than losing them.
   *
   * The delay is PROPORTIONAL to the overspend rather than fixed, so a caller barely over
   * is barely slowed and one at four times the budget waits properly. `maxDelayMs` caps it
   * below `Bun.serve`'s `idleTimeout`, because a tarpit long enough to time out the socket
   * is a refusal wearing a delay's clothes -- with the extra cost of having held a
   * connection open to deliver it.
   */
  verdict(key: string): Verdict {
    if (this.budgetMs <= 0) return { action: "allow", delayMs: 0 };
    const mine = this.spent(key);

    // Runaway: past the solo ceiling, whoever else is about. No victim but the machine.
    if (this.soloBudgetMs > 0 && mine >= this.soloBudgetMs) return this.refusal(key);

    // Fairness: contended, over budget, AND somebody else is being denied. All three --
    // with nobody else in the window there is nobody to be fair to.
    if (!(this.busy() >= this.contendedMs && mine >= this.budgetMs && this.othersActive(key))) {
      return { action: "allow", delayMs: 0 };
    }

    // Over the fair share while others wait, but not yet a runaway: SLOW them down.
    if (mine >= this.refuseAtMs) return this.refusal(key);
    const over = (mine - this.budgetMs) / Math.max(1, this.refuseAtMs - this.budgetMs);
    const delayMs = Math.min(this.maxDelayMs, Math.ceil(over * this.maxDelayMs));
    this.slowed.set(key, (this.slowed.get(key) ?? 0) + 1);
    return { action: "slow", delayMs: Math.max(1, delayMs) };
  }

  /**
   * The old boolean, kept for callers that only need the yes/no.
   *
   * It reports whether the verdict was a REFUSAL, so a caller being tarpitted reads as
   * `false` here -- which is correct: they are being served.
   */
  shouldRefuse(key: string): boolean {
    return this.verdict(key).action === "refuse";
  }

  private refusal(key: string): Verdict {
    this.refusals.set(key, (this.refusals.get(key) ?? 0) + 1);
    return { action: "refuse", delayMs: 0 };
  }

  /**
   * Is anyone OTHER than `key` spending inside the window? The victim clause.
   *
   * Subtraction rather than a walk, for the same reason `busy()` is: this runs on every
   * search and must not scale with how many callers an attacker has invented.
   */
  private othersActive(key: string): boolean {
    return this.busy() - this.spent(key) > 0;
  }

  /**
   * Seconds until this caller could next be under budget, for `Retry-After`.
   *
   * One bucket, always: the oldest tenth of their spend rolls off then, which is the
   * soonest anything can change. Promising less would be a lie and promising more would
   * hold a recovered caller out longer than the data supports.
   */
  retryAfter(): number {
    return Math.ceil(this.bucketMs / 1000);
  }

  /** What an operator sees. `topN` bounds a report, never the accounting behind it. */
  report(topN = 10): MeterReport {
    const callers: CallerSpend[] = [];
    for (const [key, s] of this.spends) {
      const ms = this.sum(s);
      if (ms > 0) callers.push({ key, ms: Math.round(ms), share: 0 });
    }
    /*
      The TOTAL comes from the ring, never from re-summing the callers above -- and after
      an eviction the two genuinely differ. An evicted caller's milliseconds were really
      spent and the machine was really busy for them, so they stay in the total while the
      row that attributed them is gone. Summing the visible rows instead would report the
      server as quieter than it was, on exactly the day enough distinct callers showed up
      to trigger an eviction. Shares are therefore of the honest denominator and can sum to
      less than 1, which is the truth rather than a rounding error.
    */
    const busyMs = this.busy();
    for (const c of callers) c.share = busyMs > 0 ? c.ms / busyMs : 0;
    callers.sort((a, b) => b.ms - a.ms);
    const rank = (m: Map<string, number>) =>
      [...m]
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, topN);
    return {
      slowed: rank(this.slowed),
      windowSeconds: Math.round(this.windowMs / 1000),
      busyMs: Math.round(busyMs),
      saturation: busyMs / this.windowMs,
      contended: busyMs >= this.contendedMs,
      callers: callers.slice(0, topN),
      tracked: this.spends.size,
      refusals: rank(this.refusals),
    };
  }

  /**
   * Time `work`, attribute it, and hand back what it returned.
   *
   * SYNCHRONOUS on purpose. Everything metered here blocks the event loop -- that is what
   * makes it worth metering -- and an async wrapper would attribute WALL time, which for a
   * call that awaits a provider counts somebody else's waiting as this caller's spend.
   */
  measure<T>(key: string, work: () => T): T {
    const t0 = Bun.nanoseconds();
    try {
      return work();
    } finally {
      this.record(key, (Bun.nanoseconds() - t0) / 1e6);
    }
  }

  private sum(s: Spend): number {
    const oldest = Math.floor(this.now() / this.bucketMs) - (BUCKETS - 1);
    let total = 0;
    for (let i = 0; i < BUCKETS; i++) if (s.at[i] >= oldest) total += s.ms[i];
    return total;
  }

  /**
   * Apply a verdict: wait if told to, and say whether the handler may run.
   *
   * > [!CAUTION] A TARPIT WITH NO CEILING IS THE DENIAL OF SERVICE IT WAS ADDED TO PREVENT
   * > Each delayed request holds a live connection and a slot in whatever the runtime's
   * > socket budget is, for as long as the delay lasts. A caller who does not care about
   * > latency -- which is every automated one -- can therefore convert the tarpit into a
   * > connection-exhaustion attack for free, and the harder they are tarpitted the more
   * > connections they hold. **The defence and the vulnerability are the same mechanism.**
   * >
   * > So the number of SIMULTANEOUS tarpitted requests is capped, and past the cap the
   * > answer is an immediate refusal. A delay we cannot afford to hold is a refusal
   * > already; issuing it as one costs nothing and holds nothing.
   *
   * `sleep` is injected so a test drives it with a fake and no suite waits on wall time.
   */
  async admit(
    key: string,
    sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
  ): Promise<{ allowed: boolean; waitedMs: number }> {
    const v = this.verdict(key);
    if (v.action === "refuse") return { allowed: false, waitedMs: 0 };
    if (v.action === "allow") return { allowed: true, waitedMs: 0 };
    if (this.inTarpit >= this.maxConcurrentTarpits) {
      this.refusals.set(key, (this.refusals.get(key) ?? 0) + 1);
      return { allowed: false, waitedMs: 0 };
    }
    this.inTarpit += 1;
    try {
      await sleep(v.delayMs);
    } finally {
      this.inTarpit -= 1;
    }
    return { allowed: true, waitedMs: v.delayMs };
  }

  /** How many requests are sitting in the tarpit right now. Reported, so it is visible. */
  get tarpitted(): number {
    return this.inTarpit;
  }

  private evictCheapest(): void {
    let victim: string | null = null;
    let least = Number.POSITIVE_INFINITY;
    for (const [key, s] of this.spends) {
      const ms = this.sum(s);
      if (ms < least) {
        least = ms;
        victim = key;
      }
    }
    if (victim !== null) this.spends.delete(victim);
  }
}
