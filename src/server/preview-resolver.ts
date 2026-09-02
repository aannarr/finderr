import { type BulkheadPolicy, bulkhead } from "cockatiel";
import { RateLimiter } from "../lib/rate-limit";

/**
 * Where an Open Graph card's poster lives.
 *
 * A constant because THREE places must agree on it and two of them are far apart: the
 * route that serves it, the page that writes it into a tag a third party will cache for
 * weeks, and `AuthService.publicPaths()`, which is the edit that makes it anonymous-
 * reachable at all. A typo in the third would produce a card whose image 401s, which no
 * test of the first two would catch.
 */
export const PREVIEW_IMAGE_PATH = "/img/og";

/** The `/title/:tconst` shape a preview is served for. Nothing else gets one. */
export const PREVIEW_PATH = /^\/title\/(tt\d{7,8})$/;

/**
 * What an anonymous link preview is allowed to buy from the network, and nothing more.
 *
 * > [!CAUTION] `ArtworkService.serve()` is an unauthenticated amplifier if it is reached from here
 * > It resolves an unknown `tconst` by calling Radarr AND Sonarr, then fetches bytes from
 * > a CDN. There are ~1.27M valid tconsts in the index, every one of them a distinct URL
 * > an anonymous caller can name, so wiring a public preview straight into it points a
 * > stranger's `for` loop at this household's own NAS. That is the single hole this whole
 * > module exists to close: the preview path resolves through `tryResolve` or it does not
 * > resolve at all.
 *
 * **Two bounds, because one mechanism cannot express both halves of what aannarr asked
 * for** (2026-09-02: *"a steady stream is fine, but an overload where we queue up requests
 * is going to kill all systems involved... if queue is too long, we start dropping"*).
 *
 * - **Volume** is the `RateLimiter`: a fixed window, N resolutions per minute, process-wide.
 * - **Burst** is the `bulkhead`: concurrency 2 and **queue depth 0**. A fixed window on its
 *   own permits an entire minute's allowance in its first millisecond, which is precisely
 *   the pile-up that takes an arr down -- the limiter would report itself as holding while
 *   sixty sockets opened at once.
 *
 * **Both refuse INSTANTLY and neither ever queues.** A caller that waits is a caller
 * holding a connection, and enough of those is the outage by another route. The refusal is
 * not an error: the preview renders without a poster, which is a slightly worse unfurl and
 * a completely working page.
 *
 * **Global rather than per-caller, deliberately.** The resource being protected is one NAS
 * shared by everybody, and an attacker with a /64 of IPv6 defeats any per-address bound
 * for free. Per-caller limiting happens a layer up, on the page itself, where it is about
 * fairness rather than about survival.
 */
export class PreviewResolver {
  private readonly volume: RateLimiter;
  private readonly burst: BulkheadPolicy;
  private refusals = 0;
  private resolutions = 0;

  constructor(
    perMinute: number,
    /**
     * Concurrency 2, queue 0. Not configurable, and that is a judgement rather than an
     * oversight: the number that matters operationally is the per-minute volume, and a
     * queue depth an operator can raise is a queue depth somebody eventually raises.
     */
    concurrency = 2,
  ) {
    this.volume = new RateLimiter(perMinute);
    this.burst = bulkhead(concurrency, 0);
  }

  /**
   * Run `work` if both bounds allow it, or return `null` without calling it at all.
   *
   * `null` means "not now" and NEVER means "there is nothing here" -- the caller must not
   * cache it as an answer. Nothing here writes a negative row for that reason; a refusal
   * is a fact about this second, and the next unfurl of the same link should be free to
   * try again.
   */
  async tryResolve<T>(work: () => Promise<T>): Promise<T | null> {
    if (!this.volume.take(GLOBAL_KEY)) {
      this.refusals++;
      return null;
    }
    try {
      const out = await this.burst.execute(work);
      this.resolutions++;
      return out;
    } catch {
      // A `BulkheadRejectedError` and a genuinely failed lookup are the same thing to the
      // page: draw it without a poster. They are NOT the same thing to the operator, which
      // is what the counters below are for.
      this.refusals++;
      return null;
    }
  }

  /** For `/api/health`, so a preview surface that is quietly refusing everything is visible. */
  stats(): { resolutions: number; refusals: number } {
    return { resolutions: this.resolutions, refusals: this.refusals };
  }
}

/**
 * One bucket for the whole process.
 *
 * `RateLimiter` is keyed because its other two callers count per address; this one
 * deliberately does not, so the constant is named rather than being a bare string that
 * reads like a bug at the call site.
 */
const GLOBAL_KEY = "preview:global";
