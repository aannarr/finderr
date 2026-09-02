/**
 * What people actually type, and what they actually click.
 *
 * THE PROBLEM THIS EXISTS TO END: `CANARY_CASES` (`./canary.ts`) is a suite written by an
 * agent, it passes 100%, and every scoring constant in `SearchEngine.rank` was chosen to
 * make those cases pass. That is a suite grading its own homework. Nothing in this repo
 * has ever compared a canary case to a query a human typed, so the scorer is tuned against
 * an imagined user. This module collects the real ones so the retune has evidence.
 *
 * > [!IMPORTANT] A ROW HOLDS NO IDENTITY, and that is a ruling rather than an oversight
 * > No session id, no user id, no address, no cookie -- a search row is the query string, a
 * > timestamp and a result count, and a click row adds only which title was opened and at
 * > what rank. That was decided on the card (`finderr-search-tuning-against-real-queries-
 * > not-invented-ones`, D4, 2026-09-02) on the same rule `visibleRequest` in `./auth.ts`
 * > already enforces for `requested_by`: identity is stripped on the SERVER, not merely
 * > left undrawn by a component. A table that holds a session id still holds it after
 * > somebody decides the retention window was too long.
 * >
 * > So do not add a column here that narrows a row to a person, and do not add one
 * > "temporarily to debug something" -- there is no reader of this data that needs one.
 *
 * THE TIER IS DELIBERATELY NOT STORED on a search row, and the omission is what makes the
 * minimal row sufficient. Which tier answered a query is a pure function of the query and
 * the index, so `src/jobs/search-report.ts` recovers it by REPLAYING the logged query
 * against the live engine -- which is the same act the retune has to perform anyway. A
 * stored tier would be a second copy of a derivable fact, and it would be the copy that
 * goes stale the first time the scorer changes.
 *
 * NOTHING HERE TOUCHES SQLITE. The buffer is in memory and a flush timer hands settled rows
 * to a sink, because the card's constraint is that logging must never be a write a searcher
 * waits on -- `bun:sqlite` is synchronous, so an insert on the render path holds the event
 * loop for every other request on the page (the measurement behind `web/src/lib/debounce.ts`).
 */

import { isTier, type Tier } from "./search";

/** One query somebody ran, and how many rows they were shown for it. */
export interface SearchRow {
  /** As typed, trimmed, bounded by `QUERY_MAX`. */
  query: string;
  /** Epoch milliseconds. */
  at: number;
  /**
   * Rows the searcher was SHOWN, so `0` is the failure this log exists to find.
   *
   * The page, not the corpus: it is capped by the request's `limit`, so it answers "did
   * this query work" and must not be read as a statistic about how much the index holds.
   */
  results: number;
}

/** One result somebody opened, and where it was sitting when they did. */
export interface ClickRow {
  query: string;
  tconst: string;
  /** Zero-based position in the grid. A click on rank 4 is a ranking failure. */
  rank: number;
  /** Which tier produced the list, echoed back by the client from the search response. */
  tier: Tier;
  at: number;
}

/** Where settled rows go. `Store` implements it; a test passes a recording double. */
export interface SearchLogSink {
  writeSearches(rows: readonly SearchRow[]): void;
  writeClicks(rows: readonly ClickRow[]): void;
}

/** A query longer than this is truncated rather than refused. Nobody types 200 characters. */
export const QUERY_MAX = 200;

/**
 * How long a query must stand unextended before it counts as one somebody meant.
 *
 * The search box debounces at 150ms (`SEARCH_DEBOUNCE_MS`), so typing "the matrix" still
 * sends "the matr" and "the matrix" whenever the typist pauses mid-word. Logging both would
 * fill the table with prefixes of one query and then tune the scorer against fragments
 * nobody was searching for -- the exact failure the card names, arriving by a new route.
 *
 * Two seconds is comfortably longer than any mid-word pause and comfortably shorter than
 * the gap between two queries somebody meant separately.
 */
export const TYPING_WINDOW_MS = 2000;

/** How often the buffer is drained. Not configurable: no operator decision sits behind it. */
export const FLUSH_MS = 30_000;

/**
 * Rows held before the sink is offered them, per kind.
 *
 * A ceiling rather than a target: at one flush every 30s a real household never reaches
 * three figures, and the bound exists so a client looping on the click endpoint costs
 * memory that stops growing rather than memory that does not.
 */
const CAPACITY = 2000;

/**
 * The queries somebody MEANT, out of the prefixes they typed on the way.
 *
 * Drops a row when a LATER row within `windowMs` starts with it -- which covers both the
 * mid-word pause ("the matr" then "the matrix") and the plain repeat ("dune" then "dune",
 * from a Back navigation), because a string starts with itself.
 *
 * Exported and pure so the policy can be argued with in a test rather than inferred from
 * the shape of the table afterwards.
 */
export function settledSearches(rows: readonly SearchRow[], windowMs = TYPING_WINDOW_MS): SearchRow[] {
  const lowered = rows.map((r) => r.query.toLowerCase());
  return rows.filter((row, i) => {
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[j].at - row.at > windowMs) break;
      if (lowered[j].startsWith(lowered[i])) return false;
    }
    return true;
  });
}

/** Trimmed and bounded. A hint about what somebody searched for, never a document. */
function boundedQuery(raw: string): string {
  const q = raw.trim();
  return q.length > QUERY_MAX ? q.slice(0, QUERY_MAX) : q;
}

/**
 * What the click endpoint accepts, as a row or as nothing.
 *
 * Pure, and it lives beside the type it produces rather than in the route, so the shape of
 * a stored click has one owner. Anything unrecognised is `null` and the route answers 400:
 * a malformed click is a client bug, and silently storing a coerced version of it would put
 * junk in the one table whose whole value is that a human really did that.
 */
export function parseClickBody(body: unknown, at: number): ClickRow | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.query !== "string" || typeof b.tconst !== "string") return null;
  if (typeof b.rank !== "number" || !Number.isInteger(b.rank) || b.rank < 0) return null;
  if (!isTier(b.tier)) return null;
  // The id space we index, matched here so a click cannot introduce a title id nothing
  // else in this product could ever have produced.
  if (!/^tt\d+$/.test(b.tconst)) return null;
  const query = boundedQuery(b.query);
  if (query.length === 0) return null;
  return { query, tconst: b.tconst, rank: b.rank, tier: b.tier, at };
}

/**
 * What the server calls, which is deliberately less than what `SearchLog` is.
 *
 * The route handlers and the flush timer see only these four, so the off switch below can
 * be an object literal rather than a subclass carrying a buffer it never fills.
 */
export interface SearchLogger {
  searched(query: string, results: number, at?: number): void;
  clicked(row: ClickRow): void;
  flush(now?: number): void;
  report(): SearchLogStats;
}

export interface SearchLogStats {
  /** Rows waiting for the next flush, both kinds together. */
  pending: number;
  /** Search rows written since boot, after settling. */
  searches: number;
  clicks: number;
  /** Rows refused because a buffer was full. Non-zero means somebody is looping. */
  dropped: number;
}

/**
 * The buffer between the render path and the table.
 *
 * `record` is an array push and nothing else, so the cost a searcher pays for being logged
 * is one allocation. Everything expensive -- settling, the insert, the prune -- happens on
 * `flush`, which the server drives from a timer with nobody waiting on it.
 */
export class SearchLog implements SearchLogger {
  private searches: SearchRow[] = [];
  private clicks: ClickRow[] = [];
  private stats: SearchLogStats = { pending: 0, searches: 0, clicks: 0, dropped: 0 };

  constructor(
    private readonly sink: SearchLogSink,
    private readonly typingWindowMs: number = TYPING_WINDOW_MS,
    private readonly capacity: number = CAPACITY,
  ) {}

  searched(query: string, results: number, at: number = Date.now()): void {
    const bounded = boundedQuery(query);
    if (bounded.length === 0) return;
    if (this.searches.length >= this.capacity) {
      this.stats.dropped++;
      return;
    }
    this.searches.push({ query: bounded, at, results });
  }

  clicked(row: ClickRow): void {
    if (this.clicks.length >= this.capacity) {
      this.stats.dropped++;
      return;
    }
    this.clicks.push(row);
  }

  /**
   * Hand the sink everything that has settled, and keep the rest.
   *
   * A search row younger than the typing window is HELD RATHER THAN WRITTEN, because
   * settling can only see the rows it is given: flushing on a fixed timer without this
   * would split "the matr" from "the matrix" across two batches whenever the boundary fell
   * between them, and write the prefix as if nobody had extended it.
   */
  flush(now: number = Date.now()): void {
    const cutoff = now - this.typingWindowMs;
    const ripe = this.searches.filter((r) => r.at <= cutoff);
    this.searches = this.searches.filter((r) => r.at > cutoff);

    const settled = settledSearches(ripe, this.typingWindowMs);
    if (settled.length > 0) {
      this.sink.writeSearches(settled);
      this.stats.searches += settled.length;
    }
    if (this.clicks.length > 0) {
      this.sink.writeClicks(this.clicks);
      this.stats.clicks += this.clicks.length;
      this.clicks = [];
    }
  }

  report(): SearchLogStats {
    return { ...this.stats, pending: this.searches.length + this.clicks.length };
  }
}

/**
 * A log that is switched off: same shape, no memory, no rows.
 *
 * A null object rather than an `if (cfg.searchLog.enabled)` at each of the three call
 * sites, so "logging is off" is one decision made once at boot instead of a condition every
 * caller has to remember to repeat.
 */
export const NO_SEARCH_LOG: SearchLogger = {
  searched: () => {},
  clicked: () => {},
  flush: () => {},
  report: () => ({ pending: 0, searches: 0, clicks: 0, dropped: 0 }),
};
