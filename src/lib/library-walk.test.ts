/**
 * The Radarr and Sonarr mirror walks, at the transport.
 *
 * The real clients against a stubbed `fetch`, for the reason `arr.test.ts` gives: the property
 * under test lives in how the response is READ, and a mocked client would prove only that we
 * called the method we named. These bodies are served as chunked streams so the walk goes
 * through the same incremental path a real socket puts it through.
 *
 * The rule every case here circles is the one the mirror rests on: **a walk that fails leaves
 * the previous mirror standing**. A swap plus a failure that arrives as an empty list is how a
 * working library becomes an empty page, and it is worth more than one assertion because there
 * are now several ways for a walk to end badly.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { RadarrClient, SonarrClient } from "./arr";
import { type ArrService, loadConfig } from "./config";
import { Store, syncEpisodes, syncLibrary } from "./store";

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

/**
 * Batch big enough that nothing is deferred, and staleness that makes everything due.
 *
 * `staleSeconds: -1` rather than `0`, and the sign is the point: `seriesNeedingEpisodeRefresh`
 * asks for `walked_at < staleBefore`, so at `0` a series walked earlier in the same millisecond
 * compares EQUAL and is not due. A negative puts the cutoff a second in the future and the
 * question stops being a race against the clock.
 */
const WALK_EVERYTHING = { batch: 100, staleSeconds: -1 };

const MOVIES = [
  {
    id: 11,
    title: "Inception",
    year: 2010,
    tmdbId: 27205,
    imdbId: "tt1375666",
    hasFile: true,
    monitored: true,
    titleSlug: "27205",
    added: "2024-01-02T03:04:05Z",
    studio: "Legendary Pictures",
    images: [{ coverType: "poster", remoteUrl: "http://image.test/inception.jpg" }],
  },
  {
    id: 12,
    title: "Arrival",
    year: 2016,
    tmdbId: 329865,
    imdbId: "tt2543164",
    hasFile: false,
    monitored: true,
    added: "2025-06-01T00:00:00Z",
    images: [],
  },
  {
    // HELD, but with Radarr's zero-date placeholder rather than a real acquisition date. It
    // is the only shape that separates "we do not know when this arrived" from "it arrived in
    // the year 1", and the recently-added shelf is where the difference shows.
    id: 13,
    title: "Sicario",
    year: 2015,
    tmdbId: 273481,
    imdbId: "tt3397884",
    hasFile: true,
    monitored: true,
    added: "0001-01-01T00:00:00Z",
    images: [],
  },
];

const SERIES = [
  {
    id: 21,
    title: "Preacher",
    year: 2016,
    tvdbId: 305074,
    imdbId: "tt5016504",
    monitored: true,
    titleSlug: "preacher",
    statistics: { episodeFileCount: 43, episodeCount: 43, percentOfEpisodes: 100 },
    network: "AMC",
    images: [{ coverType: "poster", remoteUrl: "http://image.test/preacher.jpg" }],
  },
];

const EPISODES = [
  {
    id: 901,
    seriesId: 21,
    seasonNumber: 1,
    episodeNumber: 1,
    title: "Pilot",
    airDate: "2016-05-22",
    hasFile: true,
    monitored: true,
  },
  {
    id: 902,
    seriesId: 21,
    seasonNumber: 1,
    episodeNumber: 2,
    title: "See",
    airDate: "2016-06-05",
    hasFile: false,
    monitored: true,
  },
];

/** What a stubbed arr answers with, by `pathname` -- the query string is matched separately. */
interface ArrRoutes {
  movies?: unknown[] | string;
  series?: unknown[] | string;
  episodes?: unknown[] | string;
}

/**
 * A body delivered in small pieces, so the streaming reader is exercised rather than handed
 * one complete string. 64 bytes is well inside a single record, which is where an incremental
 * scanner would go wrong if it were going to.
 */
function chunkedResponse(text: string): Response {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (at >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(at, at + 64));
        at += 64;
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

const realFetch = globalThis.fetch;

/** Swap `fetch` for a pair of stub arrs. A route left out answers 500, i.e. that arr is sick. */
function serving(routes: ArrRoutes, onCall?: (url: string) => void): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    onCall?.(`${url.pathname}${url.search}`);
    const body =
      url.pathname === "/api/v3/movie"
        ? routes.movies
        : url.pathname === "/api/v3/series"
          ? routes.series
          : url.pathname === "/api/v3/episode"
            ? routes.episodes
            : undefined;
    if (body === undefined) return new Response("upstream is unwell", { status: 500 });
    return chunkedResponse(typeof body === "string" ? body : JSON.stringify(body));
  }) as typeof fetch;
}

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(`${tmpdir()}/finderr-walk-`);
  process.env.FINDERR_DATA_DIR = dir;
  store = new Store(loadConfig(true));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  store.close();
  rmSync(dir, { recursive: true, force: true });
  process.env.FINDERR_DATA_DIR = undefined;
});

function clients() {
  return { radarr: new RadarrClient(RADARR), sonarr: new SonarrClient(SONARR) };
}

describe("syncLibrary mirrors what the arrs report", () => {
  test("both services, their posters and their studios, off one walk each", async () => {
    serving({ movies: MOVIES, series: SERIES, episodes: EPISODES });

    const res = await syncLibrary(store, clients(), WALK_EVERYTHING);

    expect(res.errors).toEqual([]);
    expect(res.radarr).toBe(3);
    expect(res.sonarr).toBe(1);
    expect(res.episodes).toBe(2);

    const mirror = store.libraryMap();
    expect(mirror.get("tt1375666")).toMatchObject({
      service: "radarr",
      arr_id: 11,
      has_file: 1,
      title_slug: "27205",
    });
    expect(mirror.get("tt2543164")).toMatchObject({ has_file: 0, progress: 0 });
    expect(mirror.get("tt5016504")).toMatchObject({
      service: "sonarr",
      arr_id: 21,
      has_file: 1,
      progress: 1,
    });

    // Seeded from the SAME response the mirror came from -- an owned title never waits on a
    // lookup for either field.
    expect(store.getArtwork("tt1375666")).toEqual({
      url: "http://image.test/inception.jpg",
      studio: "Legendary Pictures",
    });
    expect(store.getArtwork("tt5016504")?.studio).toBe("AMC");
  });

  /**
   * Radarr's zero date means "no date", and it must not become an `added_at` of year 1 --
   * which would put a film at the top of a shelf ordered by acquisition date forever.
   *
   * Asserted through `recentlyAddedIds`, the one reader of that column: it takes held titles
   * with a date, newest first, so Sicario being absent IS the placeholder having been dropped
   * and Arrival being absent is it not being held.
   */
  test("Radarr's 0001- placeholder date is dropped rather than mirrored", async () => {
    serving({ movies: MOVIES, series: [], episodes: [] });
    await syncLibrary(store, clients(), WALK_EVERYTHING);
    expect(store.recentlyAddedIds()).toEqual(["tt1375666"]);
  });

  test("the episode walk asks Sonarr for the series id the mirror holds", async () => {
    const calls: string[] = [];
    serving({ movies: [], series: SERIES, episodes: EPISODES }, (u) => calls.push(u));

    await syncLibrary(store, clients(), WALK_EVERYTHING);

    // The SERIES ID is what this case defends -- that the walk asks about the series the
    // mirror holds rather than one it invented. It was an exact-string match until the
    // playback mirror added `includeEpisodeFile`, which is a second, unrelated claim about
    // the same URL and has its own case in `media-file.test.ts`. Matching the whole string
    // made this test fail for a reason it was never about.
    const episodeCalls = calls.filter((c) => c.startsWith("/api/v3/episode"));
    expect(episodeCalls).toHaveLength(1);
    expect(episodeCalls[0]).toContain("seriesId=21");
    expect(store.episodeCount()).toBe(2);
  });
});

describe("a walk that fails leaves the previous mirror standing", () => {
  /** Set both mirrors up so there is something to lose. */
  async function seedGoodMirror(): Promise<void> {
    serving({ movies: MOVIES, series: SERIES, episodes: EPISODES });
    await syncLibrary(store, clients(), WALK_EVERYTHING);
    expect(store.libraryCount()).toMatchObject({ radarr: 3, sonarr: 1 });
  }

  /*
    THE ONE THIS CARD IS ABOUT.

    An arr that answers 200 with a body that stops halfway -- a proxy timing out mid-transfer,
    a container killed while writing -- used to be indistinguishable from a short library once
    it had been read whole and parsed. Read incrementally it is not: the reader refuses to hand
    over a list it never saw the end of, so the failure arrives as an error and the swap that
    would have deleted 1,387 films never runs.
  */
  test("a body that stops halfway is an error, not a smaller library", async () => {
    await seedGoodMirror();
    const truncated = JSON.stringify(MOVIES).slice(0, 120);
    serving({ movies: truncated, series: SERIES, episodes: EPISODES });

    const res = await syncLibrary(store, clients(), WALK_EVERYTHING);

    expect(res.errors.join(" ")).toContain("radarr");
    expect(res.radarr).toBeUndefined();
    expect(store.libraryCount().radarr).toBe(3);
    expect(store.libraryMap().get("tt1375666")?.arr_id).toBe(11);
  });

  /** A 200 with nothing in it at all is the same class of answer, and gets the same treatment. */
  test("an empty body is an error, not an empty library", async () => {
    await seedGoodMirror();
    serving({ movies: "", series: SERIES, episodes: EPISODES });

    const res = await syncLibrary(store, clients(), WALK_EVERYTHING);

    expect(res.errors.join(" ")).toContain("radarr");
    expect(store.libraryCount().radarr).toBe(3);
  });

  /** An HTML error page from something in front of the arr, rather than the arr itself. */
  test("a proxy's HTML error page is an error, not a library", async () => {
    await seedGoodMirror();
    serving({ movies: "<html><body>502 Bad Gateway</body></html>", series: SERIES, episodes: EPISODES });

    const res = await syncLibrary(store, clients(), WALK_EVERYTHING);

    expect(res.errors.join(" ")).toContain("radarr");
    expect(store.libraryCount().radarr).toBe(3);
  });

  /** The rule that was already here: one sick service must not cost us the other. */
  test("Sonarr being down leaves Radarr accurate and Sonarr's rows untouched", async () => {
    await seedGoodMirror();
    serving({ movies: [MOVIES[0]] });

    const res = await syncLibrary(store, clients(), WALK_EVERYTHING);

    expect(res.radarr).toBe(1);
    expect(res.errors.join(" ")).toContain("sonarr");
    expect(store.libraryCount()).toMatchObject({ radarr: 1, sonarr: 1 });
  });
});

describe("syncEpisodes takes mirror rows, not arr records", () => {
  /**
   * The signature is `{ imdb_id, arr_id }` and nothing more, which is what lets `syncLibrary`
   * hand over the rows it already built instead of keeping Sonarr's ~3.8 KB records alive for
   * a second reader. Calling it with an object literal is the proof that it needs nothing else.
   */
  test("a bare {imdb_id, arr_id} pair is enough to walk a series", async () => {
    serving({ series: SERIES, episodes: EPISODES });
    // The candidate slice is read from the MIRROR, so the series has to be in it first.
    store.replaceLibrary("sonarr", [
      { imdb_id: "tt5016504", arr_id: 21, has_file: 1, monitored: 1, progress: 1 },
    ]);

    const res = await syncEpisodes(
      store,
      new SonarrClient(SONARR),
      [{ imdb_id: "tt5016504", arr_id: 21 }],
      WALK_EVERYTHING,
    );

    expect(res.errors).toEqual([]);
    expect(res.series).toBe(1);
    expect(res.episodes).toBe(2);
  });

  /** One bad series must not cost us the other four hundred, and must not empty its own rows. */
  test("a series whose walk fails keeps the rows it had, and the others still walk", async () => {
    serving({ series: SERIES, episodes: EPISODES });
    store.replaceLibrary("sonarr", [
      { imdb_id: "tt5016504", arr_id: 21, has_file: 1, monitored: 1, progress: 1 },
      { imdb_id: "tt0944947", arr_id: 22, has_file: 1, monitored: 1, progress: 1 },
    ]);
    const sonarr = new SonarrClient(SONARR);
    const candidates = [
      { imdb_id: "tt5016504", arr_id: 21 },
      { imdb_id: "tt0944947", arr_id: 22 },
    ];
    await syncEpisodes(store, sonarr, candidates, WALK_EVERYTHING);
    expect(store.episodeCount()).toBe(4); // both series got the same two-episode body

    // Now series 22 alone answers with a truncated body.
    serving({}, undefined);
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.searchParams.get("seriesId") === "22") return chunkedResponse('[{"id":901,');
      return chunkedResponse(JSON.stringify(EPISODES));
    }) as typeof fetch;

    const res = await syncEpisodes(store, sonarr, candidates, WALK_EVERYTHING);

    expect(res.errors.join(" ")).toContain("tt0944947");
    expect(res.series).toBe(1);
    expect(store.episodeCount()).toBe(4);
  });
});
