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
import {
  FACET_IMAGE_PATH,
  FacetImageProxy,
  facetImagePath,
  type ImageByteSource,
  personFaces,
} from "./facet-images";

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

/**
 * `person_image`: the edge that lets `/search` draw a face instead of initials.
 *
 * THE BUG THIS EXISTS FOR, reported 2026-09-05: searching "Brad Pitt" drew "BP" in a grey
 * box, while the app DB held his headshot on six different titles' cast facets. Nothing
 * could ask for it, because every face is keyed by a hash of its URL and nothing mapped an
 * nconst onto one.
 *
 * Against the real `Store` for the same reason the rest of this file is: the row surviving
 * a restart is most of the point, since a proxy path can arrive with no title read in
 * front of it.
 */
describe("filing a face under our own person id", () => {
  const LINKS = { byId: { p1: "nm-cillian" }, byName: {} };

  /** The credits as they look AFTER the rewrite, which is what the harvest reads. */
  const rewrittenCast = (image: string | null) => proxy.rewrite(castFacets(image)).cast?.data ?? [];

  test("a rewritten headshot is filed under the nconst its credit resolves to", () => {
    const faces = personFaces(rewrittenCast(HEADSHOT), LINKS);
    expect(faces).toHaveLength(1);
    expect(faces[0].nconst).toBe("nm-cillian");

    store.rememberPersonImages(faces);
    // The stored key is the same one the proxy issued, so the face the row points at is
    // one `/img/f/<key>` the route can already serve -- no second hash, no second table.
    expect(store.personImageKeys(["nm-cillian"]).get("nm-cillian")).toBe(faces[0].imageKey);
  });

  test("the round trip is a servable path", async () => {
    store.rememberPersonImages(personFaces(rewrittenCast(HEADSHOT), LINKS));
    const key = store.personImageKeys(["nm-cillian"]).get("nm-cillian") as string;

    expect(facetImagePath(key)).toBe(`${FACET_IMAGE_PATH}/${key}`);
    expect((await proxy.serve(key, "w342")).status).toBe(200);
    expect(served).toEqual([{ url: HEADSHOT, size: "w342" }]);
  });

  test("the FOLDED NAME resolves a credit carrying no person id", () => {
    // Skyhook's series cast has no ids at all, so the name half is the only thing that can
    // answer for a television actor. `personNameKey` folds case and surrounding space.
    const withFace = rewrittenCast(HEADSHOT);
    const idless = withFace.map((c) => ({ ...c, personId: null }));

    expect(personFaces(idless, { byId: {}, byName: { "cillian murphy": "nm-cillian" } })).toEqual(
      personFaces(withFace, LINKS),
    );
  });

  test("a person we cannot name is not filed, and neither is a face we would not fetch", () => {
    // Two separate refusals that must both end in silence rather than a junk row: a credit
    // whose nconst we do not hold, and an image on a host `proxyableImageUrl` rejects --
    // which the rewrite has already turned into `null` by the time the harvest sees it.
    expect(personFaces(rewrittenCast(HEADSHOT), { byId: {}, byName: {} })).toEqual([]);
    expect(personFaces(rewrittenCast("https://evil.example.com/face.jpg"), LINKS)).toEqual([]);
    expect(personFaces(rewrittenCast(null), LINKS)).toEqual([]);
  });

  test("a NEW headshot for the same person replaces the old key rather than being ignored", async () => {
    // `insert or ignore` would pin the first face we ever saw. The key is a hash of the
    // URL, so a provider swapping a portrait yields a different key and the row must move.
    store.rememberPersonImages(personFaces(rewrittenCast(HEADSHOT), LINKS));
    const first = store.personImageKeys(["nm-cillian"]).get("nm-cillian");

    const NEWER = "https://image.tmdb.org/t/p/original/newer-face.jpg";
    store.rememberPersonImages(personFaces(rewrittenCast(NEWER), LINKS));
    const second = store.personImageKeys(["nm-cillian"]).get("nm-cillian");

    expect(second).not.toBe(first);
    expect(await proxy.serve(second as string, "w342").then((r) => r.status)).toBe(200);
    expect(served.at(-1)).toEqual({ url: NEWER, size: "w342" });
  });

  test("people we hold no face for are simply absent from the batch", () => {
    // Which is what makes `null` the ordinary answer on a search row rather than an error:
    // coverage grows with the titles somebody has opened and is never complete.
    store.rememberPersonImages(personFaces(rewrittenCast(HEADSHOT), LINKS));
    const keys = store.personImageKeys(["nm-cillian", "nm-stranger"]);
    expect(keys.has("nm-cillian")).toBe(true);
    expect(keys.has("nm-stranger")).toBe(false);
    expect(store.personImageKeys([]).size).toBe(0);
  });

  test("the row survives the process that wrote it", () => {
    store.rememberPersonImages(personFaces(rewrittenCast(HEADSHOT), LINKS));
    store.close();
    store = new Store(loadConfig(true));
    expect(store.personImageKeys(["nm-cillian"]).get("nm-cillian")).toBeTruthy();
  });
});
