/**
 * The cache-header audit, as assertions.
 *
 * The bug these defend against is not a crash and does not show up in a log: a response that
 * depends on the session cookie, stored under a key that does not include it, and handed to
 * the next reader. `/api/title/:tconst` carries `arrLink` -- a Radarr address -- for an admin
 * and `null` for everybody else; `/api/requests` carries `requested_by` on the same terms.
 * Both were `private, max-age=N` with no `Vary`, which tells a browser it may reuse either
 * body for any later request to that URL.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
  type CachePolicy,
  cacheHeaders,
  IMAGE_CACHE_EXT,
  IMMUTABLE_PUBLIC,
  NO_STORE,
  PER_SESSION_REVALIDATED,
  perSession,
  publicFor,
  REVALIDATED,
  STATIC_IMAGE_MAX_AGE,
  sharedPerSession,
  staticAssetPolicy,
  stripImageExt,
  withImageExt,
} from "./cache-policy";
import { json } from "./json-response";

/**
 * Every policy in the vocabulary, and whether its body depends on who asked.
 *
 * Keyed by `CachePolicy["kind"]` on purpose: a variant added to the union without an entry
 * here is a TYPE error, so a new policy cannot reach production without somebody stating
 * whether it is reader-dependent. That statement is what the invariant below tests.
 */
const EVERY_POLICY = {
  "no-store": { policy: NO_STORE, dependsOnReader: false },
  "per-session": { policy: perSession(60), dependsOnReader: true },
  "per-session-revalidated": { policy: PER_SESSION_REVALIDATED, dependsOnReader: true },
  "shared-per-session": { policy: sharedPerSession(600), dependsOnReader: true },
  // Same bytes for everybody: an icon, the manifest, an unhashed asset.
  revalidated: { policy: REVALIDATED, dependsOnReader: false },
  // Same bytes for everybody, held for a bounded while: a logo, a favicon.
  "public-for": { policy: publicFor(600), dependsOnReader: false },
  // Content-addressed bytes: a poster keyed by a title id, a hashed bundle.
  "immutable-public": { policy: IMMUTABLE_PUBLIC, dependsOnReader: false },
} satisfies Record<CachePolicy["kind"], { policy: CachePolicy; dependsOnReader: boolean }>;

describe("cacheHeaders", () => {
  /**
   * THE RULE THE WHOLE FILE EXISTS FOR.
   *
   * `private` bars a SHARED cache from storing a response. It says nothing about the
   * browser's own cache, which is the one two readers of the same device share -- so a
   * storable answer whose body depends on the session needs the session in the cache key,
   * and `Vary: Cookie` is what puts it there.
   */
  test("a storable, reader-dependent answer is keyed on the session cookie", () => {
    for (const [kind, { policy, dependsOnReader }] of Object.entries(EVERY_POLICY)) {
      const headers = cacheHeaders(policy);
      const storable = headers["Cache-Control"] !== "no-store";
      const expected: string = dependsOnReader && storable ? "Cookie" : "none";
      expect({ kind, varies: headers.Vary ?? "none" }).toEqual({ kind, varies: expected });
    }
  });

  /**
   * The exact directives, so a change to one is a change somebody made on purpose.
   * `max-age=0, s-maxage=600` is the shape that lets Caddy hold a crawler's copy while
   * every browser still asks.
   */
  test("each policy spells the directives it means", () => {
    expect(cacheHeaders(NO_STORE)["Cache-Control"]).toBe("no-store");
    expect(cacheHeaders(perSession(30))["Cache-Control"]).toBe("private, max-age=30");
    expect(cacheHeaders(PER_SESSION_REVALIDATED)["Cache-Control"]).toBe("no-cache");
    expect(cacheHeaders(sharedPerSession(600))["Cache-Control"]).toBe("public, max-age=0, s-maxage=600");
    expect(cacheHeaders(REVALIDATED)["Cache-Control"]).toBe("no-cache");
    expect(cacheHeaders(IMMUTABLE_PUBLIC)["Cache-Control"]).toBe("public, max-age=31536000, immutable");
  });
});

describe("json", () => {
  /**
   * The posture `withAuth` takes about reachability, taken about storage: a route added
   * later is uncacheable by having been added. Before this default, a handler that simply
   * did not think about caching sent no `Cache-Control` at all, which leaves an
   * intermediary free to apply its own heuristic freshness to a per-reader body.
   */
  test("a route that says nothing gets no-store", () => {
    expect(json({ ok: true }).headers.get("Cache-Control")).toBe("no-store");
  });

  test("a route that asks for a session cache gets the Vary with it", () => {
    const res = json({ hits: [] }, { cache: perSession(60) });
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=60");
    expect(res.headers.get("Vary")).toBe("Cookie");
  });

  /**
   * The policy is spread LAST. A route reaching for a hand-written header is the exact move
   * that produced the drift this card was filed for, so it loses.
   */
  test("a hand-written Cache-Control cannot override the policy", () => {
    const res = json({}, { headers: { "Cache-Control": "public, max-age=99999" } });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test("everything else a route sends survives", () => {
    const res = json({ error: "too many" }, { status: 429, headers: { "Retry-After": "30" } });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });
});

/**
 * The extension half of cachability.
 *
 * `immutable-public` is necessary and NOT sufficient: a CDN reads the path's extension to
 * decide eligibility before it reads a single header, so an extensionless image route is
 * never cached however loudly it says `immutable`. Measured 2026-09-07 -- see
 * `IMAGE_CACHE_EXT`, which owns the numbers.
 */
describe("the image cache extension", () => {
  /**
   * The pairing that matters. Whatever we ISSUE must be something the routes take BACK, or
   * every image 400s the moment this ships -- and the failure would be total rather than
   * partial, because every path is built by the same function.
   */
  test("what we issue is what the routes accept back", () => {
    for (const path of ["/img/t/tt1375666", "/img/f/fb2735bdd2c09484", "/img/og/nm0000138"]) {
      const issued = withImageExt(path);
      expect(issued).toBe(`${path}${IMAGE_CACHE_EXT}`);
      expect(stripImageExt(issued.slice(issued.lastIndexOf("/") + 1))).toBe(
        path.slice(path.lastIndexOf("/") + 1),
      );
    }
  });

  /**
   * A path lives in a browser cache for a year and in somebody else's OG card indefinitely,
   * so an address handed out before this shipped -- or before the constant last changed --
   * must still resolve. A bare id is the pre-shipping form and it passes through untouched.
   */
  test("an id with no extension, or with an older one, still resolves", () => {
    expect(stripImageExt("tt1375666")).toBe("tt1375666");
    for (const ext of [".jpg", ".jpeg", ".png", ".webp", ".JPG"]) {
      expect(stripImageExt(`tt1375666${ext}`)).toBe("tt1375666");
    }
  });

  /**
   * Only a TRAILING extension, and only a whole one. An id is matched against a closed regex
   * straight after this, so eating something in the middle would turn a refusal into a
   * lookup for a title nobody named.
   */
  test("it strips a trailing extension and nothing else", () => {
    expect(stripImageExt("tt1375666.jpg.evil")).toBe("tt1375666.jpg.evil");
    expect(stripImageExt("tt.jpg1375666")).toBe("tt.jpg1375666");
    expect(stripImageExt(".jpg")).toBe("");
  });

  /** The whole point: the extension we issue is one a CDN treats as a static image. */
  test("the issued extension is one a CDN caches by default", () => {
    expect([".jpg", ".jpeg", ".png", ".webp", ".gif"]).toContain(IMAGE_CACHE_EXT);
  });
});

/**
 * The static-asset classifier, tested against the REAL build output.
 *
 * > [!CAUTION] THE BUG THIS FILE EXISTS TO HAVE CAUGHT was a regex nobody ran against a
 * > real filename
 * > The rule was `/\.[0-9a-f]{8,}\.(js|css|woff2?|png|jpg|svg)$/` -- a dot-delimited,
 * > lowercase-hex hash, `main.deadbeef12.js`. **Vite emits `main-BAA2t8bY.js`**: hyphen
 * > delimiter, base64url alphabet. So it matched NOTHING this project has ever built, the
 * > `immutable` branch was dead code, and every JS chunk, CSS file and hashed font went out
 * > `no-cache` -- measured live 2026-09-07 as `cf-cache-status: BYPASS` on
 * > `/assets/main-ChJg8Krm.js`. It cost a conditional request per chunk per page load,
 * > which is invisible on a LAN and is the whole bill on a phone.
 * >
 * > It hid because `no-cache` is not `no-store`: the browser keeps the bytes and the
 * > revalidation 304s, so nothing rendered wrong and no test could tell.
 * >
 * > **So this suite reads `web/dist` rather than a fixture.** A rule about what the bundler
 * > emits can only be checked against what the bundler emitted.
 */
describe("staticAssetPolicy", () => {
  const dist = new URL("../../web/dist/", import.meta.url).pathname;
  const built = existsSync(`${dist}assets`);

  /**
   * THE REGRESSION TEST. Every file the bundler actually wrote must be recognised, so the
   * next hash-format change fails here instead of silently costing a round trip forever.
   */
  test.if(built)("every real hashed asset is immutable-public", () => {
    const files = readdirSync(`${dist}assets`);
    expect(files.length).toBeGreaterThan(0);
    const wrong = files.filter((f) => staticAssetPolicy(`/assets/${f}`).kind !== "immutable-public");
    expect(wrong).toEqual([]);
  });

  /**
   * A DIRECTORY, not a filename pattern -- and that is the fix rather than a tighter regex.
   * `vite.config.ts` routes hashed output to `assets/[name]-[hash].js` itself, so the
   * directory is the build's own declaration of what is content-addressed. A regex is a
   * second guess at a hash alphabet Rollup is free to change; this cannot drift, and it
   * cannot false-positive onto `apple-touch-icon.png` the way a loose one would.
   */
  test("the hashed bucket is decided by directory, not by guessing a hash format", () => {
    expect(staticAssetPolicy("/assets/main-BAA2t8bY.js").kind).toBe("immutable-public");
    expect(staticAssetPolicy("/assets/index-DkPq2Xy1.css").kind).toBe("immutable-public");
    // The shape the OLD rule wanted. Still immutable -- it is in the bucket -- but nothing
    // about the answer now depends on which of the two shapes the name happens to have.
    expect(staticAssetPolicy("/assets/main.deadbeef12.js").kind).toBe("immutable-public");
  });

  /**
   * An unhashed static IMAGE may be held, but never forever: `logos:import` and
   * `icons:build` rewrite these paths in place, so `immutable` would strand the old art on
   * every device that had seen it. A bounded public TTL is the shape that lets a CDN hold
   * 826 logo files and still self-heals.
   */
  test("an unhashed image gets a bounded public TTL", () => {
    for (const p of ["/logos/rating/imdb.png", "/favicon.svg", "/apple-touch-icon.png", "/icon-512.png"]) {
      expect(staticAssetPolicy(p)).toEqual({ kind: "public-for", seconds: STATIC_IMAGE_MAX_AGE });
    }
  });

  /**
   * > [!CAUTION] `sw.js` MUST KEEP REVALIDATING and it is the reason this is not "cache
   * > everything unhashed"
   * > It is deliberately the one UNHASHED entry point (`vite.config.ts` says why: a hashed
   * > worker registers a new one per release while the old keeps controlling the page). A
   * > service worker held at the edge or in a browser for a week is a bricked PWA that no
   * > deploy can reach. Same for the two shells and the manifest, which change per release.
   */
  test("a document, the manifest and the service worker still revalidate", () => {
    for (const p of ["/sw.js", "/index.html", "/login.html", "/site.webmanifest", "/offline.html"]) {
      expect(staticAssetPolicy(p).kind).toBe("revalidated");
    }
  });

  /** A bounded TTL that is not, by some later edit, secretly forever. */
  test("the bounded TTL is actually bounded", () => {
    expect(STATIC_IMAGE_MAX_AGE).toBeGreaterThan(0);
    expect(STATIC_IMAGE_MAX_AGE).toBeLessThan(31_536_000);
    expect(cacheHeaders(staticAssetPolicy("/favicon.svg"))).toEqual({
      "Cache-Control": `public, max-age=${STATIC_IMAGE_MAX_AGE}`,
    });
  });
});

/**
 * ONE OWNER, ENFORCED. The audit is only worth what it stays worth: a route written next
 * month that hand-writes `Cache-Control` re-opens exactly the hole that was just closed,
 * and nothing else in the gate would notice.
 */
test("cache-policy.ts is the only server file that writes a Cache-Control", () => {
  const dir = new URL(".", import.meta.url).pathname;
  const offenders = readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && f !== "cache-policy.ts" && !f.endsWith(".test.ts"))
    .filter((f) => readFileSync(`${dir}${f}`, "utf8").includes('"Cache-Control"'));
  expect(offenders).toEqual([]);
});
