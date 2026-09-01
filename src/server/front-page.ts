/**
 * The front page, held in memory and rebuilt by the timer that owns each part of it.
 *
 * ## What this is for
 *
 * `/api/discover` computed all fifteen shelves on every request. Measured 2026-09-01 after
 * the rank-seek fix: 74.8ms of index queries plus 17.6ms of store lookups, of which only
 * 2.2ms is the per-title state that can actually have changed since the last caller asked.
 * So the same fifteen queries were re-run for every visitor to produce, almost always,
 * byte-identical rows -- `/api/discover` takes no `Request` and is the same answer for
 * everybody.
 *
 * The point is not the milliseconds. It is that a computed front page is **O(corpus size)**:
 * a sixth genre shelf, or a bigger index, silently makes the first paint slower again and
 * you find out in a browser. A held page cannot.
 *
 * ## Three slots, because there are three writers
 *
 * Nothing here has a TTL, and that is deliberate -- see `ShelfTier`. Every shelf's rows come
 * from one of three things that already refresh on their own schedule, and each one calls
 * `refresh()` for its own tier when it has finished writing:
 *
 * | tier    | written by             | cadence            |
 * |---------|------------------------|--------------------|
 * | `arr`   | `refreshLibrary()`     | 60s                |
 * | `tmdb`  | `refreshTmdbLists()`   | 6h                 |
 * | `index` | the index swap         | daily, 09:00 UTC   |
 *
 * A 60-second refresh of "Recently added" therefore re-runs two mirror lookups and leaves
 * the five genre queries alone, because they cannot have changed. The staleness this adds
 * over computing per request is ZERO for the arr tier: the page was already reading a mirror
 * up to 60 seconds old.
 *
 * ## What is deliberately NOT held
 *
 * Two things stay on the request path because they change when a person clicks something,
 * and both are cheap:
 *
 *  - **`owned`**, applied by `assembleShelves`. Holding a shelf with the filter already
 *    baked in would keep offering you a film you downloaded an hour ago.
 *  - **`decorate()`** in the server entry -- `inLibrary`, `requestStatus`, `plex`. 2.2ms of
 *    map reads, and the one part of the payload a user's own action changes immediately.
 *
 * ## Memory
 *
 * Measured, not estimated: **139 KiB** for the whole page as a parsed object. It holds
 * candidates rather than final rows -- three per kept row, `CANDIDATE_FACTOR` -- so budget a
 * few hundred KiB. Against a container measured in tens of MB this is not a consideration,
 * which is why there is no eviction and no size cap here to go wrong.
 */

import type { TitleRow } from "../lib/search";
import {
  assembleShelves,
  type DiscoveryShelf,
  type ShelfDeps,
  type ShelfSpec,
  type ShelfTier,
  shelfSpecs,
} from "./shelves";

/** What `/api/health` says about the held page. */
export interface FrontPageStatus {
  enabled: boolean;
  /** True once every tier has been built at least once. */
  ready: boolean;
  /** ISO timestamp of each tier's last successful rebuild. */
  tiers: Record<ShelfTier, string | null>;
  /** Candidate rows held across every shelf. */
  rows: number;
}

const TIERS: ShelfTier[] = ["index", "tmdb", "arr"];

export class FrontPage {
  /** Candidates by shelf id. Unfiltered -- `owned` is applied per request. */
  private rows = new Map<string, TitleRow[]>();
  private builtAt = new Map<ShelfTier, string>();
  /**
   * The shape of the page, and the genre list behind it.
   *
   * Rebuilt with the INDEX tier and only there, because `topGenres()` is an index-tier fact
   * and the most expensive query on the page (38.8ms). Holding the specs is also what makes
   * `current()` free: it walks a list rather than re-deriving one.
   */
  private specs: ShelfSpec[] | null = null;

  constructor(private deps: () => ShelfDeps) {}

  /**
   * Recompute one tier's shelves.
   *
   * Every exit is safe to call at any point in boot. It THROWS nothing: the callers are
   * timers, and on 2026-09-01 four boot-path timers reading `live.current` before an index
   * existed turned a fresh install into a crash loop. A tier that cannot be built yet simply
   * is not built, and `ready` stays false until it is.
   */
  refresh(tier: ShelfTier): void {
    const deps = this.deps();
    if (tier === "index" || this.specs === null) {
      // The genre list rides with the index tier. A non-index refresh arriving first still
      // needs specs to exist, so it derives them once rather than no-opping forever.
      this.specs = shelfSpecs(deps, deps.engine.topGenres(5));
    }
    for (const spec of this.specs) {
      if (spec.tier !== tier) continue;
      this.rows.set(spec.id, spec.rows());
    }
    this.builtAt.set(tier, new Date().toISOString());
  }

  /** Every tier has answered at least once, so the page is complete rather than partial. */
  get ready(): boolean {
    return TIERS.every((t) => this.builtAt.has(t));
  }

  /**
   * The held page with `owned` applied, or `null` if it is not fully built yet.
   *
   * **`null` rather than a partial page.** A half-built front page renders as a handful of
   * shelves with the rest missing, which is indistinguishable on screen from a finderr that
   * has nothing to show -- so the caller falls back to computing it, which is correct and
   * costs what it always cost.
   */
  current(owned: ReadonlySet<string>): DiscoveryShelf[] | null {
    if (!this.ready || !this.specs) return null;
    return assembleShelves(this.specs, (spec) => this.rows.get(spec.id), owned);
  }

  status(enabled: boolean): FrontPageStatus {
    return {
      enabled,
      ready: this.ready,
      tiers: {
        index: this.builtAt.get("index") ?? null,
        tmdb: this.builtAt.get("tmdb") ?? null,
        arr: this.builtAt.get("arr") ?? null,
      },
      rows: [...this.rows.values()].reduce((n, r) => n + r.length, 0),
    };
  }
}
