/**
 * The tmdb plugin, driven the way `GET /api/title/:tconst` drives it.
 *
 * Nothing here touches the network. `fetchImpl` is injected and serves TMDB responses
 * recorded live into `tmdb/fixtures/`, keyed by the v3 path so a fixture is exactly what
 * that path returns. The series fixture is the whole appended detail document, most of
 * which nothing reads, and that is deliberate: a fixture pruned to the FIELDS today's code
 * happens to touch stops being evidence of what the endpoint returns.
 *
 * LIST LENGTHS are trimmed, and nothing else. Every entry kept is byte-for-byte what TMDB
 * sent, in the order it sent them; what is dropped is repetition that would cost hundreds
 * of kilobytes of git to prove a shape one entry already proves:
 *
 *   - `watch/providers` down to four countries, from the real 112 and 138.
 *   - `aggregate_credits.cast` down to the 60 TOP-BILLED of 587, which is the whole cast
 *     for the top of the list and enough to exercise the fifty the provider keeps.
 *   - `aggregate_credits.crew` down to 2 of 348. Nothing reads a series' crew; the block
 *     is kept non-empty so the shape of what arrives is still on file.
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
import { SKYHOOK_HOST } from "./servarr/skyhook";
import { MAX_SERIES_CAST, parseSeriesCast, type TmdbAggregateCreditsResponse } from "./tmdb/cast";
import { SERIES_APPEND } from "./tmdb/document";
import { parseWatchProviders } from "./tmdb/watch-providers";

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

/** skyhook's own recording, borrowed from the sibling plugin's fixtures. See `withSkyhook`. */
const SKYHOOK_FIXTURES: Record<string, string> = {
  "/v1/tvdb/search/en/": "skyhook-search-tt0944947.json",
  "/v1/tvdb/shows/en/121361": "skyhook-121361.json",
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
    delete process.env.FINDERR_TMDB_WATCH_PROVIDER_REGIONS;
    delete process.env.FINDERR_REGIONS;
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

  /**
   * The same, plus skyhook's recorded series document.
   *
   * Deliberately a SECOND fetch rather than more entries in `FIXTURES`: every other test
   * here reads this plugin's own contribution and relies on the siblings 404ing, so waking
   * `servarr-metadata` for all of them would make those assertions depend on a payload they
   * are not about. Only the precedence test needs two providers answering `cast` at once.
   */
  const withSkyhook: PluginFetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname !== SKYHOOK_HOST) return fromFixtures(input, init);
    askedUrls.push(url.href);
    const name = SKYHOOK_FIXTURES[url.pathname];
    if (!name) return new Response("not found", { status: 404 });
    return new Response(await Bun.file(new URL(`./servarr/fixtures/${name}`, import.meta.url)).text(), {
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

  /**
   * The whole point of the card: skyhook's actors carry no id in any space, so before this
   * a series cast was plain text unless the title-scoped name join happened to find it.
   */
  test("a series' cast arrives top-billed first, with a person id on every entry", async () => {
    const { mine } = await resolve(GAME_OF_THRONES);
    const cast = mine.data("cast");

    expect(cast[0]).toEqual({
      name: "Peter Dinklage",
      character: "Tyrion 'The Halfman' Lannister",
      order: 0,
      personId: "tmdb:22970",
      image: "https://image.tmdb.org/t/p/original/9CAd7wr8QZyIN0E7nm8v1B6WkGn.jpg",
    });
    expect(cast.every((member) => member.personId !== null)).toBe(true);

    // SORTED, because the array is not: TMDB sends `0,1,5,6,8,...` and puts Sean Bean at
    // billing 2 forty entries in, so taking them as they arrive drops leads for bit parts.
    expect(cast.map((m) => m.order)).toEqual([...cast.map((m) => m.order)].sort((a, b) => a - b));
    expect(cast.slice(0, 3).map((m) => m.name)).toEqual(["Peter Dinklage", "Kit Harington", "Sean Bean"]);
  });

  test("the tail is dropped rather than cached -- nobody scrolls to the 300th guest part", async () => {
    const { mine } = await resolve(GAME_OF_THRONES);
    expect(mine.data("cast")).toHaveLength(MAX_SERIES_CAST);
  });

  /**
   * The merge, end to end, with BOTH cast providers awake. This is what `precedence` in the
   * vocabulary buys: skyhook still answers, its answer is still cached under its own plugin
   * id, and the page renders TMDB's alone -- so nobody appears twice and every name links.
   */
  test("skyhook's id-less cast is superseded, not concatenated", async () => {
    const { facets } = await resolve(GAME_OF_THRONES, withSkyhook);
    const cast = facets.cast?.data ?? [];

    // Both providers answered: skyhook's 44 would have made this 94 under a plain merge.
    const rows = store.facetContributions(GAME_OF_THRONES.tconst).filter((r) => r.facet === "cast");
    expect(rows.map((r) => r.plugin_id).sort()).toEqual(["servarr-metadata", "tmdb"]);

    expect(cast).toHaveLength(MAX_SERIES_CAST);
    expect(cast.every((member) => member.personId !== null)).toBe(true);
    expect(cast.filter((m) => m.name === "Kit Harington")).toHaveLength(1);
  });

  test("a film is served no cast at all, for the same reason it is served no keywords", async () => {
    const { mine } = await resolve(INCEPTION);
    // `api.radarr.video` already returns a film's credits with TMDB person ids on them.
    expect(mine.outcome("cast")).toBe("empty");
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
  test("a cold series with a known id costs exactly one TMDB call for every facet", async () => {
    await resolve({ ...GAME_OF_THRONES, ids: { imdb: "tt0944947", tmdb: 1399 } });
    expect(tmdbCalls()).toHaveLength(1);
    // Three appended blocks now, and still one round trip -- which is why `cast` was worth
    // adding here rather than through the dedicated `/tv/{id}/aggregate_credits` endpoint.
    expect(new URL(tmdbCalls()[0] ?? "").searchParams.get("append_to_response")).toBe(SERIES_APPEND);
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

  test("no key means no providers, and the facets go back to being unanswered", async () => {
    delete process.env.FINDERR_TMDB_API_KEY;
    loadConfig(true);

    const { mine } = await resolve(INCEPTION);

    expect(mine.outcome("watchProviders")).toBeUndefined();
    expect(tmdbCalls()).toEqual([]);
    expect(logs.some((m) => m.includes("no TMDB API key configured"))).toBe(true);
  });

  /**
   * The constraint that rules out simply deleting skyhook's cast: with no key its 44 id-less
   * actors are all a series has, and the name join still links some of them. Precedence over
   * an absent contribution needs no special case -- a dark provider contributes nothing.
   */
  test("without a key a series still renders skyhook's cast, exactly as before", async () => {
    delete process.env.FINDERR_TMDB_API_KEY;
    loadConfig(true);

    const { facets } = await resolve(GAME_OF_THRONES, withSkyhook);
    const cast = facets.cast?.data ?? [];

    expect(facets.cast?.status).toBe("ready");
    expect(cast).toHaveLength(44);
    expect(cast.every((member) => member.personId === null)).toBe(true);
  });

  test("the key never leaks -- not into a log line, and not into an error", async () => {
    const alwaysFails: PluginFetch = async () => new Response("server error", { status: 500 });
    await resolve(INCEPTION, alwaysFails);

    // A 500 throws out of `getJson` and the resolver logs `err.message`, which is the one
    // path that would otherwise print a live credential into the container log.
    expect(logs.some((m) => m.includes("failed for tt1375666"))).toBe(true);
    expect(logs.filter((m) => m.includes(FAKE_API_KEY))).toEqual([]);
  });

  /**
   * The whole point of the setting, checked where it actually matters: on the CACHED ROW.
   * The parser tests below prove the filter; this proves the operator's env var reaches it
   * through config, plugin init and the document fetch, which is four seams the unit tests
   * cannot see.
   */
  test("a configured region list trims what is cached, for a film and for a series", async () => {
    process.env.FINDERR_TMDB_WATCH_PROVIDER_REGIONS = "th, gb";
    loadConfig(true);

    const film = await resolve(INCEPTION);
    expect(film.mine.data("watchProviders").map((c) => c.country)).toEqual(["GB", "TH"]);

    const series = await resolve(GAME_OF_THRONES);
    expect(series.mine.data("watchProviders").map((c) => c.country)).toEqual(["GB", "TH"]);
  });

  /**
   * The regression this key exists to avoid. `regions` DEFAULTS to `["US"]`, so reusing it
   * would have trimmed every deployment that never asked for anything -- and a reader
   * outside those countries loses the pane outright, because `pickWatchProviders` has no
   * fallback to "whatever country we do have".
   */
  test("an unset region list keeps every country, whatever `regions` happens to say", async () => {
    process.env.FINDERR_REGIONS = "US";
    delete process.env.FINDERR_TMDB_WATCH_PROVIDER_REGIONS;
    loadConfig(true);

    const { mine } = await resolve(INCEPTION);
    expect(mine.data("watchProviders").map((c) => c.country)).toEqual(["DE", "GB", "TH", "US"]);
  });
});

/**
 * The filter itself, against the shape rather than the fixture -- these are the cases the
 * plugin path cannot reach, because an env var cannot express "empty list" distinctly from
 * "unset" once it has been through `loadConfig`.
 */
describe("parseWatchProviders region filter", () => {
  const RESULTS = {
    results: {
      US: { flatrate: [{ provider_name: "Netflix" }] },
      GB: { flatrate: [{ provider_name: "Now" }] },
      TH: { rent: [{ provider_name: "Apple TV Store" }] },
    },
  };
  const countries = (regions?: readonly string[]) =>
    (parseWatchProviders(RESULTS, regions) ?? []).map((c) => c.country);

  test("undefined keeps every country -- the default and today's behaviour", () => {
    expect(countries()).toEqual(["GB", "TH", "US"]);
  });

  /**
   * An env var of `""` or `" , "` parses down to an empty array, and reading THAT as "keep
   * no countries" would blank the facet for every title on a typo rather than failing
   * anywhere a person would notice.
   */
  test("an empty list keeps every country too, because a typo must not empty the facet", () => {
    expect(countries([])).toEqual(["GB", "TH", "US"]);
  });

  test("a configured list keeps only those, still alphabetical", () => {
    expect(countries(["TH", "US"])).toEqual(["TH", "US"]);
  });

  test("matching is case-insensitive, so a lower-cased env value still works", () => {
    expect(countries(["th"])).toEqual(["TH"]);
  });

  test("a region the title is not offered in yields an empty list, not every country", () => {
    expect(countries(["JP"])).toEqual([]);
  });
});

/**
 * The shapes the fixture cannot reach. Game of Thrones' 60 top-billed happen to carry a
 * name, a role and a billing rank each, so the cases that decide whether a credit is
 * DROPPED or merely thin are only checkable against the shape.
 */
describe("parseSeriesCast", () => {
  const IMAGE_BASE = "https://image.tmdb.org/t/p";
  const parse = (cast: NonNullable<TmdbAggregateCreditsResponse["cast"]>) =>
    parseSeriesCast({ cast }, IMAGE_BASE) ?? [];

  test("an absent block is null -- TMDB does not have this show", () => {
    expect(parseSeriesCast(null, IMAGE_BASE)).toBeNull();
    expect(parseSeriesCast(undefined, IMAGE_BASE)).toBeNull();
  });

  /** A show TMDB knows with nobody credited is a real answer, and caches as an empty facet. */
  test("a show with no credits is an empty list, not a null", () => {
    expect(parseSeriesCast({}, IMAGE_BASE)).toEqual([]);
  });

  /**
   * A person can hold several roles across a run. `character` is one line under a 96px
   * tile, so the part they played most is the honest single answer.
   */
  test("the most-episodes role is the one shown", () => {
    const [member] = parse([
      {
        id: 1,
        name: "Kristian Nairn",
        order: 0,
        roles: [
          { character: "Bar Patron", episode_count: 1 },
          { character: "Hodor", episode_count: 41 },
        ],
      },
    ]);
    expect(member.character).toBe("Hodor");
  });

  test("a credit with no role at all is still a credit, with nothing to say about it", () => {
    expect(parse([{ id: 1, name: "Somebody", order: 3, roles: [] }])[0].character).toBeNull();
    expect(parse([{ id: 1, name: "Somebody", order: 3 }])[0].character).toBeNull();
  });

  /** A nameless credit is not a credit. Everything else has a defensible empty form. */
  test("a credit with no name is dropped", () => {
    expect(
      parse([
        { id: 1, name: "   ", order: 0 },
        { id: 2, name: "Real", order: 1 },
      ]),
    ).toHaveLength(1);
  });

  test("no headshot is a null image, so the tile draws initials rather than a broken request", () => {
    expect(parse([{ id: 1, name: "Somebody", order: 0 }])[0].image).toBeNull();
  });

  /**
   * The only field that decides whether the answer is linkable at all, so an entry without
   * one says so rather than inventing an id -- and that missing id is exactly what
   * `precedence` measures.
   */
  test("a credit with no TMDB id carries no person id", () => {
    expect(parse([{ name: "Somebody", order: 0 }])[0].personId).toBeNull();
  });

  /** `order` is a rank from zero, so anything that looks like a number would promote it. */
  test("an unranked credit sorts last rather than first", () => {
    const parsed = parse([
      { id: 1, name: "Unranked" },
      { id: 2, name: "Lead", order: 0 },
    ]);
    expect(parsed.map((m) => m.name)).toEqual(["Lead", "Unranked"]);
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
