/**
 * WHO MAY KEEP A RESPONSE, AND FOR HOW LONG -- the whole vocabulary, in one place.
 *
 * > [!CAUTION] `Cache-Control` and `Vary` are ONE decision, and writing them as two headers
 * > is how they drift
 * > `private, max-age=60` with no `Vary` tells every cache it may reuse that body for any
 * > later request to the same URL. The body depends on the session cookie: `/api/title/:tconst`
 * > carries `arrLink` -- the address of a Radarr this product otherwise never shows a browser
 * > -- for an admin and `null` for everybody else, and `/api/requests` carries `requested_by`
 * > on the same terms. Same URL, two bodies, no key to tell them apart. One reader signs out,
 * > the next signs in on that browser, and the second is served the first one's answer from
 * > disk.
 * >
 * > `private` does not fix this. It bars a SHARED cache from storing the response; it says
 * > nothing about the browser's own cache, which is the one both readers share. `Vary: Cookie`
 * > is what makes "private" mean per-reader for real, and it costs nothing during a session
 * > because `fdr_sid` is set once at sign-in and never rotates.
 *
 * So a caller names a POLICY and never writes either header by hand. `cache-policy.test.ts`
 * scans the server source and fails the build if one does -- the same argument `withAuth`
 * makes about the route table: the rule holds for a route nobody has written yet.
 */

/**
 * What a response says about being stored.
 *
 * A discriminated union rather than a header string, so "storable" and "keyed on the reader"
 * cannot be set independently -- which is the only way they can be set wrongly.
 */
export type CachePolicy =
  /** Nothing may keep it. The default for every JSON response finderr sends. */
  | { readonly kind: "no-store" }
  /**
   * This reader's own browser may reuse it for `seconds`, and no shared cache may keep it.
   * For a body that depends on who asked.
   */
  | { readonly kind: "per-session"; readonly seconds: number }
  /**
   * This reader's own browser may keep it but must revalidate before every use.
   * For the two HTML shells, where WHICH document this URL returns depends on the session.
   */
  | { readonly kind: "per-session-revalidated" }
  /**
   * A shared cache may hold it for `seconds`, keyed on the session; a browser always
   * revalidates. For a page an anonymous caller may see -- the Open Graph card a crawler
   * unfurls, which is worth holding at the edge precisely because strangers ask for it.
   */
  | { readonly kind: "shared-per-session"; readonly seconds: number }
  /**
   * Anyone may keep it, but must revalidate before every use. For a file whose URL is
   * stable across releases and whose bytes are the same for every reader -- the manifest,
   * the icons, an unhashed asset. No `Vary`: nothing about it depends on who asked.
   */
  | { readonly kind: "revalidated" }
  /**
   * Anyone may keep it forever. ONLY for content-addressed bytes with no reader in them:
   * a poster keyed by a title id, a hashed bundle, a facet image keyed by a hash of its
   * upstream URL. These carry no session state, which is why they too have no `Vary`.
   */
  | { readonly kind: "immutable-public" };

/** Nothing may keep it. */
export const NO_STORE: CachePolicy = { kind: "no-store" };

/** This reader's browser, for `seconds`. */
export const perSession = (seconds: number): CachePolicy => ({ kind: "per-session", seconds });

/** This reader's browser, revalidated every time. */
export const PER_SESSION_REVALIDATED: CachePolicy = { kind: "per-session-revalidated" };

/** A shared cache, for `seconds`, keyed on the session. */
export const sharedPerSession = (seconds: number): CachePolicy => ({
  kind: "shared-per-session",
  seconds,
});

/** Anyone, revalidated every time. Same bytes for everybody, at a URL that outlives them. */
export const REVALIDATED: CachePolicy = { kind: "revalidated" };

/** Anyone, forever. Content-addressed bytes only. */
export const IMMUTABLE_PUBLIC: CachePolicy = { kind: "immutable-public" };

/** A year, which is the longest `max-age` the HTTP spec asks anyone to honour. */
const ONE_YEAR_SECONDS = 31_536_000;

/**
 * The extension every proxied image path carries, so a CDN will hold the bytes.
 *
 * > [!CAUTION] `immutable-public` is NOT enough on its own, and the reason is not in any header
 * > Measured against the live deployment on 2026-09-07, three routes on one origin behind one
 * > Caddy, all three answering `public, max-age=31536000, immutable` with no `Vary`:
 * >
 * > | path | `cf-cache-status` |
 * > |---|---|
 * > | `/img/w342/qJ2tW6WMUDux911r6m7haRef0WH.jpg` | **HIT**, `age: 203` |
 * > | `/img/f/fb2735bdd2c09484` | DYNAMIC |
 * > | `/img/t/tt1375666` | DYNAMIC |
 * >
 * > CloudFlare decides ELIGIBILITY from the path's extension before it ever reads
 * > `Cache-Control`, and `DYNAMIC` means it never considered the response at all. The one
 * > route that happened to carry `.jpg` -- the legacy TMDB-path proxy -- was the one being
 * > served from the edge. So the difference between a poster crossing a home uplink from a
 * > Celeron and one coming off a CDN was six characters in a URL.
 *
 * **It is a CACHE HINT, never a declaration of what the bytes are.** `serveUrl` derives the
 * real type from the upstream path and sends it as `Content-Type`, which is what every
 * browser and every cache actually keys on; a PNG headshot served at a `.jpg` address
 * renders as a PNG. Deriving a truthful extension per image was considered and rejected:
 * the path is issued when a JSON payload is built, and nothing at that moment has fetched
 * the image or knows its type. Two extensions would be two code paths for one string.
 *
 * **The exposure this buys is accepted, by aannarr, 2026-09-07.** An edge-cached image is
 * served to anyone who asks, so `/img/t/tt1375666.jpg` becomes an oracle for "somebody here
 * viewed this title". It does NOT open the amplifier `/img/t` is guarded against -- a MISS
 * still reaches origin, still meets `withAuth`, still 401s, and a `no-store` 401 is never
 * cached -- so only bytes a signed-in reader already pulled can ever be served this way.
 */
export const IMAGE_CACHE_EXT = ".jpg";

/**
 * Extensions a proxy route accepts back. Wider than what we ISSUE, deliberately.
 *
 * A path lives in a client-side cache for a year and in an OG card somebody else's server
 * holds indefinitely, so narrowing `IMAGE_CACHE_EXT` later must not 404 every address
 * already handed out. Accepting the whole set costs one regex and makes the constant
 * genuinely changeable.
 */
const ACCEPTED_IMAGE_EXT = /\.(?:jpe?g|png|webp)$/i;

/** A proxy image path, with the hint on it. The one place either is appended. */
export function withImageExt(path: string): string {
  return `${path}${IMAGE_CACHE_EXT}`;
}

/**
 * A route parameter with the hint taken back off.
 *
 * Every proxy route runs its parameter through this BEFORE validating it, so the id
 * regexes (`IMDB_ID`, the facet `KEY`) keep describing an id rather than growing an
 * optional suffix each. A parameter with no extension passes through untouched, which is
 * what keeps a page cached from before this shipped working.
 */
export function stripImageExt(param: string): string {
  return param.replace(ACCEPTED_IMAGE_EXT, "");
}

/**
 * The headers a policy is worth, ready to spread into a `ResponseInit`.
 *
 * Every branch that permits reuse of a session-dependent body emits `Vary: Cookie` in the
 * same expression that emits its `Cache-Control`, so there is no arrangement of this code
 * in which one exists without the other.
 */
export function cacheHeaders(policy: CachePolicy): Record<string, string> {
  switch (policy.kind) {
    case "no-store":
      return { "Cache-Control": "no-store" };
    case "per-session":
      return { "Cache-Control": `private, max-age=${policy.seconds}`, Vary: "Cookie" };
    case "per-session-revalidated":
      return { "Cache-Control": "no-cache", Vary: "Cookie" };
    case "shared-per-session":
      return { "Cache-Control": `public, max-age=0, s-maxage=${policy.seconds}`, Vary: "Cookie" };
    case "revalidated":
      return { "Cache-Control": "no-cache" };
    case "immutable-public":
      return { "Cache-Control": `public, max-age=${ONE_YEAR_SECONDS}, immutable` };
  }
}
