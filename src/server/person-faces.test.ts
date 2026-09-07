/**
 * A face reaches a person by nconst, ACROSS BOTH DATABASES.
 *
 * `facet-images.test.ts` already pins what `personFaces` does with a `PersonLinks` object,
 * and it builds that object by hand -- which is the one part of this edge that cannot be
 * built by hand in production. The two facts a face needs live in different files: the
 * headshot arrives on a title's `cast` facet and is keyed into `facet_image` in the APP
 * database, while `tmdb person id -> nconst` lives in `person_external` in the INDEX
 * database, which is read-only and rebuilt nightly from the dumps. There is no SQL that can
 * join them, so the join is made in the server -- and until this file nothing measured it.
 *
 * So every fixture here is real: a real `Store` on a temp directory, a real
 * `FacetImageProxy` doing the rewrite, and a real `SearchEngine` over an index built from
 * `SCHEMA` with its crosswalk loaded through `loadPersonCrosswalk`. Only the BYTES are
 * faked, for the reason `facet-images.test.ts` gives: fetching is `ArtworkService`'s job.
 *
 * THE CREDIT'S NAME DELIBERATELY DOES NOT MATCH THE INDEX'S. `personLinks` answers under
 * two keys -- an id and a folded name -- and a fixture that spelled the name the same way on
 * both sides would pass with `person_external` dropped entirely, measuring the fallback
 * while claiming to measure the crosswalk. `CREDIT_NAME` is the provider's misspelling of
 * `INDEX_NAME`, so only the id half can answer.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../lib/config";
import { loadPersonCrosswalk } from "../lib/crosswalk";
import type { ResolvedFacets } from "../lib/facet-resolver";
import { type PersonCredit, tmdbPersonId } from "../lib/facets";
import { SCHEMA } from "../lib/index-builder";
import { SearchEngine } from "../lib/search";
import { Store } from "../lib/store";
import { IMAGE_CACHE_EXT } from "./cache-policy";
import { FACET_IMAGE_PATH, FacetImageProxy, facetImagePath, personFaces } from "./facet-images";

const TCONST = "tt1375666";
const NCONST = "nm0614165";
const TMDB_PERSON = 2037;
const INDEX_NAME = "Cillian Murphy";
/** How the provider spelled it. Close enough to read, too far for `personNameKey`. */
const CREDIT_NAME = "Killian Murphy";
const HEADSHOT = "https://image.tmdb.org/t/p/original/face.jpg";

let dir: string;
let store: Store;
let served: { url: string; size: string }[];
let proxy: FacetImageProxy;

beforeEach(() => {
  dir = mkdtempSync(`${tmpdir()}/finderr-faces-`);
  process.env.FINDERR_DATA_DIR = dir;
  store = new Store(loadConfig(true));
  served = [];
  proxy = new FacetImageProxy({
    store,
    bytes: {
      serveUrl: async (url, size) => {
        served.push({ url, size });
        return new Response("bytes");
      },
    },
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  process.env.FINDERR_DATA_DIR = undefined;
});

/**
 * An index holding one title, one person credited on it, and optionally the crosswalk.
 *
 * `withCrosswalk: false` drops `person_external` outright rather than leaving it empty,
 * because those are different indexes: an empty table is a build that found no pair for
 * this person, and a MISSING one is every index built before the crosswalk stage shipped.
 * Only the second can raise `no such table`, so only the second is worth a fixture.
 */
function indexWith({ withCrosswalk = true } = {}): SearchEngine {
  const path = join(dir, `${crypto.randomUUID()}.db`);
  const db = new Database(path, { create: true });
  db.run(SCHEMA);
  db.run("insert into title (tconst, kind, title, votes) values (?, 'movie', 'Inception', 500)", [TCONST]);
  db.run("insert into person (rowid_, nconst, name) values (1, ?, ?)", [NCONST, INDEX_NAME]);
  db.run(
    "insert into title_principal (title_rowid, person_rowid, category, ordering) values (1,1,'actor',0)",
  );
  // Through the real loader, so the fixture inherits its filters -- in particular the one
  // that keeps only people our `person` table holds, which is what a hand-written insert
  // would quietly skip.
  if (withCrosswalk) loadPersonCrosswalk(db, [{ nconst: NCONST, tmdb: TMDB_PERSON }]);
  else db.run("drop table person_external");
  db.close();
  return new SearchEngine(path, loadConfig(true));
}

/** One cast facet as a provider sends it, BEFORE the proxy rewrites its image. */
function castFacet(over: Partial<PersonCredit> = {}): ResolvedFacets {
  return {
    cast: {
      status: "ready",
      data: [
        {
          name: CREDIT_NAME,
          character: "Fischer",
          order: 1,
          personId: tmdbPersonId(TMDB_PERSON),
          image: HEADSHOT,
          ...over,
        },
      ],
    },
  };
}

/**
 * The whole edge, exactly as the title route runs it: rewrite the facet, ask the index who
 * these people are, file the pair. Returns what a reader would then be handed for `nconst`.
 */
function fileFacesAndRead(engine: SearchEngine, facets: ResolvedFacets, nconst: string): string | null {
  const credits = proxy.rewrite(facets).cast?.data ?? [];
  store.rememberPersonImages(personFaces(credits, engine.personLinks(TCONST, credits)));
  const key = store.personImageKeys([nconst]).get(nconst);
  return key ? facetImagePath(key) : null;
}

describe("a face reaches a person through the crosswalk", () => {
  test("a cast headshot is servable by nconst, as a path of ours", async () => {
    const engine = indexWith();

    const image = fileFacesAndRead(engine, castFacet(), NCONST);

    // A path of ours, never the upstream URL: `localImageUrl` in the browser drops anything
    // else, so an upstream address here would render as initials and look like no coverage.
    // The trailing `.jpg` is the CDN cache hint (`IMAGE_CACHE_EXT`), not a claim about the
    // bytes -- `serveUrl` sends the real `Content-Type` it derived from the upstream path.
    expect(image).toMatch(new RegExp(`^${FACET_IMAGE_PATH}/[0-9a-f]{1,16}\\${IMAGE_CACHE_EXT}$`));
    expect(image).not.toContain("tmdb.org");

    // And it is a key the proxy route already answers -- handed over WITH the extension
    // still on it, exactly as the browser sends it back, which is what pins that the route
    // takes back the shape we issue. That keeps the whole edge one table wide: no bytes
    // stored, no second hash, no second cache.
    const res = await proxy.serve((image as string).slice(FACET_IMAGE_PATH.length + 1), "w342");
    expect(res.status).toBe(200);
    expect(served).toEqual([{ url: HEADSHOT, size: "w342" }]);
  });

  test("nothing but the id could have answered, so the id half is what answered", () => {
    const engine = indexWith();
    // The guard on the fixture itself: strip the id and the same credit resolves to nobody,
    // which is what proves the name half was never quietly carrying this test.
    expect(fileFacesAndRead(engine, castFacet({ personId: null }), NCONST)).toBeNull();
  });

  test("a person we hold no cast facet for gets null, not an error", () => {
    const engine = indexWith();
    fileFacesAndRead(engine, castFacet(), NCONST);

    // The ordinary case rather than a gap: coverage grows with the titles somebody opens,
    // so most people have no row at any moment and their tile draws initials.
    expect(store.personImageKeys(["nm9999999"]).get("nm9999999")).toBeUndefined();
    expect(store.personImageCount()).toBe(1);
  });

  test("an id nobody in our index answers to files nothing", () => {
    const engine = indexWith();
    const stranger = castFacet({ personId: tmdbPersonId(TMDB_PERSON + 1) });

    expect(fileFacesAndRead(engine, stranger, NCONST)).toBeNull();
    expect(store.personImageCount()).toBe(0);
  });
});

/**
 * The upgrade window is real: an index built before the crosswalk stage has cast tables and
 * no `person_external` at all, and it is the index most likely to be live during a rollout.
 * `people.test.ts` pins that `personLinks` degrades there; this pins that the FACE path does
 * too, because a `no such table` raised while filing a face would take out the title route.
 */
describe("an index without the crosswalk degrades instead of throwing", () => {
  test("no crosswalk means no face by id, and no error either", () => {
    const engine = indexWith({ withCrosswalk: false });
    expect(engine.hasPersonIds).toBe(false);

    expect(() => fileFacesAndRead(engine, castFacet(), NCONST)).not.toThrow();
    expect(store.personImageCount()).toBe(0);
  });

  test("the title-scoped name still answers, so degradation is partial rather than total", () => {
    const engine = indexWith({ withCrosswalk: false });
    // The same credit spelled the way the index spells it. Losing the crosswalk costs the
    // people only an id could have named, not everybody.
    const image = fileFacesAndRead(engine, castFacet({ name: INDEX_NAME }), NCONST);
    expect(image).toMatch(new RegExp(`^${FACET_IMAGE_PATH}/`));
  });
});
