/**
 * The slowest things that recently happened, kept in memory and bounded.
 *
 * THE QUESTION THIS EXISTS TO ANSWER, and the day it was asked: 2026-09-01, "some lists
 * were very slow on the NAS -- check the log". There was nothing in the log to check.
 * finderr logged what each PLUGIN and each upstream HOST took (`Timings`, wired into the
 * facet path) and nothing at all about what a REQUEST took, so a render path that never
 * touches the network -- which is every list in this product -- could be slow for an
 * afternoon and leave no trace. The answer had to be measured by hand against the running
 * container, which is the definition of a fact nobody checks.
 *
 * `Timings` and this are two halves and neither replaces the other. A distribution says
 * "`/api/browse` is p95 3.6s"; it cannot say WHICH browse, and on this API the difference
 * between `?genre=Comedy` and `?kind=series` is 400x. So a sampler answers "is it slow",
 * and this answers "slow at what" -- it keeps the actual arguments of the calls that
 * breached the threshold.
 *
 * DELIBERATELY NOT PERSISTED, same rule and same reason as `Timings`: a latency is a
 * property of the running process, its index and its disk, and a row in SQLite would
 * outlive every condition that produced it. Writing a slow-query log to the database whose
 * slowness you are diagnosing is also a way to make it slower.
 */

export interface SlowEntry {
  /** Epoch milliseconds, so a reader can tell "just now" from "before the last deploy". */
  at: number;
  /** The aggregation key -- a route PATTERN, never a filled-in path. */
  label: string;
  ms: number;
  /**
   * What made this call this one: a query string, a filter, an id.
   *
   * Free text, because the caller knows what distinguishes its own calls and this does not.
   * Bounded on write -- see `DETAIL_MAX`.
   */
  detail: string;
}

/**
 * How many entries to keep.
 *
 * Small ON PURPOSE. This is read by a human triaging a report of slowness, and the useful
 * question is "what was slow in the last while", not "everything slow since boot" -- a long
 * tail of the same route with the same argument is one fact repeated, and it pushes the
 * interesting outlier off the end of what anybody actually reads.
 */
const CAPACITY = 64;

/** A detail longer than this is truncated rather than refused; it is a hint, not a record. */
const DETAIL_MAX = 200;

/**
 * A ring of the most recent breaches, newest first when read.
 *
 * A RING rather than a top-N heap, and the choice matters: a heap of the slowest calls ever
 * fills with one bad afternoon and then never changes, so the log stops reporting on the
 * present. Recency is the property being asked for.
 */
export class SlowLog {
  private readonly ring: SlowEntry[] = [];
  private at = 0;
  private breaches = 0;

  constructor(private readonly capacity: number = CAPACITY) {}

  /** Every breach ever, not just the ones still in the ring. */
  get n(): number {
    return this.breaches;
  }

  record(entry: SlowEntry): void {
    this.breaches++;
    const bounded: SlowEntry = {
      at: entry.at,
      label: entry.label,
      ms: Math.round(entry.ms),
      detail: entry.detail.length > DETAIL_MAX ? `${entry.detail.slice(0, DETAIL_MAX)}…` : entry.detail,
    };
    if (this.ring.length < this.capacity) this.ring.push(bounded);
    else {
      this.ring[this.at] = bounded;
      this.at = (this.at + 1) % this.capacity;
    }
  }

  /** Newest first, which is the order a reader triaging a complaint wants. */
  recent(limit = this.capacity): SlowEntry[] {
    return [...this.ring].sort((a, b) => b.at - a.at).slice(0, limit);
  }

  clear(): void {
    this.ring.length = 0;
    this.at = 0;
  }
}
