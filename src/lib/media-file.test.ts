/**
 * The playback mirror: the file behind a title, and what is inside it.
 *
 * Two halves. The projection is pure and gets the hostile-shape cases; the walk half proves
 * the thing that actually makes this affordable -- **both arrs hand the file over on a call
 * finderr was already making**, so a wrong query string here is a per-series regression that
 * no unit test on the projection could ever see.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { RadarrClient, SonarrClient } from "./arr";
import { type ArrService, loadConfig } from "./config";
import { mediaFileRow, NOT_AN_EPISODE } from "./media-file";
import { Store, syncEpisodes, syncLibrary } from "./store";

const MEDIA_INFO = {
  videoCodec: "x265",
  videoBitDepth: 10,
  videoDynamicRange: "HDR",
  audioCodec: "EAC3",
  audioChannels: 5.1,
  audioLanguages: "eng",
  subtitles: "eng",
  resolution: "3840x1604",
  runTime: "1:32:49",
};

describe("mediaFileRow flattens either arr's file record", () => {
  test("a film keys on the NOT_AN_EPISODE sentinel", () => {
    const row = mediaFileRow("tt12261776", "radarr", {
      id: 7,
      path: "/plex/movie/65 (2023)/65.mkv",
      size: 3513248611,
      mediaInfo: MEDIA_INFO,
    });
    expect(row).toEqual({
      imdb_id: "tt12261776",
      season: NOT_AN_EPISODE,
      episode: NOT_AN_EPISODE,
      service: "radarr",
      arr_file_id: 7,
      path: "/plex/movie/65 (2023)/65.mkv",
      size: 3513248611,
      video_codec: "x265",
      video_depth: 10,
      video_range: "HDR",
      audio_codec: "EAC3",
      audio_channels: 5.1,
      audio_langs: "eng",
      subtitle_langs: "eng",
      resolution: "3840x1604",
      runtime: "1:32:49",
    });
  });

  test("an episode keys on its season and number", () => {
    const row = mediaFileRow(
      "tt4269552",
      "sonarr",
      { id: 3494, path: "/plex/tv/s06e01.mkv" },
      { season: 6, episode: 1 },
    );
    expect(row).toMatchObject({ season: 6, episode: 1, service: "sonarr", arr_file_id: 3494 });
  });

  /**
   * SEASON 0 IS THE SPECIALS and exists on every series, which is the whole reason the
   * sentinel is -1 rather than the 0 anybody would reach for first.
   */
  test("season 0 is a real season and is not confused with a film", () => {
    const special = mediaFileRow(
      "tt0944947",
      "sonarr",
      { id: 1, path: "/plex/tv/s00e01.mkv" },
      { season: 0, episode: 1 },
    );
    expect(special?.season).toBe(0);
    expect(special?.season).not.toBe(NOT_AN_EPISODE);
  });

  /**
   * The one hard requirement. Everything else being optional is what stops an unscanned
   * import -- a real state both arrs produce -- becoming an unplayable file.
   */
  test("no path means no row", () => {
    expect(mediaFileRow("tt1", "radarr", { id: 1 })).toBeNull();
    expect(mediaFileRow("tt1", "radarr", { id: 1, path: "" })).toBeNull();
    expect(mediaFileRow("tt1", "radarr", { id: 1, path: "   " })).toBeNull();
    expect(mediaFileRow("tt1", "radarr", undefined)).toBeNull();
    expect(mediaFileRow("tt1", "radarr", null)).toBeNull();
  });

  test("no imdb id means no row, because nothing could ever look it up", () => {
    expect(mediaFileRow("", "radarr", { id: 1, path: "/plex/a.mkv" })).toBeNull();
  });

  test("a file with no mediaInfo keeps its path and nulls the rest", () => {
    const row = mediaFileRow("tt1", "radarr", { id: 1, path: "/plex/a.mkv" });
    expect(row).toMatchObject({ path: "/plex/a.mkv", video_codec: null, audio_codec: null, size: null });
  });

  test("blank upstream strings become null rather than empty values a reader must handle", () => {
    const row = mediaFileRow("tt1", "radarr", {
      id: 1,
      path: "/plex/a.mkv",
      mediaInfo: { videoCodec: "  ", audioCodec: "", resolution: "1920x1080" },
    });
    expect(row).toMatchObject({ video_codec: null, audio_codec: null, resolution: "1920x1080" });
  });
});

// --- the walk half -------------------------------------------------------------------

const RADARR: ArrService = {
  url: "http://radarr.test:7878",
  apiKey: "k",
  rootFolder: "/m",
  qualityProfileId: 4,
};
const SONARR: ArrService = {
  url: "http://sonarr.test:8989",
  apiKey: "k",
  rootFolder: "/t",
  qualityProfileId: 4,
};
const WALK_EVERYTHING = { batch: 100, staleSeconds: -1 };

const MOVIES = [
  {
    id: 11,
    title: "65",
    year: 2023,
    tmdbId: 700391,
    imdbId: "tt12261776",
    hasFile: true,
    monitored: true,
    movieFile: { id: 7, path: "/plex/movie/65 (2023)/65.mkv", size: 3513248611, mediaInfo: MEDIA_INFO },
  },
  // Not downloaded: no file block at all, which is exactly what Radarr sends.
  { id: 12, title: "Wanted", year: 2024, tmdbId: 1, imdbId: "tt2222222", hasFile: false, monitored: true },
];

const SERIES = [
  {
    id: 21,
    title: "Billions",
    year: 2016,
    tvdbId: 279536,
    imdbId: "tt4269552",
    monitored: true,
    statistics: { episodeFileCount: 1, episodeCount: 2, percentOfEpisodes: 50 },
  },
  {
    id: 22,
    title: "Preacher",
    year: 2016,
    tvdbId: 300472,
    imdbId: "tt5016504",
    monitored: true,
    statistics: { episodeFileCount: 1, episodeCount: 1, percentOfEpisodes: 100 },
  },
];

const EPISODES_21 = [
  {
    id: 901,
    seriesId: 21,
    seasonNumber: 6,
    episodeNumber: 1,
    airDate: "2022-01-23",
    hasFile: true,
    monitored: true,
    episodeFile: { id: 3494, path: "/plex/tv/Billions/S06E01.mkv", size: 1096430268, mediaInfo: MEDIA_INFO },
  },
  {
    id: 902,
    seriesId: 21,
    seasonNumber: 6,
    episodeNumber: 2,
    airDate: "2022-01-30",
    hasFile: false,
    monitored: true,
  },
];

const EPISODES_22 = [
  {
    id: 910,
    seriesId: 22,
    seasonNumber: 1,
    episodeNumber: 1,
    airDate: "2016-05-22",
    hasFile: true,
    monitored: true,
    episodeFile: { id: 4000, path: "/plex/tv/Preacher/S01E01.mkv", size: 100, mediaInfo: MEDIA_INFO },
  },
];

const realFetch = globalThis.fetch;
let dir: string;
let store: Store;
let calls: string[];

beforeEach(() => {
  dir = mkdtempSync(`${tmpdir()}/finderr-mediafile-`);
  process.env.FINDERR_DATA_DIR = dir;
  // `loadConfig(true)` forces the re-read; the cached config still names the previous
  // directory, and `new Store()` against it opens a path this test never created.
  store = new Store(loadConfig(true));
  calls = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/api/v3/movie") return Response.json(MOVIES);
    if (url.pathname === "/api/v3/series") return Response.json(SERIES);
    if (url.pathname === "/api/v3/episode") {
      const id = url.searchParams.get("seriesId");
      return Response.json(id === "21" ? EPISODES_21 : EPISODES_22);
    }
    return new Response("upstream is unwell", { status: 500 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  store.close();
  rmSync(dir, { recursive: true, force: true });
  process.env.FINDERR_DATA_DIR = undefined;
});

const clients = () => ({ radarr: new RadarrClient(RADARR), sonarr: new SonarrClient(SONARR) });

describe("the walks mirror the file for free", () => {
  test("a movie's file lands on the ordinary library walk, with no extra call", async () => {
    const res = await syncLibrary(store, clients(), WALK_EVERYTHING);

    expect(res.errors).toEqual([]);
    expect(store.mediaFile("tt12261776")).toMatchObject({
      path: "/plex/movie/65 (2023)/65.mkv",
      video_codec: "x265",
      audio_codec: "EAC3",
      service: "radarr",
    });
    // ONE movie call for the whole library. A second would mean the file cost a walk.
    expect(calls.filter((c) => c.startsWith("/api/v3/movie"))).toHaveLength(1);
  });

  test("a movie with no file mirrors no row rather than an empty one", async () => {
    await syncLibrary(store, clients(), WALK_EVERYTHING);
    expect(store.mediaFile("tt2222222")).toBeNull();
  });

  /**
   * THE QUERY STRING IS THE FEATURE. Without `includeEpisodeFile` Sonarr answers with no
   * file block at all and every episode silently becomes unplayable -- a regression that
   * looks like missing data rather than like a broken request.
   */
  test("the episode walk asks for the file, and gets it", async () => {
    await syncLibrary(store, clients(), WALK_EVERYTHING);

    const episodeCalls = calls.filter((c) => c.startsWith("/api/v3/episode"));
    expect(episodeCalls.length).toBeGreaterThan(0);
    for (const c of episodeCalls) expect(c).toContain("includeEpisodeFile=true");

    expect(store.mediaFile("tt4269552", { season: 6, episode: 1 })).toMatchObject({
      path: "/plex/tv/Billions/S06E01.mkv",
      arr_file_id: 3494,
      service: "sonarr",
    });
    expect(store.mediaFile("tt4269552", { season: 6, episode: 2 })).toBeNull();
  });

  /**
   * The episode walk is BATCHED, so a service-wide swap would delete the rows of every
   * series the pass did not visit. Walking one series must leave the other's rows alone.
   */
  test("re-walking one series does not empty another's files", async () => {
    await syncLibrary(store, clients(), WALK_EVERYTHING);
    expect(store.mediaFile("tt5016504", { season: 1, episode: 1 })).not.toBeNull();

    await syncEpisodes(
      store,
      new SonarrClient(SONARR),
      [{ imdb_id: "tt4269552", arr_id: 21 }],
      WALK_EVERYTHING,
    );

    expect(store.mediaFile("tt4269552", { season: 6, episode: 1 })).not.toBeNull();
    expect(store.mediaFile("tt5016504", { season: 1, episode: 1 })).not.toBeNull();
  });

  /** The same rule the rest of the mirror follows: a sick arr must not empty the table. */
  test("a failed movie walk leaves the previous file mirror standing", async () => {
    await syncLibrary(store, clients(), WALK_EVERYTHING);
    expect(store.mediaFile("tt12261776")).not.toBeNull();

    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const res = await syncLibrary(store, clients(), WALK_EVERYTHING);

    expect(res.errors.length).toBeGreaterThan(0);
    expect(store.mediaFile("tt12261776")).not.toBeNull();
  });

  test("counts what it mirrored, for the health endpoint", async () => {
    await syncLibrary(store, clients(), WALK_EVERYTHING);
    // One film plus two episodes across two series.
    expect(store.mediaFileCount()).toBe(3);
  });
});
