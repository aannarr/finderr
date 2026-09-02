import { describe, expect, test } from "bun:test";
import type { PreviewTitle } from "../lib/og-preview";
import { type PreviewDeps, previewResponse } from "./preview";

const BATMAN: PreviewTitle = {
  tconst: "tt0096895",
  title: "Batman",
  year: 1989,
  kind: "movie",
  genres: "Action,Adventure",
  rating: 7.5,
  votes: 402_000,
};

/**
 * A counting stand-in for everything the handler may touch.
 *
 * The counters ARE the test: this handler's contract is mostly about what it does NOT do,
 * and a fake that records calls is the only way to assert an absence.
 */
function deps(over: Partial<PreviewDeps> = {}) {
  const calls = { row: 0, synopsis: 0, cachedPoster: 0, resolve: 0, allow: 0 };
  const base: PreviewDeps = {
    rowFor: (t) => {
      calls.row++;
      return t === BATMAN.tconst ? BATMAN : null;
    },
    cachedSynopsis: () => {
      calls.synopsis++;
      return null;
    },
    cachedPoster: () => {
      calls.cachedPoster++;
      return undefined;
    },
    resolvePoster: async () => {
      calls.resolve++;
      return null;
    },
    allow: () => {
      calls.allow++;
      return true;
    },
    origin: () => "https://finderr.example.com",
    siteName: "finderr",
    headers: { "X-Frame-Options": "DENY" },
  };
  return { deps: { ...base, ...over }, calls };
}

const req = () => new Request("https://finderr.example.com/title/tt0096895");

describe("previewResponse", () => {
  test("renders a card for a title we index", async () => {
    const { deps: d } = deps({ cachedSynopsis: () => "Gotham's protector." });
    const res = await previewResponse(req(), BATMAN.tconst, d);
    const html = await res?.text();
    expect(res?.status).toBe(200);
    expect(html).toContain('property="og:title" content="Batman (1989)"');
    expect(html).toContain('property="og:description" content="Gotham&#39;s protector."');
  });

  test("null for a title we do not index, WITHOUT spending the caller's allowance", async () => {
    const { deps: d, calls } = deps();
    expect(await previewResponse(req(), "tt9999999", d)).toBeNull();
    // An unknown id must not consume a rate-limit slot, or walking nonsense ids is a way
    // to lock a real crawler out of the titles that do exist.
    expect(calls.allow).toBe(0);
  });

  test("a rate-limited caller gets null and costs NOTHING downstream", async () => {
    const { deps: d, calls } = deps({ allow: () => false });
    expect(await previewResponse(req(), BATMAN.tconst, d)).toBeNull();
    expect(calls.synopsis).toBe(0);
    expect(calls.cachedPoster).toBe(0);
    expect(calls.resolve).toBe(0);
  });

  /**
   * The rule the whole feature rests on. A preview for a title whose poster we already
   * hold must not touch the network at all -- that is the case a crawler storm hits, and
   * it is the difference between a shared link being free and being an amplifier.
   */
  test("a cached poster costs NO resolve", async () => {
    const { deps: d, calls } = deps({ cachedPoster: () => ({ url: "https://image.tmdb.org/p/w342/b.jpg" }) });
    const html = await (await previewResponse(req(), BATMAN.tconst, d))?.text();
    expect(calls.resolve).toBe(0);
    expect(html).toContain('property="og:image" content="https://finderr.example.com/img/og/tt0096895"');
  });

  /**
   * `undefined` (never looked) and `{url: null}` (looked, there is none) are different
   * facts, and conflating them re-asks Radarr and Sonarr for every poster-less title on
   * every single unfurl -- which is the amplifier wearing a cache's clothes.
   */
  test("a REMEMBERED absence does not re-ask", async () => {
    const { deps: d, calls } = deps({ cachedPoster: () => ({ url: null }) });
    const html = await (await previewResponse(req(), BATMAN.tconst, d))?.text();
    expect(calls.resolve).toBe(0);
    expect(html).not.toContain("og:image");
  });

  test("an unseen poster resolves ONCE, through the bounded path", async () => {
    let resolves = 0;
    const { deps: d } = deps({
      cachedPoster: () => undefined,
      resolvePoster: async () => {
        resolves++;
        return "https://image.tmdb.org/p/w342/b.jpg";
      },
    });
    const html = await (await previewResponse(req(), BATMAN.tconst, d))?.text();
    expect(resolves).toBe(1);
    expect(html).toContain("og:image");
  });

  test("a REFUSED resolve renders the card without a picture, never an error", async () => {
    const { deps: d } = deps({ cachedPoster: () => undefined, resolvePoster: async () => null });
    const res = await previewResponse(req(), BATMAN.tconst, d);
    expect(res?.status).toBe(200);
    expect(await res?.text()).not.toContain("og:image");
  });

  /**
   * Without `Vary: Cookie` a shared cache may store this page and serve it where the app
   * shell belongs, or the reverse -- handing an anonymous visitor the bundle that names
   * every route finderr has, which is the one thing the two-shell split exists to prevent.
   */
  test("says it varies by cookie, and is cacheable by a CDN", async () => {
    const res = await previewResponse(req(), BATMAN.tconst, deps().deps);
    expect(res?.headers.get("Vary")).toBe("Cookie");
    expect(res?.headers.get("Cache-Control")).toContain("s-maxage=600");
    // The caller's security headers survive the spread rather than being dropped.
    expect(res?.headers.get("X-Frame-Options")).toBe("DENY");
  });

  test("the og:image points at the cache-only route, never at an upstream host", async () => {
    const { deps: d } = deps({ cachedPoster: () => ({ url: "https://image.tmdb.org/p/w342/b.jpg" }) });
    const html = (await (await previewResponse(req(), BATMAN.tconst, d))?.text()) ?? "";
    expect(html).not.toContain("image.tmdb.org");
    expect(html).toContain("/img/og/");
  });
});
