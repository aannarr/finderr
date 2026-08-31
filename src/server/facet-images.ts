/**
 * Facet images, served from our own origin.
 *
 * A provider answers with an upstream URL -- `image.tmdb.org` for a headshot,
 * `artworks.thetvdb.com` for a season poster -- and the browser is never handed one:
 * finderr will be internet-facing while the providers stay on the LAN, so an upstream URL
 * is both unreachable from outside and a leak of who sits behind us. The same rule
 * `decorate()` follows for `posterUrl`.
 *
 * So the SERVER rewrites every image field to `/img/f/<key>` before the facet leaves
 * `/api/title/:tconst`, and this route resolves the key back. Two things follow from the
 * key being a hash of the URL rather than a provider's person id:
 *
 *   - the client needs no id and no change at all -- `localImageUrl()` already passes a
 *     same-origin path and drops everything else, so it keeps working as a GUARD rather
 *     than becoming dead code once every provider URL is legitimate;
 *   - two plugins naming the same face agree on one key and share one cached file. A
 *     provider id space is per-provider by construction and would cache it twice.
 *
 * The bytes are not this module's problem: `ArtworkService.serveUrl` already solved fetch,
 * cache-to-disk, collapsing concurrent misses and the host allowlist, and a face is not a
 * different kind of JPEG from a poster.
 */

import type { ResolvedFacet, ResolvedFacets } from "../lib/facet-resolver";
import { type FacetName, mapFacetImages } from "../lib/facets";
import { proxyableImageUrl } from "./artwork";

/** Where the rewritten paths point. Owned here, so the route and the rewrite agree. */
export const FACET_IMAGE_PATH = "/img/f";

/** A key is a hex hash we issued; anything else never named an image and is not a lookup. */
const KEY = /^[0-9a-f]{1,16}$/;

/** What this needs from `Store`. Narrow, so a test can hand over a plain object. */
export interface FacetImageStore {
  rememberFacetImages(images: readonly { key: string; url: string }[]): void;
  facetImageUrl(key: string): string | null;
}

/** What this needs from `ArtworkService`: fetch-and-cache one remote image. */
export interface ImageByteSource {
  serveUrl(rawUrl: string, size: string): Promise<Response>;
}

export interface FacetImageProxyDeps {
  store: FacetImageStore;
  bytes: ImageByteSource;
}

export class FacetImageProxy {
  private readonly store: FacetImageStore;
  private readonly bytes: ImageByteSource;

  constructor(deps: FacetImageProxyDeps) {
    this.store = deps.store;
    this.bytes = deps.bytes;
  }

  /**
   * The same facets, with every image field pointing at this origin.
   *
   * Walks the vocabulary's own declaration of where images live (`mapFacetImages`), so a
   * facet that grows an image field later is rewritten here with no edit. Untouched
   * facets keep their value by reference -- eleven of the fifteen carry no image at all.
   *
   * Local SQLite and nothing else, which is what lets this sit on the render path.
   */
  rewrite(facets: ResolvedFacets): ResolvedFacets {
    const issued = new Map<string, string>();
    const out: Record<string, ResolvedFacet> = {};

    for (const facet of Object.keys(facets) as FacetName[]) {
      const resolved = facets[facet];
      if (!resolved) continue;
      out[facet] =
        resolved.status === "ready" && resolved.data !== undefined
          ? { ...resolved, data: mapFacetImages(facet, resolved.data, (url) => pathFor(url, issued)) }
          : resolved;
    }

    // One write for the whole title rather than one per face.
    this.store.rememberFacetImages([...issued].map(([key, url]) => ({ key, url })));
    // Built through a loose record because the facet name is only known at runtime; the
    // mapped type is what every caller sees.
    return out as ResolvedFacets;
  }

  /**
   * Serve one facet image by its key.
   *
   * A key we never issued is a 404 rather than a fetch: the URL must come from our own
   * table, so nothing a client sends can name a host. `serveUrl` re-checks the allowlist
   * anyway -- the table is written from validated URLs, and a second check costs nothing.
   */
  async serve(key: string, size: string): Promise<Response> {
    if (!KEY.test(key)) return new Response("bad key", { status: 400 });
    const url = this.store.facetImageUrl(key);
    if (!url) return new Response("unknown image", { status: 404 });
    return this.bytes.serveUrl(url, size);
  }
}

/**
 * The path the browser gets for one upstream image, or null to clear the field.
 *
 * An image on a host we would refuse to fetch comes back null, so the pane draws its
 * fallback -- initials, or nothing where a season poster would go -- immediately, instead
 * of firing a request that was always going to fail.
 *
 * Keyed on the UNSIZED URL: the size is a serving decision, and keying on it would issue
 * a second key for the same face the moment a caller asked for a different width.
 * `ArtworkService` hashes the SIZED url for its filename, which is the other question --
 * this key identifies the image, that one identifies the bytes.
 */
function pathFor(rawUrl: string, issued: Map<string, string>): string | null {
  const target = proxyableImageUrl(rawUrl);
  if (!target) return null;
  const key = Bun.hash(target.href).toString(16);
  issued.set(key, target.href);
  return `${FACET_IMAGE_PATH}/${key}`;
}
