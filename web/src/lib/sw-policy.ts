/**
 * WHAT THE SERVICE WORKER DOES WITH ONE REQUEST -- as a pure function, decided here.
 *
 * The worker itself (`../sw.ts`) runs in a context with no DOM, no React and no test
 * harness worth the name, so everything that is a DECISION lives in this file and
 * everything that is an EFFECT lives in that one. Same split as `header-scroll.ts` and
 * `plex-poll.ts`, for the same reason: the interesting half is testable without a browser.
 *
 * > [!IMPORTANT] The default is PASSTHROUGH, and that is a security posture rather than
 * > laziness
 * > The server's route table is private by default (`withAuth` wraps the whole thing) and
 * > this mirrors it. A caching worker that guesses "probably static" about a path it does
 * > not recognise will one day put somebody's data in a cache that survives sign-out, on a
 * > device somebody else picks up. So a path earns caching by matching a rule below, and
 * > everything else goes to the network untouched.
 *
 * What this buys, and what it does not: every asset finderr serves is ALREADY
 * `immutable` or `no-cache` with a content hash, so the browser's own HTTP cache makes the
 * second load fast without any of this. The worker exists for the two things that cache
 * cannot do -- answer at all when the network is gone, and stop a flaky hotel wifi turning
 * a poster grid into a wall of broken images.
 */

/**
 * Where a cached response is kept.
 *
 * Three buckets rather than one, because they have three different eviction pressures: an
 * immutable chunk must outlive the page that asked for it, a poster is worth dropping long
 * before a chunk is, and the offline page must never be evicted at all.
 */
export type SwCache = "assets" | "images" | "static";

/**
 * What to do with a request.
 *
 * A discriminated union rather than a strategy string plus optional fields, so a plan that
 * names a cache always has one and the worker never checks for `undefined`.
 */
export type SwPlan =
  /** Hand it to the network and touch no cache. The default, and every mutation. */
  | { kind: "passthrough" }
  /**
   * Try the network; serve the offline page if it cannot be reached.
   *
   * NAVIGATIONS ONLY, AND THE RESPONSE IS NEVER STORED. Which HTML this origin returns for
   * `/` depends on the session cookie -- the app shell for a signed-in reader, a generic
   * sign-in page for everybody else (see the `fetch` handler in `src/server/index.ts`).
   * A worker that cached one would serve it to the other, which is the single thing the
   * two-bundle split exists to prevent. So the shell is always a real request, and the only
   * HTML this worker can produce from disk is a page that names nothing.
   */
  | { kind: "network-first" }
  /**
   * Serve from the cache when it is there, otherwise fetch and store it.
   *
   * Only for URLs whose content cannot change: content-hashed bundles, and images the
   * server itself labels `immutable`.
   */
  | { kind: "cache-first"; cache: SwCache; maxEntries: number }
  /**
   * Serve the cached copy at once and refresh it in the background.
   *
   * For the handful of unhashed static files -- icons, the manifest, studio logos -- whose
   * URL stays the same across releases. A release changes them at most once, and one stale
   * favicon for one load is the whole cost.
   */
  | { kind: "revalidate"; cache: SwCache; maxEntries: number };

/**
 * Caps, in entries, per bucket.
 *
 * Chosen against what a session actually touches rather than against a storage quota: a
 * front page draws ~60 posters and a browse pass a few hundred, so 400 images holds a long
 * evening and costs maybe 20 MB. The asset cap is deliberately generous -- it holds several
 * releases' worth of chunks, which is what keeps a page that is already open from failing
 * to load a lazy chunk after a deploy.
 */
export const SW_CACHE_LIMITS: Record<SwCache, number> = {
  assets: 120,
  images: 400,
  static: 40,
};

/**
 * A content-hashed build artifact: `main-PXWnD4Hp.js`, `styles-BlnI_DkS.css`.
 *
 * Matched on the hash rather than on the `/assets/` directory, because the directory is a
 * Vite default somebody could change in `vite.config.ts` without ever thinking about this
 * file, whereas the hash IS the promise that the bytes never change.
 */
const HASHED_ASSET = /-[A-Za-z0-9_-]{8,}\.(?:js|css|woff2?)$/;

/** Unhashed files that are still just files: icons, the manifest, bundled studio logos. */
const STATIC_FILE = /\.(?:png|jpe?g|svg|ico|webmanifest|woff2?)$/;

export interface SwRequestFacts {
  /** The full request URL. */
  url: URL;
  /** The origin the worker itself was served from. */
  scope: URL;
  method: string;
  /** `request.mode === "navigate"` -- the browser asking for a document. */
  isNavigation: boolean;
}

/**
 * The whole routing table, read top to bottom. The first rule that matches wins.
 */
export function planFor({ url, scope, method, isNavigation }: SwRequestFacts): SwPlan {
  // A cache can only ever answer a GET, and pretending otherwise is how a POST gets
  // swallowed. `HEAD` is excluded for the same reason it is uninteresting: nothing here
  // issues one.
  if (method !== "GET") return { kind: "passthrough" };

  // Somebody else's origin is somebody else's problem -- and their cache headers are
  // already doing whatever they intend. finderr talks to no third party from the browser
  // (every upstream is proxied), so this branch is a guard rather than a case.
  if (url.origin !== scope.origin) return { kind: "passthrough" };

  if (isNavigation) return { kind: "network-first" };

  /*
    THE API IS NEVER CACHED, and this is the rule that keeps the whole design honest.

    Every `/api` response is either private to one reader (`Cache-Control: private`) or
    reports live state -- what the library holds, where a request has got to. A stale answer
    here is not a slow app, it is an app that lies: a request shown as still searching after
    it finished, a title shown as missing after it arrived. The client's own in-memory cache
    exists for the speed half and knows when to invalidate itself; this worker does not and
    should not learn.
  */
  if (url.pathname.startsWith("/api/")) return { kind: "passthrough" };

  /*
    Posters and facet images, which the server serves `immutable` because they are keyed by
    a title id or by a hash of the upstream URL. This is the bucket that makes a bad
    connection survivable -- a grid of 60 posters is 60 chances to fail, and every one of
    them is a hole in the page.
  */
  if (url.pathname.startsWith("/img/")) {
    return { kind: "cache-first", cache: "images", maxEntries: SW_CACHE_LIMITS.images };
  }

  if (HASHED_ASSET.test(url.pathname)) {
    return { kind: "cache-first", cache: "assets", maxEntries: SW_CACHE_LIMITS.assets };
  }

  /*
    HTML that is not a navigation -- a prefetch, a hand-typed `/index.html`. It falls
    through to passthrough deliberately: the shell-per-session rule above applies to the
    bytes, not to how they were asked for, and `STATIC_FILE` must never grow an `html`
    branch. Spelt out rather than left implicit, because "it is just a file" is exactly the
    reasoning that would add one.
  */
  if (url.pathname.endsWith(".html")) return { kind: "passthrough" };

  if (STATIC_FILE.test(url.pathname)) {
    return { kind: "revalidate", cache: "static", maxEntries: SW_CACHE_LIMITS.static };
  }

  return { kind: "passthrough" };
}
