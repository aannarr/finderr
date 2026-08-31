import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadConfig } from "./config";
import { posterFrom, Store, searchOnAddOf, studioFrom } from "./store";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(`${tmpdir()}/finderr-test-`);
  process.env.FINDERR_DATA_DIR = dir;
  store = new Store(loadConfig(true));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  process.env.FINDERR_DATA_DIR = undefined;
});

describe("artwork cache", () => {
  /**
   * The regression that motivated this file.
   *
   * bun:sqlite's `.get()` returns NULL for a missing row, not undefined. Callers
   * distinguish "never looked" (undefined) from "looked, no poster" (row with a
   * null url), so a raw null leaking out makes `cached !== undefined` pass and then
   * throw on `cached.url`. Every unowned title silently counted as having no art.
   */
  test("an unknown title reads as undefined, never null", () => {
    const got = store.getArtwork("tt0000000");
    expect(got).toBeUndefined();
    // The exact shape the bug turned on:
    expect(got !== undefined).toBe(false);
  });

  test("a resolved poster round-trips", () => {
    store.setArtwork("tt0111161", "https://image.tmdb.org/t/p/original/x.jpg");
    expect(store.getArtwork("tt0111161")).toEqual({
      url: "https://image.tmdb.org/t/p/original/x.jpg",
      studio: null,
    });
  });

  test("a known-absent poster is distinguishable from never-looked", () => {
    store.setArtwork("tt0000001", null);
    const looked = store.getArtwork("tt0000001");
    expect(looked).toEqual({ url: null, studio: null });
    expect(looked).not.toBeUndefined();
    expect(store.getArtwork("tt0000002")).toBeUndefined();
  });

  test("setArtwork overwrites, seedArtwork does not", () => {
    store.setArtwork("tt1", "https://image.tmdb.org/a.jpg");
    store.seedArtwork([{ imdb_id: "tt1", url: "https://image.tmdb.org/b.jpg" }]);
    // Seeding fills gaps only -- it must never clobber a resolved value.
    expect(store.getArtwork("tt1")?.url).toBe("https://image.tmdb.org/a.jpg");

    store.setArtwork("tt1", "https://image.tmdb.org/c.jpg");
    expect(store.getArtwork("tt1")?.url).toBe("https://image.tmdb.org/c.jpg");
  });

  test("seedArtwork skips rows with no id or no url", () => {
    const n = store.seedArtwork([
      { imdb_id: "", url: "https://image.tmdb.org/a.jpg" },
      { imdb_id: "tt2", url: null },
      { imdb_id: "tt3", url: "https://image.tmdb.org/d.jpg" },
    ]);
    expect(n).toBe(1);
    expect(store.getArtwork("tt2")).toBeUndefined();
    expect(store.getArtwork("tt3")).toEqual({
      url: "https://image.tmdb.org/d.jpg",
      studio: null,
    });
  });

  /**
   * The studio is learned from whichever call answers first, and the two fields do
   * not always arrive together -- a poster-only answer must not erase a studio the
   * library sync already recorded, and vice versa.
   */
  test("studio is coalesced, never clobbered by a later null", () => {
    store.setArtwork("tt10", "https://image.tmdb.org/a.jpg", "HBO");
    expect(store.getArtwork("tt10")).toEqual({ url: "https://image.tmdb.org/a.jpg", studio: "HBO" });

    // A later resolve that found a poster but no studio keeps the known one.
    store.setArtwork("tt10", "https://image.tmdb.org/b.jpg", null);
    expect(store.getArtwork("tt10")).toEqual({ url: "https://image.tmdb.org/b.jpg", studio: "HBO" });

    // An explicit new value does replace it.
    store.setArtwork("tt10", "https://image.tmdb.org/b.jpg", "FX");
    expect(store.getArtwork("tt10")?.studio).toBe("FX");
  });

  /** Seeding is the cheapest place to learn a studio for an owned title. */
  test("seedArtwork fills a missing studio on a row it will not otherwise touch", () => {
    store.setArtwork("tt11", "https://image.tmdb.org/a.jpg");
    expect(store.getArtwork("tt11")?.studio).toBeNull();

    store.seedArtwork([{ imdb_id: "tt11", url: "https://image.tmdb.org/z.jpg", studio: "AMC" }]);
    const row = store.getArtwork("tt11");
    // The url is still the resolved one -- seeding never clobbers that.
    expect(row?.url).toBe("https://image.tmdb.org/a.jpg");
    expect(row?.studio).toBe("AMC");
  });

  test("counts separate resolved from known-absent", () => {
    store.setArtwork("tt1", "https://image.tmdb.org/a.jpg");
    store.setArtwork("tt2", null);
    store.setArtwork("tt3", "https://image.tmdb.org/b.jpg");
    expect(store.artworkCount()).toEqual({ resolved: 2, missing: 1 });
  });
});

describe("facet cache, read by content", () => {
  const contribution = (entity: string, facet: string, data: unknown, extra = {}) => ({
    reason: null,
    entity_id: entity,
    facet,
    plugin_id: "servarr-metadata",
    config_version: "1",
    outcome: "ok" as const,
    data: JSON.stringify(data),
    freshness: "immutable",
    resolved_at: "2026-08-31T00:00:00.000Z",
    expires_at: null,
    ...extra,
  });

  test("finds every title carrying one collection, and no other facet", () => {
    store.putFacetContribution(contribution("tt1", "collection", { id: "tmdb:2344", name: "Matrix" }));
    store.putFacetContribution(contribution("tt2", "collection", { id: "tmdb:2344", name: "Matrix" }));
    store.putFacetContribution(contribution("tt3", "collection", { id: "tmdb:119", name: "LOTR" }));
    // Same `id` field, different facet -- it must not be mistaken for a collection.
    store.putFacetContribution(contribution("tt4", "keywords", { id: "tmdb:2344" }));

    const rows = store.facetContributionsByContentId("collection", "tmdb:2344");
    expect(rows.map((r) => r.entity_id).sort()).toEqual(["tt1", "tt2"]);
    expect(store.facetContributionsByContentId("collection")).toHaveLength(3);
  });

  /** A payload we could not fetch has no id to match on, and no name to offer. */
  test("only `ok` rows come back", () => {
    store.putFacetContribution({
      ...contribution("tt5", "collection", null),
      outcome: "failed",
      data: null,
    });
    expect(store.facetContributionsByContentId("collection")).toEqual([]);
  });

  test("an expired row is gone, on both the narrowed and the whole read", () => {
    store.putFacetContribution(
      contribution("tt6", "collection", { id: "tmdb:1" }, { expires_at: "2026-08-30T00:00:00.000Z" }),
    );
    const now = "2026-08-31T00:00:00.000Z";
    expect(store.facetContributionsByContentId("collection", "tmdb:1", now)).toEqual([]);
    expect(store.facetContributionsByContentId("collection", undefined, now)).toEqual([]);
  });
});

describe("posterFrom", () => {
  test("picks the poster, ignoring fanart and banners", () => {
    expect(
      posterFrom([
        { coverType: "fanart", remoteUrl: "https://x/fan.jpg" },
        { coverType: "poster", remoteUrl: "https://x/poster.jpg" },
        { coverType: "banner", remoteUrl: "https://x/banner.jpg" },
      ]),
    ).toBe("https://x/poster.jpg");
  });

  test("falls back to url when remoteUrl is absent", () => {
    expect(posterFrom([{ coverType: "poster", url: "https://x/p.jpg" }])).toBe("https://x/p.jpg");
  });

  test("returns null for junk input rather than throwing", () => {
    expect(posterFrom(undefined)).toBeNull();
    expect(posterFrom(null)).toBeNull();
    expect(posterFrom([])).toBeNull();
    expect(posterFrom("nonsense")).toBeNull();
    expect(posterFrom([{ coverType: "fanart", remoteUrl: "https://x/f.jpg" }])).toBeNull();
  });
});

describe("library mirror", () => {
  test("replace drops rows that disappeared upstream", () => {
    store.replaceLibrary("radarr", [
      { imdb_id: "tt1", arr_id: 1, has_file: 1, monitored: 1, progress: 1 },
      { imdb_id: "tt2", arr_id: 2, has_file: 0, monitored: 1, progress: 0 },
    ]);
    expect(store.libraryMap().size).toBe(2);

    // tt2 removed in Radarr -- a plain upsert would leave it behind forever.
    store.replaceLibrary("radarr", [{ imdb_id: "tt1", arr_id: 1, has_file: 1, monitored: 1, progress: 1 }]);
    expect(store.libraryMap().size).toBe(1);
    expect(store.libraryMap().has("tt2")).toBe(false);
  });

  test("titles with no imdb id are skipped, not stored blank", () => {
    const n = store.replaceLibrary("sonarr", [
      { imdb_id: "", arr_id: 9, has_file: 1, monitored: 1, progress: 1 },
      { imdb_id: "tt5", arr_id: 5, has_file: 1, monitored: 1, progress: 1 },
    ]);
    expect(n).toBe(1);
  });

  test("services are mirrored independently", () => {
    store.replaceLibrary("radarr", [{ imdb_id: "tt1", arr_id: 1, has_file: 1, monitored: 1, progress: 1 }]);
    store.replaceLibrary("sonarr", [{ imdb_id: "tt2", arr_id: 2, has_file: 1, monitored: 1, progress: 0.5 }]);
    expect(store.libraryCount()).toEqual({ radarr: 1, sonarr: 1, episodes: 0 });

    // Re-syncing one service must not wipe the other.
    store.replaceLibrary("radarr", []);
    expect(store.libraryCount()).toEqual({ radarr: 0, sonarr: 1, episodes: 0 });
  });

  test("title_slug is mirrored as sent, and absent when the arr did not send one", () => {
    store.replaceLibrary("radarr", [
      // Radarr 6.x puts the tmdbId in titleSlug; Sonarr puts a word slug. Neither is
      // derivable from anything else we hold, which is the whole reason for the column.
      { imdb_id: "tt1", arr_id: 1, has_file: 1, monitored: 1, progress: 1, title_slug: "700391" },
    ]);
    store.replaceLibrary("sonarr", [
      { imdb_id: "tt2", arr_id: 2, has_file: 1, monitored: 1, progress: 1, title_slug: "preacher" },
      { imdb_id: "tt3", arr_id: 3, has_file: 0, monitored: 1, progress: 0 },
    ]);

    const lib = store.libraryMap();
    expect(lib.get("tt1")?.title_slug).toBe("700391");
    expect(lib.get("tt2")?.title_slug).toBe("preacher");
    expect(lib.get("tt3")?.title_slug).toBeNull();
  });
});

describe("episode mirror", () => {
  test("replace is scoped to ONE series -- another series keeps its rows", () => {
    store.replaceEpisodes("tt1", [
      { season: 1, episode: 1, arr_episode_id: 11, has_file: 1, monitored: 1, air_date: "2025-05-28" },
      { season: 1, episode: 2, arr_episode_id: 12, has_file: 0, monitored: 1, air_date: "2025-05-28" },
    ]);
    store.replaceEpisodes("tt2", [
      { season: 1, episode: 1, arr_episode_id: 21, has_file: 0, monitored: 0, air_date: null },
    ]);

    // A failed walk for tt1 must not be able to empty tt2, which is why the swap is
    // per-series rather than wholesale.
    expect(store.replaceEpisodes("tt1", [])).toBe(0);
    expect(store.episodeMap("tt2").size).toBe(1);
  });

  test("an episode Sonarr stopped listing stops claiming we hold it", () => {
    store.replaceEpisodes("tt1", [
      { season: 1, episode: 1, arr_episode_id: 11, has_file: 1, monitored: 1, air_date: "2025-05-28" },
      { season: 1, episode: 2, arr_episode_id: 12, has_file: 1, monitored: 1, air_date: "2025-06-04" },
    ]);
    store.replaceEpisodes("tt1", [
      { season: 1, episode: 1, arr_episode_id: 11, has_file: 1, monitored: 1, air_date: "2025-05-28" },
    ]);
    expect(store.getEpisode("tt1", 1, 2)).toBeNull();
    expect(store.getEpisode("tt1", 1, 1)?.has_file).toBe(1);
  });

  test("markEpisodesMonitored touches only the named episodes of the named series", () => {
    store.replaceEpisodes("tt1", [
      { season: 1, episode: 1, arr_episode_id: 11, has_file: 0, monitored: 0, air_date: "2025-05-28" },
      { season: 1, episode: 2, arr_episode_id: 12, has_file: 0, monitored: 0, air_date: "2025-06-04" },
    ]);
    store.replaceEpisodes("tt2", [
      { season: 1, episode: 1, arr_episode_id: 21, has_file: 0, monitored: 0, air_date: null },
    ]);

    store.markEpisodesMonitored("tt1", [11]);
    expect(store.getEpisode("tt1", 1, 1)?.monitored).toBe(1);
    expect(store.getEpisode("tt1", 1, 2)?.monitored).toBe(0);
    // The id space is Sonarr's and is global, so the series has to be part of the WHERE
    // or one show's request could re-monitor another's episode.
    expect(store.getEpisode("tt2", 1, 1)?.monitored).toBe(0);
  });
});

describe("studioFrom", () => {
  /** Sonarr's field. */
  test("reads network off a series lookup", () => {
    expect(studioFrom({ title: "Game of Thrones", network: "HBO" })).toBe("HBO");
  });

  /** Radarr's field. */
  test("reads studio off a movie lookup", () => {
    expect(studioFrom({ title: "The Shawshank Redemption", studio: "Castle Rock Entertainment" })).toBe(
      "Castle Rock Entertainment",
    );
  });

  /**
   * A title can come back from EITHER service regardless of what IMDb calls it -- a
   * tvMovie may only exist in Radarr. Reading whichever field is present avoids
   * branching on a kind that is not authoritative.
   */
  test("prefers network when both are somehow present", () => {
    expect(studioFrom({ network: "FX", studio: "20th Television" })).toBe("FX");
  });

  test("blank and whitespace-only names are null, not empty strings", () => {
    expect(studioFrom({ network: "" })).toBeNull();
    expect(studioFrom({ studio: "   " })).toBeNull();
    expect(studioFrom({ title: "no studio field" })).toBeNull();
  });

  test("survives the shapes a failed lookup produces", () => {
    expect(studioFrom(null)).toBeNull();
    expect(studioFrom(undefined)).toBeNull();
    expect(studioFrom("not an object")).toBeNull();
    expect(studioFrom({ network: 123 })).toBeNull();
  });

  test("trims -- the value is used to build a filename slug", () => {
    expect(studioFrom({ studio: "  A24  " })).toBe("A24");
  });
});

/**
 * The garbage the version stamp created and nothing removed.
 *
 * `config_version` is part of `facet_contribution`'s primary key precisely so a changed
 * plugin cannot serve its old answers -- and that half works: `isLiveContribution` filters
 * the superseded rows out of every read. What never existed is the other half. The rows
 * stay on disk forever, one full generation of the working set per plugin edit, and
 * `ix_facet_entity` indexes `entity_id` alone, so every lookup for a title walks its dead
 * versions too. Measured on the live container: 10,647 rows across seven generations of two
 * plugins, doubled from 5,433 in about twelve hours, ~86% of it unreachable.
 */
describe("pruning superseded facet contributions", () => {
  const row = (pluginId: string, version: string, entityId = "tt0111161") => ({
    reason: null,
    entity_id: entityId,
    facet: "ratings",
    plugin_id: pluginId,
    config_version: version,
    outcome: "ok" as const,
    data: '[{"source":"Imdb","value":9.3}]',
    freshness: "moving",
    resolved_at: "2026-08-31T00:00:00.000Z",
    expires_at: null,
  });

  test("deletes every version of a plugin except the one it is running", () => {
    store.putFacetContribution(row("servarr-metadata", "dead-1"));
    store.putFacetContribution(row("servarr-metadata", "dead-2", "tt0068646"));
    store.putFacetContribution(row("servarr-metadata", "live"));
    store.putFacetContribution(row("servarr-metadata", "live", "tt0068646"));

    expect(store.facetCacheCount()).toBe(4);
    expect(store.pruneFacetContributions(new Map([["servarr-metadata", "live"]]))).toBe(2);
    expect(store.facetCacheCount()).toBe(2);

    const left = store.facetContributionsByContentId("ratings");
    expect(left.every((r) => r.config_version === "live")).toBe(true);
  });

  /**
   * The requirement that decides the whole shape of this. A plugin whose file is broken, or
   * whose upstream import throws, does not register -- and is indistinguishable from a
   * plugin somebody deleted. Reaping on "not in the registry" would therefore destroy a
   * working cache on the one boot where a plugin happens to be broken, which is exactly the
   * boot you least want to also lose the data.
   *
   * So the prune is driven by what the registry KNOWS, never by what it lacks: a plugin
   * absent from the map is not pruned at all, at either version.
   */
  test("a plugin missing from the registry keeps every row it has", () => {
    store.putFacetContribution(row("rotten-tomatoes", "v1"));
    store.putFacetContribution(row("rotten-tomatoes", "v2", "tt0068646"));

    // servarr-metadata loaded; rotten-tomatoes did not (broken file, or deleted).
    expect(store.pruneFacetContributions(new Map([["servarr-metadata", "live"]]))).toBe(0);
    expect(store.facetCacheCount()).toBe(2);
  });

  test("an empty registry prunes nothing at all", () => {
    store.putFacetContribution(row("servarr-metadata", "v1"));
    // Every plugin failed to load. The correct number of rows to delete is zero.
    expect(store.pruneFacetContributions(new Map())).toBe(0);
    expect(store.facetCacheCount()).toBe(1);
  });

  test("prunes each plugin against its own version, not against a shared one", () => {
    store.putFacetContribution(row("servarr-metadata", "s-old"));
    store.putFacetContribution(row("servarr-metadata", "s-new"));
    store.putFacetContribution(row("rotten-tomatoes", "r-old"));
    store.putFacetContribution(row("rotten-tomatoes", "r-new"));

    const pruned = store.pruneFacetContributions(
      new Map([
        ["servarr-metadata", "s-new"],
        ["rotten-tomatoes", "r-new"],
      ]),
    );
    expect(pruned).toBe(2);
    expect(store.facetCacheCount()).toBe(2);
  });

  test("is idempotent -- a second sweep finds nothing", () => {
    store.putFacetContribution(row("servarr-metadata", "dead"));
    store.putFacetContribution(row("servarr-metadata", "live"));

    const current = new Map([["servarr-metadata", "live"]]);
    expect(store.pruneFacetContributions(current)).toBe(1);
    expect(store.pruneFacetContributions(current)).toBe(0);
  });

  /**
   * `outcome` is irrelevant to whether a row is stranded. An `empty` or `failed` row from a
   * superseded version is just as unreachable as an `ok` one, and leaving those behind would
   * keep the table growing on exactly the titles a provider keeps failing on.
   */
  test("prunes empty and failed rows too, not just ok ones", () => {
    store.putFacetContribution({ ...row("servarr-metadata", "dead"), outcome: "empty", data: null });
    store.putFacetContribution({
      ...row("servarr-metadata", "dead", "tt0068646"),
      outcome: "failed",
      data: null,
    });
    store.putFacetContribution(row("servarr-metadata", "live"));

    expect(store.pruneFacetContributions(new Map([["servarr-metadata", "live"]]))).toBe(2);
  });
});

describe("request seasons", () => {
  const series = {
    tconst: "tt0944947",
    title: "Game of Thrones",
    year: 2011,
    kind: "tvSeries",
    service: "sonarr" as const,
  };

  test("a request with no selection stores null, not an empty string", () => {
    // null is what the worker reads as "all". An empty string would decode the same
    // way today but is a second spelling of one state, and those drift.
    expect(store.createRequest(series).seasons).toBeNull();
  });

  test("a selection round-trips through the column", () => {
    expect(store.createRequest({ ...series, seasons: [3, 1, 2] }).seasons).toBe("1,2,3");
  });

  test("season 0 survives -- it is the specials, not a falsy nothing", () => {
    expect(store.createRequest({ ...series, seasons: [0] }).seasons).toBe("0");
  });

  /**
   * The bug this pins: `createRequest` upserts on `tconst`, so re-requesting a title
   * hits the conflict arm. If that arm does not rewrite `seasons`, the reader's second
   * choice is accepted by the UI, returned as 202, and then silently discarded.
   */
  test("re-requesting with a different selection moves the stored one", () => {
    store.createRequest({ ...series, seasons: [1] });
    expect(store.createRequest({ ...series, seasons: [1, 2] }).seasons).toBe("1,2");
  });

  test("re-requesting with no selection clears a previous one back to 'all'", () => {
    store.createRequest({ ...series, seasons: [1] });
    expect(store.createRequest(series).seasons).toBeNull();
  });
});

describe("request arr overrides", () => {
  const film = {
    tconst: "tt0111161",
    title: "The Shawshank Redemption",
    year: 1994,
    kind: "movie",
    service: "radarr" as const,
  };

  test("an ordinary request stores null in all three -- the pre-existing behaviour", () => {
    const r = store.createRequest(film);
    expect(r.quality_profile_id).toBeNull();
    expect(r.root_folder_path).toBeNull();
    expect(r.search_on_add).toBeNull();
    // Null is what the worker turns into "field absent", which is what makes both arr
    // clients fall through to the configured service default.
    expect(searchOnAddOf(r)).toBeUndefined();
  });

  test("all three round-trip", () => {
    const r = store.createRequest({
      ...film,
      overrides: { qualityProfileId: 7, rootFolderPath: "/media/movies-4k", searchOnAdd: false },
    });
    expect(r.quality_profile_id).toBe(7);
    expect(r.root_folder_path).toBe("/media/movies-4k");
    expect(searchOnAddOf(r)).toBe(false);
  });

  test("searchOnAdd true and unset are stored apart, though the arr treats them alike", () => {
    // "Nobody chose" and "somebody chose yes" are different facts about the request, and
    // only the first may be re-decided by a config change later.
    expect(store.createRequest({ ...film, overrides: { searchOnAdd: true } }).search_on_add).toBe(1);
    expect(store.createRequest({ ...film, overrides: {} }).search_on_add).toBeNull();
  });

  /**
   * Same shape as the seasons bug above and the same fix: `createRequest` upserts on
   * `tconst`, so an admin re-requesting with a different profile hits the conflict arm. An
   * arm that does not rewrite these accepts the change, returns 202, and downloads at the
   * old profile.
   */
  test("re-requesting with different overrides moves the stored ones", () => {
    store.createRequest({ ...film, overrides: { qualityProfileId: 4, rootFolderPath: "/media/movies" } });
    const second = store.createRequest({
      ...film,
      overrides: { qualityProfileId: 7, rootFolderPath: "/media/movies-4k" },
    });
    expect(second.quality_profile_id).toBe(7);
    expect(second.root_folder_path).toBe("/media/movies-4k");
  });

  test("re-requesting with none clears previous overrides back to the service default", () => {
    store.createRequest({ ...film, overrides: { qualityProfileId: 7 } });
    expect(store.createRequest(film).quality_profile_id).toBeNull();
  });

  test("but re-requesting never rewrites requested_by -- the first asker keeps the credit", () => {
    // The asymmetry with the overrides above is deliberate: attribution records something
    // that already happened, an override is an instruction for work not yet done.
    store.createRequest({ ...film, requestedBy: "u1" });
    const second = store.createRequest({ ...film, requestedBy: "u2", overrides: { qualityProfileId: 7 } });
    expect(second.requested_by).toBe("u1");
    expect(second.quality_profile_id).toBe(7);
  });
});

/**
 * The upgrade path, which is the one that runs against the live container -- it already
 * holds request rows written before this column existed. A fresh database gets `seasons`
 * from SCHEMA; an existing one only gets it from ADDED_COLUMNS, and nothing else in the
 * suite would notice that entry being missing.
 */
describe("migrating a database written before request.seasons", () => {
  test("adds the column and leaves existing rows reading as 'all'", () => {
    const old = mkdtempSync(`${tmpdir()}/finderr-old-`);
    const db = new Database(`${old}/finderr.db`, { create: true });
    db.run(`create table request (
      id integer primary key autoincrement,
      tconst text not null, title text not null, year integer, kind text not null,
      service text not null, status text not null, arr_id integer, error text,
      search_attempts integer not null default 0,
      created_at text not null, updated_at text not null
    );
    create unique index ix_request_tconst on request(tconst);`);
    db.run(
      "insert into request (tconst,title,year,kind,service,status,created_at,updated_at) values (?,?,?,?,?,?,?,?)",
      ["tt0944947", "Game of Thrones", 2011, "tvSeries", "sonarr", "sent", "then", "then"],
    );
    db.close();

    process.env.FINDERR_DATA_DIR = old;
    const upgraded = new Store(loadConfig(true));
    try {
      // Not a crash, and not a lost row: the pre-existing request survives and reads as
      // "all seasons", which is exactly what it meant when it was written.
      expect(upgraded.getRequest("tt0944947")?.seasons).toBeNull();
      expect(
        upgraded.createRequest({
          tconst: "tt1520211",
          title: "The Walking Dead",
          year: 2010,
          kind: "tvSeries",
          service: "sonarr",
          seasons: [1],
        }).seasons,
      ).toBe("1");
    } finally {
      upgraded.close();
      rmSync(old, { recursive: true, force: true });
      process.env.FINDERR_DATA_DIR = dir;
    }
  });
});
