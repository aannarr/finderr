/**
 * The rotten-tomatoes plugin: the matcher on its own, then the plugin as the API drives it.
 *
 * Nothing here touches the network. `fetchImpl` is injected and serves Algolia responses
 * recorded live on 2026-08-30 into `rotten-tomatoes/fixtures/`, asked for with the same
 * `hitsPerPage` and `attributesToRetrieve` production uses, so a fixture is exactly what a
 * real search returns. Re-record them by re-running the same four queries.
 *
 * The matcher is the valuable half and the risky half, so it is tested twice over: once
 * factor by factor against real hits, and once end to end through `loadPlugins` and a real
 * `FacetResolver` over a real SQLite store.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadConfig } from "../lib/config";
import { FacetResolver } from "../lib/facet-resolver";
import type { FacetEntity, FacetName, FacetShapes } from "../lib/facets";
import type { PluginFetch } from "../lib/plugin-fetch";
import { BUILTIN_PLUGINS_DIR, loadPlugins } from "../lib/plugins";
import { Store } from "../lib/store";
import { RT_ALGOLIA_HOST, type RtHit } from "./rotten-tomatoes/algolia";
import {
  ALTERNATE_TITLE_FACTOR,
  bestMatch,
  INEXACT_TITLE_FACTOR,
  NO_SCORES_FACTOR,
  scoreHit,
} from "./rotten-tomatoes/match";

const PLUGIN_ID = "rotten-tomatoes";
const SEARCH_URL = `https://${RT_ALGOLIA_HOST}/1/indexes/*/queries`;

const INCEPTION: FacetEntity = {
  kind: "movie",
  tconst: "tt1375666",
  title: "Inception",
  originalTitle: "Inception",
  year: 2010,
  runtime: 148,
  ids: { imdb: "tt1375666" },
};

const THE_THING: FacetEntity = {
  ...INCEPTION,
  tconst: "tt0084787",
  title: "The Thing",
  originalTitle: "The Thing",
  year: 1982,
};

const BREAKING_BAD: FacetEntity = {
  kind: "series",
  tconst: "tt0903747",
  title: "Breaking Bad",
  originalTitle: "Breaking Bad",
  year: 2008,
  runtime: 49,
  ids: { imdb: "tt0903747" },
};

/** A title RT has an entry for but no scores on -- a different fact from "no entry". */
const BAKING_BAD: FacetEntity = {
  ...BREAKING_BAD,
  tconst: "tt9999998",
  title: "Baking Bad",
  originalTitle: "Baking Bad",
  year: 2019,
};

const OBSCURE: FacetEntity = {
  ...INCEPTION,
  tconst: "tt9999999",
  title: "Zqxjwvbn Nonexistent Picture",
  originalTitle: "Zqxjwvbn Nonexistent Picture",
  year: 1911,
};

/** The query the plugin sends -> the recorded answer to it. */
const FIXTURES: Record<string, string> = {
  Inception: "inception",
  Thing: "the-thing",
  "Breaking Bad": "breaking-bad",
  "Baking Bad": "breaking-bad",
  "Zqxjwvbn Nonexistent Picture": "no-such-film",
};

async function hitsFor(query: string): Promise<RtHit[]> {
  const name = FIXTURES[query];
  const url = new URL(`./rotten-tomatoes/fixtures/${name}.json`, import.meta.url);
  const body = (await Bun.file(url).json()) as { results: { hits: RtHit[] }[] };
  return body.results[0].hits;
}

/** The hit whose `title` is exactly this and whose year is exactly that. */
async function hitFor(query: string, title: string, releaseYear: number): Promise<RtHit> {
  const hits = await hitsFor(query);
  const found = hits.find((h) => h.title === title && h.releaseYear === releaseYear);
  if (!found) throw new Error(`no '${title}' (${releaseYear}) in the '${query}' fixture`);
  return found;
}

describe("the matcher", () => {
  test("the film we asked for wins, not the sequel that shares its name", async () => {
    // The runner-up is "Inception: The Cobol Job", whose `titles` literally contains
    // "Inception" -- an exact match on an alternate, which is what the discount is for.
    const winner = bestMatch(await hitsFor("Inception"), INCEPTION);

    expect(winner?.vanity).toBe("inception");
    expect(winner?.releaseYear).toBe(2010);
  });

  test("two 1982 films both match 'thing'; the exact title takes it", async () => {
    const winner = bestMatch(await hitsFor("Thing"), THE_THING);
    expect(winner?.vanity).toBe("1021244-thing");

    // "Swamp Thing" is the same year, so only the title separates them.
    const swamp = scoreHit(await hitFor("Thing", "Swamp Thing", 1982), THE_THING);
    expect(swamp.score).toBeLessThanOrEqual(INEXACT_TITLE_FACTOR);
    expect(swamp.score).toBeLessThan(scoreHit(await hitFor("Thing", "The Thing", 1982), THE_THING).score);
  });

  test("a year one off still matches, at a discount", async () => {
    const oneYearOut = { ...THE_THING, year: 1983 };
    const winner = bestMatch(await hitsFor("Thing"), oneYearOut);

    expect(winner?.vanity).toBe("1021244-thing");
    // 1 - 1 * PER_YEAR_PENALTY, on an otherwise perfect match.
    expect(scoreHit(await hitFor("Thing", "The Thing", 1982), oneYearOut).score).toBeCloseTo(0.6, 5);
  });

  /**
   * The gate is what makes this different from a score threshold. A two-year miss still
   * scores 0.2, comfortably over MINIMUM_SCORE, and is refused anyway -- because our year
   * is IMDb's and RT's is RT's, so a two-year gap is two independent sources disagreeing.
   */
  test("a winner more than one year out is refused outright, however well it scored", async () => {
    const twoYearsOut = { ...THE_THING, year: 1984 };

    expect(scoreHit(await hitFor("Thing", "The Thing", 1982), twoYearsOut).score).toBeCloseTo(0.2, 5);
    expect(bestMatch(await hitsFor("Thing"), twoYearsOut)).toBeNull();
  });

  test("with no year to check against, only an exact title is trusted", async () => {
    const undated = { ...THE_THING, year: null };
    expect(bestMatch(await hitsFor("Thing"), undated)?.vanity).toBe("1021244-thing");

    // Nothing in the Inception fixture is called "Inceptian", so every hit is inexact and
    // there is no year to rescue any of them.
    const misspelt = { ...INCEPTION, title: "Inceptian", originalTitle: "Inceptian", year: null };
    expect(bestMatch(await hitsFor("Inception"), misspelt)).toBeNull();
  });

  test("a foreign title matches through `aka`, worth less than the real one", async () => {
    // "Das Ding aus einer anderen Welt" is the 1982 film's German aka. Both of our names
    // are it, so the hit's own `title` has nothing to match and only the aka can score.
    const german = {
      ...THE_THING,
      title: "Das Ding aus einer anderen Welt",
      originalTitle: "Das Ding aus einer anderen Welt",
    };
    const scored = scoreHit(await hitFor("Thing", "The Thing", 1982), german);

    expect(scored.score).toBeCloseTo(ALTERNATE_TITLE_FACTOR, 5);
    expect(bestMatch(await hitsFor("Thing"), german)?.vanity).toBe("1021244-thing");
  });

  test("a hit carrying no scores is halved -- right film, wrong entry", async () => {
    const scored = scoreHit(await hitFor("Baking Bad", "Baking Bad", 2019), BAKING_BAD);

    expect(scored.hit.rottenTomatoes).toBeFalsy();
    expect(scored.titleScore).toBe(1);
    expect(scored.score).toBeCloseTo(NO_SCORES_FACTOR, 5);
  });

  /**
   * Algolia answers a nonsense query with twenty confident, irrelevant hits. Everything
   * downstream of the matcher depends on it saying no to all of them.
   */
  test("twenty irrelevant hits are all refused", async () => {
    expect(bestMatch(await hitsFor("Zqxjwvbn Nonexistent Picture"), OBSCURE)).toBeNull();
  });
});

describe("the plugin, driven as the API route drives it", () => {
  let dataDir: string;
  let store: Store;
  let logs: string[];
  /** Every RT request body the plugin sent, parsed -- the query assertions read this. */
  let asked: { query: string; params: string }[];
  /** Every URL any plugin asked for, RT's or not, so "one call per title" is checkable. */
  let askedUrls: string[];

  beforeEach(() => {
    dataDir = mkdtempSync(`${tmpdir()}/finderr-rt-test-`);
    process.env.FINDERR_DATA_DIR = dataDir;
    store = new Store(loadConfig(true));
    logs = [];
    asked = [];
    askedUrls = [];
  });

  afterEach(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
    process.env.FINDERR_DATA_DIR = undefined;
  });

  /**
   * Serves the recorded answers. Everything not addressed to RT is a 404, which is how
   * the other plugins in the directory are kept out of these assertions.
   */
  const fromFixtures: PluginFetch = async (input, init) => {
    askedUrls.push(String(input));
    if (String(input) !== SEARCH_URL) return new Response("not found", { status: 404 });

    const sent = JSON.parse(String(init?.body)) as { requests: { query: string; params: string }[] };
    const request = sent.requests[0];
    asked.push(request);
    const name = FIXTURES[request.query];
    if (!name) return new Response("not found", { status: 404 });
    return new Response(
      await Bun.file(new URL(`./rotten-tomatoes/fixtures/${name}.json`, import.meta.url)).text(),
      { headers: { "Content-Type": "application/json" } },
    );
  };

  const alwaysFails: PluginFetch = async () => new Response("bad gateway", { status: 502 });

  /**
   * Resolve one entity and hand back both views of the answer.
   *
   * `facets` is what `GET /api/title/:tconst` would serve, merged across every loaded
   * plugin; `mine` is this plugin's own rows out of SQLite, so a sibling also providing
   * `ratings` cannot make a mapping assertion fail for a reason unrelated to RT.
   */
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

  test("a film gets both scores, each linked to its RT page", async () => {
    const { facets, mine } = await resolve(INCEPTION);

    expect(mine.data("ratings")).toEqual([
      {
        source: "RottenTomatoes",
        kind: "critics",
        value: 86,
        outOf: 100,
        url: "https://www.rottentomatoes.com/m/inception",
      },
      {
        source: "RottenTomatoes",
        kind: "audience",
        value: 91,
        outOf: 100,
        url: "https://www.rottentomatoes.com/m/inception",
      },
    ]);
    // Merged with whatever else provides `ratings`, which is the whole point of the facet
    // being a list: RT's audience score lands beside Servarr's IMDb and Metacritic ones.
    expect(facets.ratings?.status).toBe("ready");
  });

  test("`source` is the string the Tomatometer already arrives under", async () => {
    const { facets } = await resolve(INCEPTION);

    // servarr-metadata relays RT's critics score from `api.radarr.video` under exactly
    // this spelling. Two entries, one label -- the ratings row dedupes on `source|kind`,
    // and a lowercase `rottentomatoes` would print beside `Metacritic` as its own tile.
    const rt = (facets.ratings?.data ?? []).filter((r) => r.source === "RottenTomatoes");
    expect(rt.map((r) => r.kind).sort()).toEqual(["audience", "critics"]);
  });

  test("a series is searched as a series, and gets both scores", async () => {
    const { mine } = await resolve(BREAKING_BAD);

    expect(new URLSearchParams(asked[0]?.params).get("filters")).toBe('isEmsSearchable=1 AND type:"tv"');
    expect(mine.data("ratings")).toEqual([
      {
        source: "RottenTomatoes",
        kind: "critics",
        value: 96,
        outOf: 100,
        url: "https://www.rottentomatoes.com/tv/breaking_bad",
      },
      {
        source: "RottenTomatoes",
        kind: "audience",
        value: 97,
        outOf: 100,
        url: "https://www.rottentomatoes.com/tv/breaking_bad",
      },
    ]);
  });

  test("a leading article is stripped from the query, because the index ranks better without it", async () => {
    await resolve(THE_THING);

    expect(asked.map((a) => a.query)).toEqual(["Thing"]);
  });

  test("a title RT has never heard of gets no entries and no error", async () => {
    const { facets, mine } = await resolve(OBSCURE);

    expect(mine.outcome("ratings")).toBe("empty");
    expect(facets.ratings?.data ?? []).not.toContainEqual(
      expect.objectContaining({ source: "RottenTomatoes" }),
    );
    expect(logs.some((l) => /rotten-tomatoes.*failed/i.test(l))).toBe(false);
  });

  test("a title RT holds but has no scores for is empty too, not a wrong number", async () => {
    const { mine } = await resolve(BAKING_BAD);

    expect(mine.outcome("ratings")).toBe("empty");
  });

  /**
   * The difference that decides how long a wrong answer sticks around: an empty answer
   * caches for weeks and a failure for ten minutes. RT having a bad hour must not blank
   * a film's scores until next month.
   */
  test("a broken upstream fails the facet rather than emptying it", async () => {
    const { mine } = await resolve(INCEPTION, alwaysFails);

    expect(mine.outcome("ratings")).toBe("failed");
  });

  test("the fuzzy match is bought once per title, ever", async () => {
    await resolve(INCEPTION);
    expect(store.getKv(`plugin:${PLUGIN_ID}:hit:tt1375666`)).toBe(
      JSON.stringify({ emsId: "afbf1c81-1bfe-3996-9cbc-2e1be23d1f61", vanity: "inception" }),
    );

    // The facet rows are gone but `c.kv` is not, which is the whole reason the identity
    // lives there. The year is then moved far enough that the matcher would refuse every
    // hit -- so scores coming back at all proves the matcher never ran a second time.
    store.db.run("delete from facet_contribution");
    const refreshed = await resolve({ ...INCEPTION, year: 1950 });

    expect(refreshed.mine.data("ratings")[0]).toMatchObject({ value: 86, kind: "critics" });
  });

  test("a match RT no longer lists goes quiet rather than being re-guessed", async () => {
    await resolve(INCEPTION);
    store.db.run("delete from facet_contribution");

    // The recorded answer to "Baking Bad" has no Inception in it, so the remembered id is
    // not there. Re-matching against those hits could only ever attach the wrong film.
    const { mine } = await resolve({ ...INCEPTION, title: "Baking Bad" });
    expect(mine.outcome("ratings")).toBe("empty");
  });

  test("one search per title, with the credentials in headers rather than the URL", async () => {
    await resolve(INCEPTION);
    await resolve(BREAKING_BAD);

    const searches = askedUrls.filter((url) => new URL(url).hostname === RT_ALGOLIA_HOST);
    expect(searches).toHaveLength(2);
    // Algolia accepts its key as a query parameter too, which would put it in every log
    // line and every proxy's history. These calls carry it as a header.
    for (const url of searches) expect(url).not.toMatch(/key|token/i);
  });
});
