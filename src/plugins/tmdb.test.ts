/**
 * The tmdb plugin, driven the way `GET /api/title/:tconst` drives it.
 *
 * Nothing here touches the network. `fetchImpl` is injected and serves TMDB responses
 * recorded live into `tmdb/fixtures/`, keyed by the v3 path so a fixture is exactly what
 * that path returns. The `watch/providers` documents are trimmed to four countries -- the
 * real ones carry 112 and 138, which is a lot of repetition to keep in git; every country
 * kept is byte-for-byte what TMDB sent, and COUNTRIES are the only thing trimmed. The
 * series fixture is the whole appended detail document, most of which nothing reads, and
 * that is deliberate: a fixture pruned to the fields today's code happens to touch stops
 * being evidence of what the endpoint returns.
 *
 * NO FIXTURE MAY CONTAIN THE API KEY. TMDB takes it as a query parameter, so it rides in
 * the URL rather than the body; the recorder asserted its absence on the way in and
 * `the key never leaks` below asserts it on the way out of every log line.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadConfig } from "../lib/config";
import { FacetResolver } from "../lib/facet-resolver";
import type { FacetEntity, FacetName, FacetShapes } from "../lib/facets";
import { getJson, type PluginFetch, safeUrl } from "../lib/plugin-fetch";
import { BUILTIN_PLUGINS_DIR, loadPlugins } from "../lib/plugins";
import { Store } from "../lib/store";
import { TMDB_HOST } from "../lib/tmdb-api";

const PLUGIN_ID = "tmdb";

/** Not a real key, but the same 32-hex shape, so a leak assertion has something to find. */
const FAKE_API_KEY = "0123456789abcdef0123456789abcdef";

const INCEPTION: FacetEntity = {
  kind: "movie",
  tconst: "tt1375666",
  title: "Inception",
  originalTitle: "Inception",
  year: 2010,
  runtime: 148,
  ids: { imdb: "tt1375666" },
};

const GAME_OF_THRONES: FacetEntity = {
  kind: "series",
  tconst: "tt0944947",
  title: "Game of Thrones",
  originalTitle: "Game of Thrones",
  year: 2011,
  runtime: 57,
  ids: { imdb: "tt0944947" },
};

/** TMDB knows this 1896 short and nobody streams it -- `results` comes back `{}`. */
const LA_CIOTAT: FacetEntity = {
  ...INCEPTION,
  tconst: "tt0000012",
  title: "The Arrival of a Train at La Ciotat",
  originalTitle: "L'arrivée d'un train en gare de La Ciotat",
  year: 1896,
  runtime: 1,
};

/** A tconst TMDB has never heard of: `/find` answers 200 with every list empty. */
const UNKNOWN: FacetEntity = {
  ...INCEPTION,
  tconst: "tt0000000",
  title: "Zqxjwvbn Nonexistent Picture",
  originalTitle: "Zqxjwvbn Nonexistent Picture",
  year: 1911,
};

/** TMDB v3 path -> the recorded answer to it. Anything else is a 404. */
const FIXTURES: Record<string, string> = {
  "/3/find/tt1375666": "find-tt1375666",
  "/3/find/tt0944947": "find-tt0944947",
  "/3/find/tt0000012": "find-tt0000012",
  "/3/find/tt0000000": "find-tt0000000",
  "/3/movie/27205/watch/providers": "movie-27205-watch-providers",
  "/3/movie/160/watch/providers": "movie-160-watch-providers",
  // A SERIES asks once and gets both blocks appended, which is why there is no
  // `/3/tv/1399/keywords` entry any more -- see `tmdb/document.ts`. Keyed on the PATHNAME,
  // so `?append_to_response=...` does not need spelling out here.
  "/3/tv/1399": "tv-1399-append",
};

describe("the tmdb plugin, driven as the API route drives it", () => {
  let dataDir: string;
  let store: Store;
  let logs: string[];
  /** Every URL any plugin asked for, so "one crosswalk per title" is checkable. */
  let askedUrls: string[];

  beforeEach(() => {
    dataDir = mkdtempSync(`${tmpdir()}/finderr-tmdb-test-`);
    process.env.FINDERR_DATA_DIR = dataDir;
    process.env.FINDERR_TMDB_API_KEY = FAKE_API_KEY;
    store = new Store(loadConfig(true));
    logs = [];
    askedUrls = [];
  });

  afterEach(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
    // `delete`, not `= undefined`: assigning to `process.env` stringifies, so the latter
    // leaves the literal "undefined" behind and the config reads it as a configured value.
    delete process.env.FINDERR_DATA_DIR;
    delete process.env.FINDERR_TMDB_API_KEY;
  });

  /**
   * Serves the recorded answers. Everything not addressed to TMDB is a 404, which is how
   * the other plugins in the directory are kept out of these assertions.
   */
  const fromFixtures: PluginFetch = async (input) => {
    const url = new URL(String(input));
    askedUrls.push(url.href);
    const name = url.hostname === TMDB_HOST ? FIXTURES[url.pathname] : undefined;
    if (!name) return new Response("not found", { status: 404 });
    return new Response(await Bun.file(new URL(`./tmdb/fixtures/${name}.json`, import.meta.url)).text(), {
      headers: { "Content-Type": "application/json" },
    });
  };

  /** Only OUR calls. A sibling plugin shares this `fetchImpl` and must not be counted. */
  const tmdbCalls = () => askedUrls.filter((url) => new URL(url).hostname === TMDB_HOST);

  async function resolve(entity: FacetEntity, fetchImpl: PluginFetch = fromFixtures) {
    const registry = await loadPlugins({
      dir: BUILTIN_PLUGINS_DIR,
      kv: store,
      log: (m) => logs.push(m),
      policy: { minIntervalMsPerHost: 0 },
      fetchImpl,
    });
    const resolver = new FacetResolver({ store, registry, log: (m) => logs.push(m) });
    const facets = await resolver.resolve(entity, { deadlineMs: 5_000 });
    return { facets, mine: contributionsOf(entity) };
  }

  /**
   * This plugin's own rows out of SQLite. `keywords` has two providers, so an assertion on
   * the merged facet could not tell whose contribution it was reading.
   */
  function contributionsOf(entity: FacetEntity) {
    const rows = store.facetContributions(entity.tconst).filter((r) => r.plugin_id === PLUGIN_ID);
    const byFacet = new Map(rows.map((r) => [r.facet, r]));
    return {
      outcome: (facet: FacetName) => byFacet.get(facet)?.outcome,
      freshness: (facet: FacetName) => byFacet.get(facet)?.freshness,
      data: <F extends FacetName>(facet: F): FacetShapes[F] => {
        const row = byFacet.get(facet);
        if (!row?.data) throw new Error(`no '${facet}' contribution: outcome ${row?.outcome ?? "missing"}`);
        return JSON.parse(row.data) as FacetShapes[F];
      },
    };
  }

  test("a film gets every country's offers, free and ad-supported folded into flatrate", async () => {
    const { mine } = await resolve(INCEPTION);
    const countries = mine.data("watchProviders");

    // Alphabetical, and only countries that actually offer the film somewhere.
    expect(countries.map((c) => c.country)).toEqual(["DE", "GB", "TH", "US"]);

    const gb = countries.find((c) => c.country === "GB");
    expect(gb?.flatrate).toEqual(["HBO Max Amazon Channel", "Sky Go", "Now TV Cinema", "HBO Max"]);
    expect(gb?.rent).toContain("Apple TV Store");
    expect(gb?.buy).toContain("Amazon Video");

    // Thailand has no subscription offer at all, which is a row rather than a gap.
    const th = countries.find((c) => c.country === "TH");
    expect(th?.flatrate).toEqual([]);
    expect(th?.rent).toEqual(["Apple TV Store", "Google Play Movies"]);
  });

  test("availability never rides the age ladder -- a 2010 film still expires in a week", async () => {
    const { mine } = await resolve(INCEPTION);
    // `volatile`, not `settled`: a licensing deal ends on its own schedule, and the
    // resolver stores the EFFECTIVE class rather than the one the provider claimed.
    expect(mine.freshness("watchProviders")).toBe("volatile");
  });

  test("a series gets both facets, and its keywords land beside the film-only provider's", async () => {
    const { facets, mine } = await resolve(GAME_OF_THRONES);

    expect(mine.data("keywords")).toEqual([
      { id: "tmdb:818", name: "based on novel or book" },
      { id: "tmdb:4152", name: "kingdom" },
      { id: "tmdb:12554", name: "dragon" },
      { id: "tmdb:13084", name: "king" },
      { id: "tmdb:34038", name: "intrigue" },
      { id: "tmdb:170362", name: "fantasy world" },
    ]);
    expect(mine.data("watchProviders").find((c) => c.country === "TH")?.flatrate).toEqual(["HBO Max"]);

    // The merged facet is what the page renders; a sibling contributing nothing here (its
    // hosts 404 under this fixture fetch) must not blank ours.
    expect(facets.keywords?.status).toBe("ready");
  });

  test("a film is served no keywords at all, and pays nothing to find that out", async () => {
    const { mine } = await resolve(INCEPTION);

    // `empty`, not `ready`: a film's chips come from `servarr-metadata`, keyless, and a
    // second copy would render every chip twice.
    expect(mine.outcome("keywords")).toBe("empty");
    expect(tmdbCalls().some((url) => url.includes("/keywords"))).toBe(false);
  });

  test("the crosswalk is bought once and remembered, so a refresh costs one call", async () => {
    await resolve(GAME_OF_THRONES);
    // Two providers, one `/find`: they start in the resolver's one synchronous burst and
    // coalesce on the in-flight map.
    expect(tmdbCalls().filter((url) => url.includes("/find/")).length).toBe(1);
    expect(store.getKv(`plugin:tmdb:tmdb:${GAME_OF_THRONES.tconst}`)).toBe("1399");

    askedUrls = [];
    await resolve(GAME_OF_THRONES);
    // The facet cache answers the facets; `kv` answers the id. Nothing is asked twice.
    expect(tmdbCalls()).toEqual([]);
  });

  /**
   * The whole point of the index crosswalk: `/find` was the first link in this plugin's
   * chain on every cold title, and it answers a question a local table already knows.
   */
  test("an id core already holds skips /find entirely", async () => {
    const { mine } = await resolve({ ...GAME_OF_THRONES, ids: { imdb: "tt0944947", tmdb: 1399 } });

    expect(tmdbCalls().some((url) => url.includes("/find/"))).toBe(false);
    expect(mine.outcome("watchProviders")).toBe("ok");
    // And it is NOT copied into kv: the crosswalk is rebuilt with the index, so a copy here
    // would outlive a correction to it and could never be revised.
    expect(store.getKv(`plugin:tmdb:tmdb:${GAME_OF_THRONES.tconst}`)).toBeNull();
  });

  /**
   * Three serial calls to ONE host used to cost three round trips plus two 250 ms pacer
   * gaps. With the id local and the two blocks appended, a cold series costs one call.
   */
  test("a cold series with a known id costs exactly one TMDB call for both facets", async () => {
    await resolve({ ...GAME_OF_THRONES, ids: { imdb: "tt0944947", tmdb: 1399 } });
    expect(tmdbCalls()).toHaveLength(1);
    expect(new URL(tmdbCalls()[0] ?? "").searchParams.get("append_to_response")).toBe(
      "keywords,watch/providers",
    );
  });

  test("a film does not drag the whole detail document along for one facet", async () => {
    // Only `watchProviders` asks anything for a film, so appending would buy the movie
    // document for nothing. One call either way; the narrower endpoint is the cheaper one.
    await resolve({ ...INCEPTION, ids: { imdb: "tt1375666", tmdb: 27205 } });
    expect(tmdbCalls()).toEqual([
      `https://${TMDB_HOST}/3/movie/27205/watch/providers?api_key=${FAKE_API_KEY}`,
    ]);
  });

  test("a title TMDB has never heard of resolves empty, not failed", async () => {
    const { mine } = await resolve(UNKNOWN);

    // `/find` answers 200 with every list empty, so this is a real "no", cached as such.
    expect(mine.outcome("watchProviders")).toBe("empty");
    // Nothing was learned, so nothing is remembered -- TMDB may index it next month.
    expect(store.getKv(`plugin:tmdb:tmdb:${UNKNOWN.tconst}`)).toBeNull();
  });

  /**
   * "TMDB knows this title and nobody offers it" is a different fact from "TMDB has never
   * heard of it", so it is an empty LIST rather than a `null`. The pane hides itself down
   * the same path either way; the distinction is visible to whoever reads the cache.
   */
  test("a title nobody streams answers with an empty list rather than a row of empty lists", async () => {
    const { mine } = await resolve(LA_CIOTAT);
    expect(mine.outcome("watchProviders")).toBe("ok");
    expect(mine.data("watchProviders")).toEqual([]);
  });

  test("no key means no providers, and the two facets go back to being unanswered", async () => {
    delete process.env.FINDERR_TMDB_API_KEY;
    loadConfig(true);

    const { mine } = await resolve(INCEPTION);

    expect(mine.outcome("watchProviders")).toBeUndefined();
    expect(tmdbCalls()).toEqual([]);
    expect(logs.some((m) => m.includes("no TMDB API key configured"))).toBe(true);
  });

  test("the key never leaks -- not into a log line, and not into an error", async () => {
    const alwaysFails: PluginFetch = async () => new Response("server error", { status: 500 });
    await resolve(INCEPTION, alwaysFails);

    // A 500 throws out of `getJson` and the resolver logs `err.message`, which is the one
    // path that would otherwise print a live credential into the container log.
    expect(logs.some((m) => m.includes("failed for tt1375666"))).toBe(true);
    expect(logs.filter((m) => m.includes(FAKE_API_KEY))).toEqual([]);
  });
});

describe("safeUrl", () => {
  test("drops the query string, which is where a credential rides", () => {
    expect(safeUrl(`https://${TMDB_HOST}/3/find/tt1?external_source=imdb_id&api_key=secret`)).toBe(
      `https://${TMDB_HOST}/3/find/tt1`,
    );
  });

  test("leaves something that is not a URL alone, so a malformed one is still reportable", () => {
    expect(safeUrl("not a url?api_key=secret")).toBe("not a url?api_key=secret");
  });

  test("a failed getJson reports the path and never the query", async () => {
    const fetchImpl: PluginFetch = async () => new Response("nope", { status: 503 });
    const url = `https://${TMDB_HOST}/3/movie/1/watch/providers?api_key=${FAKE_API_KEY}`;

    // AWAITED. Without it the assertion is a floating promise that Bun never settles, so
    // this case reported green while proving nothing -- on the one path that decides
    // whether a live API key reaches a thrown message.
    await expect(getJson(fetchImpl, url)).rejects.toThrow(
      `https://${TMDB_HOST}/3/movie/1/watch/providers answered 503`,
    );
    // And the key itself is absent, not merely the parameter name. Caught by hand rather
    // than through a matcher: `toThrow` takes a substring the message MUST contain, and
    // there is no negated form of it, so a clever-looking `expect.not.stringContaining`
    // here would be a cast that asserts nothing at all.
    const thrown = await getJson(fetchImpl, url).catch((e: Error) => e);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain(FAKE_API_KEY);
  });
});
