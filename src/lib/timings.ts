/**
 * How long things took, kept in memory, bounded, and cheap enough to record on every call.
 *
 * THE QUESTION THIS EXISTS TO ANSWER: a cold title takes about a second to fill in, and
 * before this there was no way to say which plugin, which facet or which host that second
 * belonged to. The answer was reconstructed by hand with a one-off harness -- twice -- and
 * a fact you have to rebuild a harness to learn is a fact nobody checks.
 *
 * Deliberately NOT persisted. A latency distribution is a property of the running process
 * and its network, and a row in SQLite would outlive the conditions that produced it; the
 * facet cache already records what came back, which is the durable half. This records how
 * long it took to arrive, for as long as the process that waited is still running.
 */

/**
 * The last `WINDOW` samples for one key, plus totals over all of them.
 *
 * A RING rather than a growing array: this records every outbound call and every provider
 * answer for the life of the process, and an unbounded array would be a slow leak on the
 * one path that must never be expensive. Percentiles come from the window, so they say
 * "recently" rather than "since boot", which is the more useful reading of a latency
 * number anyway -- and `n`, `total` and `max` are kept over everything, because those
 * three are the ones you want cumulative.
 */
const WINDOW = 256;

export interface SamplerReport {
  /** Every sample ever, not just the window. */
  n: number;
  /** Milliseconds, summed over every sample ever. */
  totalMs: number;
  maxMs: number;
  /** Over the last `WINDOW` samples. */
  p50Ms: number;
  p95Ms: number;
}

export class Sampler {
  private readonly ring: number[] = [];
  private at = 0;
  private count = 0;
  private sum = 0;
  private peak = 0;

  add(ms: number): void {
    this.count++;
    this.sum += ms;
    if (ms > this.peak) this.peak = ms;
    if (this.ring.length < WINDOW) this.ring.push(ms);
    else {
      this.ring[this.at] = ms;
      this.at = (this.at + 1) % WINDOW;
    }
  }

  get n(): number {
    return this.count;
  }

  report(): SamplerReport {
    const sorted = [...this.ring].sort((a, b) => a - b);
    return {
      n: this.count,
      totalMs: Math.round(this.sum),
      maxMs: Math.round(this.peak),
      p50Ms: Math.round(quantile(sorted, 0.5)),
      p95Ms: Math.round(quantile(sorted, 0.95)),
    };
  }
}

/** Nearest-rank, which needs no interpolation and is honest about a small window. */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? 0;
}

/**
 * A `Sampler` per key, created on first sight.
 *
 * The key is whatever the caller finds useful -- a hostname, `pluginId|facet` -- and this
 * deliberately does not care which. Two owners with different key spaces are two instances,
 * not two classes.
 */
export class Timings {
  private readonly by = new Map<string, Sampler>();

  add(key: string, ms: number): void {
    const s = this.by.get(key);
    if (s) s.add(ms);
    else this.by.set(key, new Sampler()).get(key)?.add(ms);
  }

  get(key: string): Sampler | undefined {
    return this.by.get(key);
  }

  keys(): string[] {
    return [...this.by.keys()];
  }

  /** Every key's report, worst total first -- which is the order you want to read it in. */
  report(): Record<string, SamplerReport> {
    const entries = [...this.by].map(([k, s]) => [k, s.report()] as const);
    entries.sort((a, b) => b[1].totalMs - a[1].totalMs);
    return Object.fromEntries(entries);
  }
}
