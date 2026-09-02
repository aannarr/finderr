import { describe, expect, test } from "bun:test";
import { planFor, SW_CACHE_LIMITS, type SwPlan } from "./sw-policy";

const SCOPE = new URL("https://finderr.example.com/");

/** One request, described the way the worker describes it. GET, non-navigation by default. */
function plan(path: string, over: { method?: string; isNavigation?: boolean } = {}): SwPlan {
  return planFor({
    url: new URL(path, SCOPE),
    scope: SCOPE,
    method: over.method ?? "GET",
    isNavigation: over.isNavigation ?? false,
  });
}

describe("what never touches a cache", () => {
  /**
   * The rule the whole design rests on. Every `/api` response is either `Cache-Control:
   * private` or reports live state -- what the library holds, how far a download has got.
   * A stale one does not make the app slow, it makes it lie: a request shown as still
   * searching after it finished is worse than a spinner.
   */
  test("the API, in every shape", () => {
    expect(plan("/api/search?q=alien")).toEqual({ kind: "passthrough" });
    expect(plan("/api/title/tt1375666")).toEqual({ kind: "passthrough" });
    expect(plan("/api/requests")).toEqual({ kind: "passthrough" });
    // Including one that looks like a static file. The prefix decides, not the extension.
    expect(plan("/api/export/list.json")).toEqual({ kind: "passthrough" });
  });

  test("anything that is not a GET", () => {
    // A cache cannot answer a POST, and a worker that tries to is a request the server
    // never sees.
    expect(plan("/img/t/tt1375666", { method: "POST" })).toEqual({ kind: "passthrough" });
    expect(plan("/assets/main-PXWnD4Hp.js", { method: "HEAD" })).toEqual({ kind: "passthrough" });
  });

  test("another origin", () => {
    expect(
      planFor({
        url: new URL("https://image.tmdb.org/t/p/w500/poster.jpg"),
        scope: SCOPE,
        method: "GET",
        isNavigation: false,
      }),
    ).toEqual({ kind: "passthrough" });
  });

  /**
   * HTML fetched as a SUBRESOURCE -- a prefetch, a hand-typed `/index.html`.
   *
   * It is the same bytes as a navigation and the same session-dependent choice of shell, so
   * it gets the same answer for the same reason: this origin serves the app bundle to a
   * signed-in reader and a generic sign-in page to everybody else, and one cached copy
   * cannot be both.
   */
  test("HTML asked for as a file rather than navigated to", () => {
    expect(plan("/index.html")).toEqual({ kind: "passthrough" });
    expect(plan("/login.html")).toEqual({ kind: "passthrough" });
  });

  /**
   * The default. A path the table does not recognise gets no caching, so tomorrow's route
   * is safe by being unknown rather than by somebody remembering to exclude it.
   */
  test("a path no rule claims", () => {
    expect(plan("/some/route/added/next/month")).toEqual({ kind: "passthrough" });
  });
});

describe("documents", () => {
  test("a navigation goes to the network and falls back to the offline page", () => {
    expect(plan("/", { isNavigation: true })).toEqual({ kind: "network-first" });
    expect(plan("/title/tt1375666", { isNavigation: true })).toEqual({ kind: "network-first" });
  });

  /**
   * Navigation is checked BEFORE the API prefix and before the static-file test, because
   * `request.mode` is what the browser is actually doing and a path is only a hint. A deep
   * link to a client-side route that happens to end in `.png` is still a document.
   */
  test("being a navigation beats every path rule", () => {
    expect(plan("/api/anything", { isNavigation: true })).toEqual({ kind: "network-first" });
  });
});

describe("what is cached, and out of which bucket", () => {
  test("images, which the server itself calls immutable", () => {
    expect(plan("/img/t/tt1375666")).toEqual({
      kind: "cache-first",
      cache: "images",
      maxEntries: SW_CACHE_LIMITS.images,
    });
    expect(plan("/img/f/9f2c1ab4")).toEqual({
      kind: "cache-first",
      cache: "images",
      maxEntries: SW_CACHE_LIMITS.images,
    });
  });

  /**
   * Matched on the HASH, not on the `/assets/` directory: the directory is a Vite default
   * that `vite.config.ts` could change without anybody thinking about this file, while the
   * hash is the actual promise that the bytes at this URL never change.
   */
  test("content-hashed bundles, wherever the build decides to put them", () => {
    const hashed = {
      kind: "cache-first",
      cache: "assets",
      maxEntries: SW_CACHE_LIMITS.assets,
    } satisfies SwPlan;
    expect(plan("/assets/main-PXWnD4Hp.js")).toEqual(hashed);
    expect(plan("/assets/styles-BlnI_DkS.css")).toEqual(hashed);
    expect(plan("/build/chunk-AbCdEfGh12.js")).toEqual(hashed);
  });

  test("an unhashed script is NOT treated as immutable", () => {
    // `/sw.js` is the one that matters: caching the worker cache-first would pin the
    // version that is currently deciding what to cache, permanently.
    expect(plan("/sw.js")).toEqual({ kind: "passthrough" });
  });

  test("unhashed static files are refreshed behind the reader's back", () => {
    const soft = {
      kind: "revalidate",
      cache: "static",
      maxEntries: SW_CACHE_LIMITS.static,
    } satisfies SwPlan;
    expect(plan("/icon-192.png")).toEqual(soft);
    expect(plan("/favicon.svg")).toEqual(soft);
    expect(plan("/site.webmanifest")).toEqual(soft);
    expect(plan("/logos/a24.svg")).toEqual(soft);
  });
});

describe("the caps", () => {
  /**
   * Not a taste: a front page draws roughly sixty posters and a browsing session a few
   * hundred, so an image bucket smaller than that evicts what is still on screen. The
   * asset bucket is deliberately several releases deep -- dropping to one release is how an
   * already-open page fails to load a lazy chunk after a deploy.
   */
  test("images hold more than one session of browsing, assets more than one release", () => {
    expect(SW_CACHE_LIMITS.images).toBeGreaterThanOrEqual(300);
    expect(SW_CACHE_LIMITS.assets).toBeGreaterThanOrEqual(60);
    expect(SW_CACHE_LIMITS.static).toBeGreaterThan(0);
  });
});
