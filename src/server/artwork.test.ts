/**
 * The two guards on the byte proxy, which are the whole of its attack surface.
 *
 * The rest of `ArtworkService` needs an arr client and a network and is exercised by the
 * routes above it. These two decide what a request can reach at all: WHICH host, and WHAT
 * path on it -- and both are now reached by a second route (the facet image proxy), so
 * they are worth pinning down on their own.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadConfig } from "../lib/config";
import type { Store } from "../lib/store";
import { ArtworkService, DEFAULT_IMAGE_SIZE, proxyableImageUrl } from "./artwork";

describe("proxyableImageUrl", () => {
  test("the hosts the metadata providers actually serve images from are allowed", () => {
    expect(proxyableImageUrl("https://image.tmdb.org/t/p/original/x.jpg")?.hostname).toBe("image.tmdb.org");
    expect(proxyableImageUrl("https://artworks.thetvdb.com/banners/x.jpg")?.hostname).toBe(
      "artworks.thetvdb.com",
    );
  });

  /** The URL comes from a provider rather than a user, but it still ends in a fetch. */
  test("anything else is refused, so a bad provider cannot make this an SSRF", () => {
    expect(proxyableImageUrl("https://evil.example.com/x.jpg")).toBeNull();
    // A subdomain of an allowed host is a different host.
    expect(proxyableImageUrl("https://image.tmdb.org.evil.example.com/x.jpg")).toBeNull();
    expect(proxyableImageUrl("http://image.tmdb.org/x.jpg")).toBeNull();
    expect(proxyableImageUrl("file:///etc/passwd")).toBeNull();
    expect(proxyableImageUrl("//image.tmdb.org/x.jpg")).toBeNull();
    expect(proxyableImageUrl("not a url")).toBeNull();
  });
});

describe("the size a caller asks for", () => {
  let dir: string;
  let service: ArtworkService;

  beforeEach(() => {
    dir = mkdtempSync(`${tmpdir()}/finderr-test-`);
    process.env.FINDERR_DATA_DIR = dir;
    // No store and no clients: every assertion below stops at a guard, well before the
    // service would reach for either.
    service = new ArtworkService(loadConfig(true), undefined as unknown as Store, {});
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env.FINDERR_DATA_DIR = undefined;
  });

  /**
   * `size` is spliced into the upstream path to pick a TMDB variant, and it arrives from
   * a query string -- so an unchecked one walks out of `/t/p/` and fetches an arbitrary
   * path on an allowed host. Checked in `serveUrl`, which every byte-serving route goes
   * through, including the facet image proxy.
   */
  test("a size that is not a width is refused before anything is fetched", async () => {
    for (const size of ["../../malicious", "w342/../..", "", "original/x"]) {
      const res = await service.serveUrl("https://image.tmdb.org/t/p/w342/x.jpg", size);
      expect(res.status).toBe(400);
      expect(await res.text()).toBe("bad size");
    }
  });

  test("the default is a width the guard accepts", async () => {
    const res = await service.serveUrl("https://evil.example.com/x.jpg", DEFAULT_IMAGE_SIZE);
    // Past the size guard and stopped by the host one -- the ordering is what proves the
    // size was accepted, without needing a network.
    expect(await res.text()).toBe("image url not proxyable");
  });
});
