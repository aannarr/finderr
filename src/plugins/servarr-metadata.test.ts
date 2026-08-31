/**
 * The servarr-metadata plugin, driven exactly as the server drives it.
 *
 * Every test loads the real plugin directory through `loadPlugins` and resolves through a
 * real `FacetResolver` over a real SQLite store, so what is asserted is what
 * `GET /api/title/:tconst` would hand a browser -- not the mapping functions in isolation.
 *
 * Nothing here touches the network. `fetchImpl` is injected and serves payloads recorded
 * live on 2026-08-30 from `api.radarr.video` and `skyhook.sonarr.tv` into
 * `servarr/fixtures/`, trimmed of the artwork and translation blocks no facet reads.
 * Re-record them by fetching the same three URLs when an upstream shape changes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadConfig } from "../lib/config";
import { FacetResolver } from "../lib/facet-resolver";
import type { FacetEntity, FacetName, FacetShapes } from "../lib/facets";
import type { PluginFetch } from "../lib/plugin-fetch";
import { BUILTIN_PLUGINS_DIR, loadPlugins, type PluginRegistry } from "../lib/plugins";
import { Store } from "../lib/store";

const PLUGIN_ID = "servarr-metadata";

/**
 * The hosts this plugin reaches, and the filter on what `asked` records.
 *
 * `loadPlugins` loads the whole directory, so every plugin in it shares the injected
 * `fetchImpl` and a sibling's calls would otherwise land in this plugin's call log and
 * break its call-count assertions the day somebody adds one.
 */
const OUR_HOSTS = new Set(["api.radarr.video", "skyhook.sonarr.tv"]);

const INCEPTION: FacetEntity = {
  kind: "movie",
  tconst: "tt1375666",
  title: "Inception",
  originalTitle: "Inception",
  year: 2010,
  runtime: 148,
  ids: { imdb: "tt1375666" },
};

const DARK_KNIGHT: FacetEntity = { ...INCEPTION, tconst: "tt0468569", title: "The Dark Knight", year: 2008 };

/** A film that belongs to a collection -- Inception and The Dark Knight do not. */
const MATRIX: FacetEntity = {
  ...INCEPTION,
  tconst: "tt0133093",
  title: "The Matrix",
  originalTitle: "The Matrix",
  year: 1999,
  ids: { imdb: "tt0133093" },
};

/**
 * A HINDI film with an ENGLISH synopsis -- the one shape that tells the two language facts
 * apart, and the title aannarr pointed at when he asked for this. Inception cannot prove
 * either half: its original language IS English, so the bug and the fix agree on it.
 */
const BOKSHI: FacetEntity = {
  ...INCEPTION,
  tconst: "tt12574330",
  title: "Bokshi",
  originalTitle: "Bokshi",
  year: 2026,
  ids: { imdb: "tt12574330" },
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

/** URL -> recorded payload. A URL absent from here is a 404, which is a real answer. */
const FIXTURES: Record<string, string> = {
  "https://api.radarr.video/v1/movie/imdb/tt1375666": "radarr-tt1375666.json",
  "https://api.radarr.video/v1/movie/imdb/tt0468569": "radarr-tt0468569.json",
  "https://api.radarr.video/v1/movie/imdb/tt0133093": "radarr-tt0133093.json",
  "https://api.radarr.video/v1/movie/imdb/tt12574330": "radarr-tt12574330.json",
  "https://api.radarr.video/v1/movie/collection/2344": "radarr-collection-2344.json",
  "https://skyhook.sonarr.tv/v1/tvdb/search/en/?term=imdb:tt0944947": "skyhook-search-tt0944947.json",
  "https://skyhook.sonarr.tv/v1/tvdb/shows/en/121361": "skyhook-121361.json",
};

let dataDir: string;
let store: Store;
let logs: string[];
/** Every URL THIS plugin asked for, in order -- the call-count assertions read this. */
let asked: string[];

/** Record a call if it is one of ours. See `OUR_HOSTS`. */
function recordCall(url: string): void {
  if (OUR_HOSTS.has(new URL(url).hostname)) asked.push(url);
}

beforeEach(() => {
  dataDir = mkdtempSync(`${tmpdir()}/finderr-servarr-test-`);
  process.env.FINDERR_DATA_DIR = dataDir;
  store = new Store(loadConfig(true));
  logs = [];
  asked = [];
});

afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
  process.env.FINDERR_DATA_DIR = undefined;
});

/** Serves the recorded payloads, or a 404 for a title nothing was recorded for. */
const fromFixtures: PluginFetch = async (input) => {
  const url = String(input);
  recordCall(url);
  const file = FIXTURES[url];
  if (!file) return new Response("not found", { status: 404 });
  return new Response(await Bun.file(new URL(`./servarr/fixtures/${file}`, import.meta.url)).text(), {
    headers: { "Content-Type": "application/json" },
  });
};

const alwaysFails: PluginFetch = async (input) => {
  recordCall(String(input));
  return new Response("bad gateway", { status: 502 });
};

const mustNotBeCalled: PluginFetch = async (input) => {
  throw new Error(`the render path must not fetch, but asked for ${input}`);
};

function load(fetchImpl: PluginFetch): Promise<PluginRegistry> {
  return loadPlugins({
    dir: BUILTIN_PLUGINS_DIR,
    kv: store,
    log: (m) => logs.push(m),
    policy: { minIntervalMsPerHost: 0 },
    fetchImpl,
  });
}

/**
 * Resolve one entity and hand back both views of the answer.
 *
 * `facets` is what the API route would serve, merged across every loaded plugin; `mine`
 * is this plugin's own contribution, read back out of SQLite. Assertions about payload
 * mapping use `mine`, so a sibling plugin contributing to `ratings` later cannot make
 * this test fail for a reason that has nothing to do with it.
 */
async function resolve(entity: FacetEntity, fetchImpl: PluginFetch = fromFixtures) {
  const registry = await load(fetchImpl);
  const resolver = new FacetResolver({ store, registry, log: (m) => logs.push(m) });
  const facets = await resolver.resolve(entity, { deadlineMs: 5_000 });
  return { facets, mine: contributionsOf(entity), registry };
}

/** This plugin's stored rows for one entity, parsed, keyed by facet. */
function contributionsOf(entity: FacetEntity) {
  const rows = store.facetContributions(entity.tconst).filter((r) => r.plugin_id === PLUGIN_ID);
  const byFacet = new Map(rows.map((r) => [r.facet, r]));
  return {
    outcome: (facet: FacetName) => byFacet.get(facet)?.outcome,
    data: <F extends FacetName>(facet: F): FacetShapes[F] => {
      const row = byFacet.get(facet);
      if (!row?.data) throw new Error(`no '${facet}' contribution: outcome ${row?.outcome ?? "missing"}`);
      return JSON.parse(row.data) as FacetShapes[F];
    },
  };
}

describe("movies, from api.radarr.video", () => {
  test("the full cast arrives with headshots and billing order", async () => {
    const { facets, mine } = await resolve(INCEPTION);

    expect(facets.cast?.status).toBe("ready");
    const cast = mine.data("cast");
    expect(cast).toHaveLength(30);
    expect(cast[0]).toEqual({
      name: "Leonardo DiCaprio",
      character: "Dom Cobb",
      order: 0,
      personId: "tmdb:6193",
      image: "https://image.tmdb.org/t/p/original/wo2hJpn04vbtmh0B9utCFdsQhxM.jpg",
    });
    // 27 of the 30 have a headshot upstream; the three bit-part actors who do not get a
    // null rather than a broken image URL, so a pane can render its own initials tile.
    expect(cast.filter((c) => c.image !== null)).toHaveLength(27);
  });

  test("crew carries the job and the department", async () => {
    const { mine } = await resolve(INCEPTION);

    const crew = mine.data("crew");
    expect(crew).toHaveLength(30);
    expect(crew[0]).toEqual({
      name: "Christopher Nolan",
      job: "Director",
      department: "Directing",
      personId: "tmdb:525",
      image: "https://image.tmdb.org/t/p/original/xuAIuYSmsUzKlUMBFGVZaWsY3DZ.jpg",
    });
  });

  test("five rating sources, each on its own scale and attributed correctly", async () => {
    const { mine } = await resolve(INCEPTION);

    // Every source in the payload claims `Type: "User"`, including the two critic
    // aggregates, so this is the assertion that the plugin ignores it.
    expect(mine.data("ratings")).toEqual([
      { source: "Tmdb", kind: "user", value: 8.4, outOf: 10, count: 40020 },
      { source: "Imdb", kind: "user", value: 8.8, outOf: 10, count: 2858566 },
      { source: "Metacritic", kind: "critics", value: 74, outOf: 100 },
      { source: "RottenTomatoes", kind: "critics", value: 86, outOf: 100 },
      { source: "Trakt", kind: "user", value: 8.73541, outOf: 10, count: 62213 },
    ]);
  });

  test("certification, keywords, trailer, related and the synopsis all come off the one payload", async () => {
    const { mine } = await resolve(INCEPTION);

    expect(mine.data("certification")).toContainEqual({ country: "US", rating: "PG-13" });
    expect(mine.data("certification").length).toBeGreaterThan(40);
    expect(mine.data("keywords")).toContainEqual({ id: "dream", name: "dream" });
    expect(mine.data("trailer")).toEqual([
      { site: "youtube", key: "cdx31ak4KbQ", name: null, kind: "Trailer" },
    ]);
    // `tconst` is null because this endpoint identifies recommendations by TMDB id --
    // but the id is CARRIED, which is what keeps the edge resolvable later. Dropping it
    // left a list of bare title strings nothing could ever link to a page.
    expect(mine.data("related")).toContainEqual({
      tconst: null,
      title: "The Matrix",
      reason: "recommended",
      tmdbId: 603,
    });
    expect(mine.data("synopsis").source).toBe("tmdb");
    expect(mine.data("synopsis").text).toContain("Cobb");
    expect(mine.data("externalIds")).toEqual({ tmdb: 27205, imdb: "tt1375666" });
  });

  /**
   * REGRESSION. `synopsis.language` described the FILM, not the WORDS.
   *
   * It was `movie.OriginalLanguage ?? "en"`, which is the language the film was shot in --
   * so `tt12574330` (Bokshi, Hindi) cached an English paragraph from TMDB under
   * `language: "hi"`. The two facts are both real and they are not the same fact, which is
   * exactly what the `language` facet below now exists to carry. Skyhook never had the bug
   * because it pins the language segment it ASKED for.
   *
   * The Dark Knight is the second half of the proof: `OriginalLanguage` is `null` on its
   * payload, and the old `?? "en"` guessed the right answer for the wrong reason.
   */
  test("the synopsis is in the language we were served, never the language of the film", async () => {
    const hindiFilm = await resolve(BOKSHI);

    // The paragraph itself, so the assertion below is about real English prose rather
    // than about a string constant agreeing with another string constant.
    expect(hindiFilm.mine.data("synopsis").text).toContain("her history teacher");
    expect(hindiFilm.mine.data("synopsis").language).toBe("en");
    // ... while the FILM is Hindi. Both facts, kept apart.
    expect(hindiFilm.mine.data("language")).toEqual([{ code: "hi" }]);
  });

  test("the original language is its own facet, and an unstated one is empty rather than English", async () => {
    const stated = await resolve(INCEPTION);
    expect(stated.mine.data("language")).toEqual([{ code: "en" }]);

    // `OriginalLanguage: null` upstream. "We were not told" must not render as "English",
    // which is what the old `?? "en"` did on this exact payload.
    //
    // An explicit `[]` and outcome `ok`, the same shape a series' `trailer` gets: we asked
    // and this document has no language in it. `empty` would be the absent-key case, which
    // means something weaker -- nobody contributed at all. Both draw nothing; only one of
    // them is a fact.
    const unstated = await resolve(DARK_KNIGHT);
    expect(unstated.mine.data("language")).toEqual([]);
    expect(unstated.mine.outcome("language")).toBe("ok");
  });

  /**
   * The `links` facet carries what no id space can express. IMDb, TMDB and Trakt are built
   * at render time from `externalIds` above, so contributing them here would be a second
   * copy of a fact we already hold -- `Homepage` is the one address with no id behind it,
   * and it rides a document this plugin already fetches, so it costs no extra call.
   */
  test("the film's own site is a link, and the id spaces deliberately are not", async () => {
    const { mine } = await resolve(INCEPTION);

    expect(mine.data("links")).toEqual([
      { kind: "homepage", url: "https://www.warnerbros.com/movies/inception" },
    ]);
  });

  test("release dates are calendar dates, not the midnight timestamps upstream sends", async () => {
    const { mine } = await resolve(INCEPTION);

    expect(mine.data("releaseDates")).toEqual({
      cinema: "2010-07-15",
      physical: "2010-12-03",
      digital: "2013-03-04",
    });
  });

  /**
   * Inception is a standalone film, so "no collection" is the correct answer for it and
   * the facet resolves `empty` -- the card's acceptance list is wrong on that one point.
   * The Dark Knight is the case that proves the mapping when a collection does exist.
   */
  test("a film in a collection gets one; a standalone film gets an honest empty", async () => {
    const standalone = await resolve(INCEPTION);
    expect(standalone.facets.collection?.status).toBe("empty");
    expect(standalone.mine.outcome("collection")).toBe("empty");

    const sequel = await resolve(DARK_KNIGHT);
    expect(sequel.mine.data("collection")).toEqual({
      id: "tmdb:263",
      name: "The Dark Knight Collection",
      // This endpoint always sends `Parts: null` -- the collection has a name, never members.
      parts: [],
    });
  });
});

describe("series, from skyhook.sonarr.tv", () => {
  test("named seasons, with counts and dates derived from the episodes", async () => {
    const { facets, mine } = await resolve(GAME_OF_THRONES);

    expect(facets.seasons?.status).toBe("ready");
    const seasons = mine.data("seasons");
    // Nine entries because season 0 is the specials, and eight of them are named.
    expect(seasons).toHaveLength(9);
    expect(seasons.filter((s) => s.name !== null)).toHaveLength(8);
    expect(seasons.find((s) => s.number === 1)).toEqual({
      number: 1,
      name: "Winter is Coming",
      episodeCount: 10,
      premiereDate: "2011-04-17",
      endDate: "2011-06-19",
      image: "https://artworks.thetvdb.com/banners/seasons/5cc751cfeb87d.jpg",
    });
  });

  test("every episode has a real air date", async () => {
    const { facets, mine } = await resolve(GAME_OF_THRONES);

    expect(facets.episodes?.status).toBe("ready");
    const episodes = mine.data("episodes");
    expect(episodes).toHaveLength(128);
    expect(episodes.filter((e) => e.airDate !== null).length).toBe(episodes.length);
    expect(episodes.find((e) => e.season === 1 && e.number === 1)).toMatchObject({
      title: "Winter Is Coming",
      airDate: "2011-04-17",
    });
  });

  test("actors, the content rating and every external id in one document", async () => {
    const { mine } = await resolve(GAME_OF_THRONES);

    expect(mine.data("cast")[0]).toEqual({
      name: "Sean Bean",
      character: "Ned Stark",
      order: 0,
      personId: null,
      image: "https://artworks.thetvdb.com/banners/person/247858/primary.jpg",
    });
    expect(mine.data("certification")).toEqual([{ country: "US", rating: "TV-MA" }]);
    expect(mine.data("externalIds")).toEqual({
      tvdb: 121361,
      imdb: "tt0944947",
      tmdb: 1399,
      tvmaze: 82,
      tvrage: 24493,
    });
  });

  /**
   * Skyhook's `rating` is IMDb's number wearing TVDB's name, so we contribute nothing.
   *
   * Measured against our own index on 2026-08-31, four series deep: Game of Thrones
   * skyhook 9.2/2,655,012 against local IMDb 9.2/2,655,421; Rick and Morty 9.0/709,992
   * against 9.0/710,162; Breaking Bad 9.5/2,667,461 against 9.5/2,668,026; Friends
   * 8.8/1,205,327 against 8.8/1,205,495. Same value every time and a count within a few
   * hundred -- a stale snapshot of the IMDb aggregate, not a TVDB one. TheTVDB's own
   * scores are out of 10 over a few thousand voters and look nothing like this.
   *
   * Emitting it as `Tvdb` printed the same number twice in one row under two marks. Emitting
   * it as `Imdb` would be worse: `mergeRatings` lets a provider entry replace the local seed
   * outright, so a stale count would evict the fresh one AND drop the only link on the tile.
   * We already hold IMDb's rating locally for all 1,275,341 indexed titles, refreshed daily.
   */
  test("skyhook's rating is IMDb's, so no Tvdb score is contributed", async () => {
    // Asserted so a re-recorded fixture that loses the field cannot make this vacuous:
    // the point is what we do with a rating that IS there, not that there is none.
    const show = await Bun.file(new URL("./servarr/fixtures/skyhook-121361.json", import.meta.url)).json();
    expect(show.rating).toEqual({ count: 2655012, value: "9.2" });

    const { mine } = await resolve(GAME_OF_THRONES);
    expect(mine.outcome("ratings")).toBe("empty");
  });

  /**
   * "No trailer" and "nobody looked" must not render the same. Skyhook carries no TV
   * trailer at all, so the facet is explicitly empty rather than absent.
   */
  test("a series gets an explicitly empty trailer, and nothing for the facets skyhook lacks", async () => {
    const { facets, mine } = await resolve(GAME_OF_THRONES);

    expect(mine.data("trailer")).toEqual([]);
    expect(facets.trailer).toEqual({ status: "ready", data: [] });
    // Skyhook carries no homepage either, so a series has no `links` contribution at all --
    // which is `empty` rather than the explicit `[]` the trailer facet gets. Both render as
    // nothing; only the trailer case is worth stating upstream, because "we looked and TV
    // trailers are not in this document" is a fact and this is merely an absent field.
    expect(mine.outcome("links")).toBe("empty");
    for (const absent of ["crew", "keywords", "related"] as const) {
      expect(mine.outcome(absent)).toBe("empty");
    }
  });

  /**
   * The two proxies do not speak the same ISO. Skyhook sends `eng`, Radarr sends `en`, and
   * a facet that merges as a LIST would carry both as separate languages the day a second
   * provider answers for one title. The fold happens at the provider boundary, so the code
   * that reaches the cache is already the one shape.
   */
  test("skyhook's three-letter language code is folded to the form Radarr sends", async () => {
    const { mine } = await resolve(GAME_OF_THRONES);

    expect(mine.data("language")).toEqual([{ code: "en" }]);
  });

  test("the tconst -> tvdbId crosswalk is bought once per series, ever", async () => {
    await resolve(GAME_OF_THRONES);
    const searches = asked.filter((u) => u.includes("/search/"));
    expect(searches).toHaveLength(1);

    // A second registry over the same store: the facet rows are gone but `c.kv` is not,
    // which is the whole reason the crosswalk lives there instead of in the facet cache.
    store.db.run("delete from facet_contribution");
    asked = [];
    await resolve(GAME_OF_THRONES);
    expect(asked.filter((u) => u.includes("/search/"))).toHaveLength(0);
    expect(asked).toEqual(["https://skyhook.sonarr.tv/v1/tvdb/shows/en/121361"]);
  });

  /**
   * A call we never make is the politeness that matters most on Servarr's own
   * infrastructure. Core now hands the TVDB id down on `entity.ids` for most series, so
   * even the FIRST view of one costs a single call.
   */
  test("a tvdb id core already holds skips the search on the very first view", async () => {
    const { mine } = await resolve({ ...GAME_OF_THRONES, ids: { imdb: "tt0944947", tvdb: 121361 } });

    expect(asked).toEqual(["https://skyhook.sonarr.tv/v1/tvdb/shows/en/121361"]);
    expect(mine.data("seasons").length).toBeGreaterThan(0);
    // Not copied into kv: the crosswalk is rebuilt with the index, and a copy here would
    // outlive a correction to it with nothing able to revise it.
    expect(store.getKv(`plugin:servarr-metadata:tvdb:${GAME_OF_THRONES.tconst}`)).toBeNull();
  });
});

describe("what it costs them", () => {
  test("every facet a film has costs ONE call between them, not one each", async () => {
    await resolve(INCEPTION);

    expect(asked).toEqual(["https://api.radarr.video/v1/movie/imdb/tt1375666"]);
  });

  test("the second view of a title makes no outbound call at all", async () => {
    await resolve(INCEPTION);

    const registry = await load(mustNotBeCalled);
    const resolver = new FacetResolver({ store, registry, log: (m) => logs.push(m) });
    // `read` is the render path and never awaits a provider; `resolve` would ask any
    // provider still owing an answer, so a green `resolve` proves none of them do.
    const served = await resolver.resolve(INCEPTION, { deadlineMs: 5_000 });
    expect(served.cast?.data).toHaveLength(30);
    expect(served.ratings?.status).toBe("ready");
  });

  test("no key or token in any URL -- these proxies want none and we send none", async () => {
    await resolve(INCEPTION);
    await resolve(GAME_OF_THRONES);

    expect(asked.length).toBeGreaterThan(0);
    for (const url of asked) expect(url).not.toMatch(/apikey|api_key|token|Bearer/i);
  });
});

describe("when an upstream is unhelpful", () => {
  test("a title they have never heard of leaves empty facets, not failed ones", async () => {
    const unknown: FacetEntity = { ...INCEPTION, tconst: "tt9999999", title: "Nothing" };
    const { facets, mine } = await resolve(unknown);

    expect(mine.outcome("cast")).toBe("empty");
    expect(facets.cast).toEqual({ status: "empty" });
    expect(logs.some((l) => /failed/i.test(l))).toBe(false);
  });

  /**
   * The difference that matters: an empty answer caches for weeks, a failure for ten
   * minutes. A 502 during somebody's deploy must not blank a film's cast until next month.
   */
  test("a broken upstream fails the facets rather than emptying them", async () => {
    const { facets, mine } = await resolve(INCEPTION, alwaysFails);

    expect(mine.outcome("cast")).toBe("failed");
    expect(facets.cast).toEqual({ status: "failed" });

    const row = store.facetContributions("tt1375666").find((r) => r.facet === "cast");
    expect(row?.expires_at).not.toBeNull();
    const minutes = (Date.parse(row?.expires_at ?? "") - Date.now()) / 60_000;
    expect(minutes).toBeLessThan(60);
  });

  test("a series skyhook cannot cross-reference is empty, and the miss is not cached", async () => {
    const unknown: FacetEntity = { ...GAME_OF_THRONES, tconst: "tt9999999" };
    const { mine } = await resolve(unknown);

    expect(mine.outcome("seasons")).toBe("empty");
    // Nothing written to kv: a series they have not indexed yet may well be there next
    // month, and a permanently cached "no" would keep it invisible forever.
    expect(store.getKv(`plugin:${PLUGIN_ID}:tvdb:tt9999999`)).toBeNull();
  });
});

describe("collections", () => {
  /**
   * A film's own payload names its collection and always sends `Parts: null`, so members
   * can only come from the collection endpoint. That is the ONE extra call collections
   * cost, and only for a film that belongs to one.
   */
  test("the members arrive, each already carrying its own tconst", async () => {
    const { mine } = await resolve(MATRIX);

    const collection = mine.data("collection");
    expect(collection.id).toBe("tmdb:2344");
    expect(collection.name).toBe("The Matrix Collection");
    // Every part has an ImdbId upstream, which is why collections need no TMDB key and
    // no per-member id crosswalk.
    expect(collection.parts.every((p) => p.tconst !== null)).toBe(true);
  });

  test("the film itself is not in its own collection list", async () => {
    // The pane says "other movies in this collection", and a card linking to the page you
    // are already on is a dead end wearing a poster. Dropped in the FACET so any client
    // rendering the list gets the same honest answer.
    const { mine } = await resolve(MATRIX);
    expect(mine.data("collection").parts.map((p) => p.tconst)).toEqual([
      "tt0234215",
      "tt0242653",
      "tt10838180",
    ]);
  });

  test("a film with no collection costs no collection call at all", async () => {
    await resolve(INCEPTION);
    expect(asked.filter((u) => u.includes("/movie/collection/"))).toEqual([]);
  });

  test("the collection document is bought once, not once per facet", async () => {
    await resolve(MATRIX);
    expect(asked.filter((u) => u.includes("/movie/collection/2344"))).toHaveLength(1);
  });

  /**
   * A failure fetching members must not cost the other twelve facets: the collection
   * falls back to the name-only version the film's own payload already gave us.
   */
  test("a failed member fetch leaves the collection named but memberless", async () => {
    const onlyCollectionFails: PluginFetch = async (input) => {
      const url = String(input);
      if (url.includes("/movie/collection/")) {
        recordCall(url);
        return new Response("bad gateway", { status: 502 });
      }
      return fromFixtures(input);
    };

    const { mine } = await resolve(MATRIX, onlyCollectionFails);
    expect(mine.data("collection").name).toBe("The Matrix Collection");
    expect(mine.data("collection").parts).toEqual([]);
    // The rest of the payload is untouched.
    expect(mine.data("cast").length).toBeGreaterThan(0);
  });
});
