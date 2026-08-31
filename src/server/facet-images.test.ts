/**
 * The facet image proxy: what leaves the server, and what comes back for a key.
 *
 * Runs against a REAL `Store` on a temp directory -- the key->URL mapping is the whole
 * mechanism and an in-memory fake would prove nothing about the half that has to survive
 * a restart. The byte source is a fake, because fetching is `ArtworkService`'s job and is
 * tested by not being re-implemented here.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadConfig } from "../lib/config";
import type { ResolvedFacets } from "../lib/facet-resolver";
import { Store } from "../lib/store";
import { FACET_IMAGE_PATH, FacetImageProxy, type ImageByteSource } from "./facet-images";

const HEADSHOT = "https://image.tmdb.org/t/p/original/face.jpg";
const SEASON_POSTER = "https://artworks.thetvdb.com/banners/seasons/1.jpg";

let dir: string;
let store: Store;
let served: { url: string; size: string }[];
let bytes: ImageByteSource;
let proxy: FacetImageProxy;

beforeEach(() => {
  dir = mkdtempSync(`${tmpdir()}/finderr-test-`);
  process.env.FINDERR_DATA_DIR = dir;
  store = new Store(loadConfig(true));
  served = [];
  bytes = {
    serveUrl: async (url, size) => {
      served.push({ url, size });
      return new Response("bytes");
    },
  };
  proxy = new FacetImageProxy({ store, bytes });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  process.env.FINDERR_DATA_DIR = undefined;
});

function castFacets(image: string | null): ResolvedFacets {
  return {
    cast: {
      status: "ready",
      data: [{ name: "Cillian Murphy", character: "Fischer", order: 1, personId: "p1", image }],
    },
  };
}

/** The key out of a rewritten path, so a test never has to know how one is derived. */
function keyIn(path: string): string {
  return path.slice(`${FACET_IMAGE_PATH}/`.length);
}

describe("what leaves the server", () => {
  test("no upstream hostname survives the rewrite, on any of the four image fields", () => {
    const rewritten = proxy.rewrite({
      cast: castFacets(HEADSHOT).cast,
      crew: {
        status: "ready",
        data: [{ name: "Nolan", job: "Director", department: null, personId: null, image: HEADSHOT }],
      },
      seasons: {
        status: "ready",
        data: [
          {
            number: 1,
            name: null,
            episodeCount: 10,
            premiereDate: null,
            endDate: null,
            image: SEASON_POSTER,
          },
        ],
      },
      episodes: {
        status: "ready",
        data: [
          {
            season: 1,
            number: 1,
            title: "One",
            airDate: null,
            overview: null,
            image: SEASON_POSTER,
            runtime: null,
          },
        ],
      },
    });

    const json = JSON.stringify(rewritten);
    expect(json).not.toContain("tmdb.org");
    expect(json).not.toContain("thetvdb.com");
    // Every one of the four came back with a path of ours instead.
    expect(json.match(new RegExp(FACET_IMAGE_PATH, "g"))?.length).toBe(4);
  });

  test("a person with no image keeps its null, so the pane draws initials and fires no request", () => {
    const rewritten = proxy.rewrite(castFacets(null));
    expect(rewritten.cast?.data?.[0].image).toBeNull();
    expect(store.facetImageCount()).toBe(0);
  });

  /**
   * A host `serveUrl` would refuse is not a path worth handing out: the browser would
   * follow it and get a 400. Null instead, and the pane falls back at once.
   */
  test("an image on a host we would never fetch is cleared, not proxied", () => {
    const rewritten = proxy.rewrite(castFacets("https://evil.example.com/face.jpg"));
    expect(rewritten.cast?.data?.[0].image).toBeNull();
    expect(store.facetImageCount()).toBe(0);
  });

  test("a facet that is not ready is passed through untouched", () => {
    const pending: ResolvedFacets = { cast: { status: "pending" }, synopsis: { status: "failed" } };
    expect(proxy.rewrite(pending)).toEqual(pending);
  });

  /**
   * The key is a hash of the URL, not of the provider's person id. Two plugins naming the
   * same face therefore agree on one key and share one cached file.
   */
  test("the same upstream URL always gets the same key", () => {
    const first = proxy.rewrite(castFacets(HEADSHOT)).cast?.data?.[0].image;
    const second = proxy.rewrite(castFacets(HEADSHOT)).cast?.data?.[0].image;
    expect(first).toBe(second as string);
    expect(store.facetImageCount()).toBe(1);
  });
});

describe("serving a key back", () => {
  test("a key we issued resolves to the upstream URL, and only the bytes layer sees it", async () => {
    const path = proxy.rewrite(castFacets(HEADSHOT)).cast?.data?.[0].image as string;

    const res = await proxy.serve(keyIn(path), "w185");

    expect(res.status).toBe(200);
    expect(served).toEqual([{ url: HEADSHOT, size: "w185" }]);
  });

  test("a key we never issued is a 404 and no fetch at all", async () => {
    const res = await proxy.serve("deadbeef", "w342");
    expect(res.status).toBe(404);
    expect(served).toEqual([]);
  });

  test("anything that is not a key we could have issued is refused before the lookup", async () => {
    for (const key of ["../../etc/passwd", "https://evil.example.com/x.jpg", ""]) {
      expect((await proxy.serve(key, "w342")).status).toBe(400);
    }
    expect(served).toEqual([]);
  });

  /**
   * The mapping is on disk for exactly this: the client caches a title's facets, so an
   * image request can arrive after a restart with no `/api/title` read in front of it.
   */
  test("a key still resolves after the process that issued it is gone", async () => {
    const path = proxy.rewrite(castFacets(HEADSHOT)).cast?.data?.[0].image as string;

    store.close();
    store = new Store(loadConfig(true));
    const afterRestart = new FacetImageProxy({ store, bytes });

    expect((await afterRestart.serve(keyIn(path), "w342")).status).toBe(200);
    expect(served).toEqual([{ url: HEADSHOT, size: "w342" }]);
  });
});
