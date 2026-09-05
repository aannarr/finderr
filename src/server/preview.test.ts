import { describe, expect, test } from "bun:test";
import type { PreviewTitle } from "../lib/og-preview";
import { type PersonPreviewDeps, type PreviewDeps, personPreviewResponse, previewResponse } from "./preview";
import { PREVIEW_IMAGE_SIZE } from "./preview-resolver";

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

const NOLAN_PAGE = {
  person: {
    nconst: "nm0634240",
    name: "Christopher Nolan",
    birthYear: 1970,
    deathYear: null,
  },
  knownFor: ["Inception", "The Dark Knight"],
  credits: 42,
};

/**
 * The person half's fake, and it counts one thing the title half cannot.
 *
 * There is no `resolve` counter here because there is no resolve: a headshot only enters
 * `person_image` when a signed-in reader opens a title page, so this surface has NOTHING to
 * buy. `face` is counted instead, to pin that a missing face costs one local read and never
 * grows into a lookup.
 */
function personDeps(over: Partial<PersonPreviewDeps> = {}) {
  const calls = { page: 0, face: 0, allow: 0 };
  const base: PersonPreviewDeps = {
    pageFor: (n) => {
      calls.page++;
      return n === NOLAN_PAGE.person.nconst ? NOLAN_PAGE : null;
    },
    faceKey: () => {
      calls.face++;
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

const personReq = () => new Request("https://finderr.example.com/person/nm0634240");

describe("personPreviewResponse", () => {
  test("renders a card for a person we index", async () => {
    const res = personPreviewResponse(personReq(), NOLAN_PAGE.person.nconst, personDeps().deps);
    expect(res?.status).toBe(200);
    const html = await res?.text();
    expect(html).toContain('property="og:title" content="Christopher Nolan"');
    expect(html).toContain('property="og:type" content="profile"');
    expect(html).toContain('property="og:description" content="Known for Inception and The Dark Knight."');
  });

  /**
   * The size the card DECLARES (`IMAGE_W`/`IMAGE_H` in `../lib/og-preview.ts`) and the size
   * the route REQUESTS are two constants in two files that must agree, or a client reserves
   * a box the bytes do not fill. Pinned from this side; the shape is pinned from the other.
   */
  test("requests a width past the bar every client applies", () => {
    const width = Number(/^w(\d+)$/.exec(PREVIEW_IMAGE_SIZE)?.[1]);
    expect(width).toBe(780);
    // 2:3, so the long edge clears TN3156's 900px. `DEFAULT_IMAGE_SIZE` (w342) does not,
    // which is the whole reason this constant exists separately from it.
    expect(width * 1.5).toBeGreaterThanOrEqual(900);
  });

  /**
   * A `null` fall-through rather than a 404, so an unknown nconst never teaches a crawler
   * which ids we hold -- and, more importantly, is never CACHED as a broken link. Same rule
   * the title half follows and for the same reason.
   */
  test("an nconst we do not index falls through instead of erroring", () => {
    expect(personPreviewResponse(personReq(), "nm9999999", personDeps().deps)).toBeNull();
  });

  test("a rate-limited caller falls through rather than caching a 429", () => {
    const { deps: d } = personDeps({ allow: () => false });
    expect(personPreviewResponse(personReq(), NOLAN_PAGE.person.nconst, d)).toBeNull();
  });

  test("no face means a card with no picture, never a fetch", async () => {
    // The BASE fake already answers null and counts the call; overriding it here would
    // replace the counter and quietly assert nothing.
    const { deps: d, calls } = personDeps();
    const res = personPreviewResponse(personReq(), NOLAN_PAGE.person.nconst, d);
    expect(await res?.text()).not.toContain("og:image");
    expect(calls.face).toBe(1);
  });

  test("a known face points at the cache-only route under the PERSON's id", async () => {
    const { deps: d } = personDeps({ faceKey: () => "beef1234" });
    const html = (await personPreviewResponse(personReq(), NOLAN_PAGE.person.nconst, d)?.text()) ?? "";
    expect(html).toContain('property="og:image" content="https://finderr.example.com/img/og/nm0634240"');
    // The KEY is an internal id and has no business in a page a third party caches.
    expect(html).not.toContain("beef1234");
  });

  test("carries the same cache policy as the title card", () => {
    const res = personPreviewResponse(personReq(), NOLAN_PAGE.person.nconst, personDeps().deps);
    expect(res?.headers.get("Vary")).toBe("Cookie");
    expect(res?.headers.get("Cache-Control")).toContain("s-maxage=600");
    expect(res?.headers.get("X-Frame-Options")).toBe("DENY");
  });

  /**
   * The bound that matters on an anonymous surface: the whole card is local reads. One page
   * read, one face read, and nothing that could reach a network.
   */
  test("costs exactly two local reads and nothing else", () => {
    const { deps: d, calls } = personDeps();
    personPreviewResponse(personReq(), NOLAN_PAGE.person.nconst, d);
    expect(calls).toEqual({ page: 1, face: 1, allow: 1 });
  });
});
