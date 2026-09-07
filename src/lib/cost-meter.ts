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
  private readonly maxKeys: number;
  private readonly now: () => number;
  private readonly bucketMs: number;

  constructor(opts: CostMeterOptions = {}) {
    this.windowMs = opts.windowMs ?? 60_000;
    this.contendedMs = opts.contendedMs ?? 6_000;
    this.budgetMs = opts.budgetMs ?? 3_000;
    this.soloBudgetMs = opts.soloBudgetMs ?? 12_000;
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
   * Should this caller be refused right now?
   *
   * TWO INDEPENDENT RULES, and the first is the one aannarr asked for.
   *
   *  1. **Fairness.** The server is contended, this caller is over budget, AND SOMEBODY
   *     ELSE IS ACTIVE. All three, because the question is "is this caller denying other
   *     users", and with nobody else in the window there is no one being denied -- refusing
   *     a lone reader on a quiet evening protects nothing and is just a worse product.
   *  2. **Runaway.** This caller alone is past `soloBudgetMs`, whoever else is about. No
   *     victim, but a client stuck in a retry loop still should not own the event loop
   *     indefinitely.
   *
   * The refusal is counted whether or not the caller retries: the count is the evidence an
   * operator reads on `/api/health` when somebody says searching felt slow last night.
   */
  shouldRefuse(key: string): boolean {
    if (this.budgetMs <= 0) return false;
    const mine = this.spent(key);
    const runaway = this.soloBudgetMs > 0 && mine >= this.soloBudgetMs;
    const unfair = this.busy() >= this.contendedMs && mine >= this.budgetMs && this.othersActive(key);
    if (!runaway && !unfair) return false;
    this.refusals.set(key, (this.refusals.get(key) ?? 0) + 1);
    return true;
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
    const refusals = [...this.refusals]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, topN);
    return {
      windowSeconds: Math.round(this.windowMs / 1000),
      busyMs: Math.round(busyMs),
      saturation: busyMs / this.windowMs,
      contended: busyMs >= this.contendedMs,
      callers: callers.slice(0, topN),
      tracked: this.spends.size,
      refusals,
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
