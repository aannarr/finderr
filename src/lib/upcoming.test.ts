import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { RadarrCalendarEntry, SonarrCalendarEntry } from "./arr";
import { loadConfig } from "./config";
import type { PluginFetch } from "./plugin-fetch";
import { Store } from "./store";
import { TmdbApi } from "./tmdb-api";
import {
  calendarWindow,
  radarrUpcomingRows,
  sonarrUpcomingRows,
  soonestFutureDate,
  syncTmdbTrending,
  toCalendarDate,
} from "./upcoming";

const TODAY = "2026-08-31";

describe("toCalendarDate", () => {
  test("both shapes the arrs send reduce to a plain date", () => {
    // Radarr sends a full ISO timestamp, Sonarr sends a bare date.
    expect(toCalendarDate("2026-11-18T00:00:00Z")).toBe("2026-11-18");
    expect(toCalendarDate("2026-08-30")).toBe("2026-08-30");
  });

  test("absent and malformed are both null rather than a guess", () => {
    expect(toCalendarDate(null)).toBeNull();
    expect(toCalendarDate(undefined)).toBeNull();
    expect(toCalendarDate("")).toBeNull();
    expect(toCalendarDate("soon")).toBeNull();
  });
});

describe("soonestFutureDate", () => {
  /**
   * The case the old shelf got wrong, in miniature. Taking the first non-null date, or the
   * earliest one, both put 1986 on a shelf called "Releasing soon".
   */
  test("a historic date loses to a future one however early it is", () => {
    expect(
      soonestFutureDate(
        [
          ["cinemas", "1986-12-12T00:00:00Z"],
          ["digital", "2026-09-02T00:00:00Z"],
        ],
        TODAY,
      ),
    ).toEqual({ date: "2026-09-02", date_kind: "digital" });
  });

  test("the soonest of several future dates wins, and says which kind it is", () => {
    expect(
      soonestFutureDate(
        [
          ["cinemas", "2026-12-01"],
          ["digital", "2026-10-05"],
          ["physical", "2026-11-03"],
        ],
        TODAY,
      ),
    ).toEqual({ date: "2026-10-05", date_kind: "digital" });
  });

  /** Everything in the past means the row is not upcoming at all, not that it is undated. */
  test("all dates behind us is null", () => {
    expect(
      soonestFutureDate(
        [
          ["cinemas", "2025-08-23"],
          ["digital", "2025-06-19"],
        ],
        TODAY,
      ),
    ).toBeNull();
  });

  /** A film out this morning is still today's news, so today counts as future. */
  test("today is future", () => {
    expect(soonestFutureDate([["digital", TODAY]], TODAY)).toEqual({
      date: TODAY,
      date_kind: "digital",
    });
  });
});

describe("radarrUpcomingRows", () => {
  /** Shaped after the real 2026-08-31 answer, including the awkward entries. */
  const entries: RadarrCalendarEntry[] = [
    { imdbId: "tt24818230", digitalRelease: "2026-11-18T00:00:00Z" },
    // In cinemas in 1986, digital next week: the row is about next week.
    { imdbId: "tt0091129", inCinemas: "1986-12-12T00:00:00Z", digitalRelease: "2026-09-02T00:00:00Z" },
    // Every date behind us -- not upcoming.
    { imdbId: "tt0000001", inCinemas: "2025-08-23T00:00:00Z", digitalRelease: "2025-06-19T00:00:00Z" },
    // No IMDb id is nothing we can key on.
    { title: "Untracked", digitalRelease: "2026-09-05T00:00:00Z" },
  ];

  test("only titles with an id and a future date survive, soonest first", () => {
    const rows = radarrUpcomingRows(entries, TODAY);
    expect(rows.map((r) => [r.tconst, r.date, r.date_kind])).toEqual([
      ["tt0091129", "2026-09-02", "digital"],
      ["tt24818230", "2026-11-18", "digital"],
    ]);
    expect(rows.every((r) => r.kind === "movie" && r.source === "radarr")).toBe(true);
  });

  /**
   * aannarr, from the live shelf 2026-08-31: Supergirl and In the Grey were on "Releasing
   * soon" while already on disk. Radarr lists them for a PHYSICAL date months after their
   * digital release, so the shelf was announcing a disc to somebody who has the film --
   * and contradicting the "In library" badge printed on the same card.
   */
  test("a film already on disk is dropped, whatever date the calendar carries", () => {
    const held: RadarrCalendarEntry[] = [
      // Supergirl's real shape: cinemas and digital past, physical ahead, file present.
      {
        imdbId: "tt-supergirl",
        inCinemas: "2026-06-24T00:00:00Z",
        digitalRelease: "2026-07-28T00:00:00Z",
        physicalRelease: "2026-09-08T00:00:00Z",
        hasFile: true,
      },
      { imdbId: "tt-wanted", digitalRelease: "2026-09-01T00:00:00Z", hasFile: false },
    ];
    expect(radarrUpcomingRows(held, TODAY).map((r) => r.tconst)).toEqual(["tt-wanted"]);
  });

  /**
   * The second half of the Supergirl fix, and the one that holds even without `hasFile`.
   * A disc pressing is not something a reader can act on, so a film whose ONLY future
   * date is physical is not on this shelf at all.
   */
  test("a disc date alone does not put a film on the shelf", () => {
    const discOnly: RadarrCalendarEntry[] = [
      {
        imdbId: "tt-disc",
        inCinemas: "2026-06-24T00:00:00Z",
        digitalRelease: "2026-07-28T00:00:00Z",
        physicalRelease: "2026-09-08T00:00:00Z",
        hasFile: false,
      },
    ];
    expect(radarrUpcomingRows(discOnly, TODAY)).toEqual([]);
  });

  /** Cinemas and digital both ahead: the soonest wins, and says which it is. */
  test("between a cinema and a streaming date, the nearer one is the row", () => {
    const both: RadarrCalendarEntry[] = [
      {
        imdbId: "tt-both",
        inCinemas: "2026-10-02T00:00:00Z",
        digitalRelease: "2026-09-20T00:00:00Z",
      },
    ];
    expect(radarrUpcomingRows(both, TODAY).map((r) => [r.date, r.date_kind])).toEqual([
      ["2026-09-20", "digital"],
    ]);
  });
});

describe("sonarrUpcomingRows", () => {
  const entries: SonarrCalendarEntry[] = [
    { series: { imdbId: "tt1" }, airDate: "2026-09-04", seasonNumber: 2, episodeNumber: 11 },
    { series: { imdbId: "tt1" }, airDate: "2026-09-01", seasonNumber: 2, episodeNumber: 9 },
    { series: { imdbId: "tt1" }, airDate: "2026-09-08", seasonNumber: 2, episodeNumber: 12 },
    { series: { imdbId: "tt2" }, airDate: "2026-09-02", seasonNumber: 1, episodeNumber: 3 },
    { airDate: "2026-09-03", seasonNumber: 1, episodeNumber: 1 },
  ];

  test("a series airing several times is one row carrying the nearest episode", () => {
    const rows = sonarrUpcomingRows(entries, TODAY);
    expect(rows.map((r) => [r.tconst, r.date, r.detail])).toEqual([
      ["tt1", "2026-09-01", "S2E9"],
      ["tt2", "2026-09-02", "S1E3"],
    ]);
    expect(rows.every((r) => r.kind === "series" && r.date_kind === "airDate")).toBe(true);
  });

  test("an entry with no series attached is dropped", () => {
    expect(sonarrUpcomingRows(entries, TODAY).map((r) => r.tconst)).not.toContain(undefined);
  });

  /**
   * The reason the window looks backwards at all. An episode that aired two days ago and
   * did NOT land is the most actionable row this shelf can carry, and the old
   * future-only rule threw it away.
   */
  test("a recently aired episode is kept, and says whether we hold it", () => {
    const recent: SonarrCalendarEntry[] = [
      {
        series: { imdbId: "tt1" },
        airDate: "2026-08-29",
        seasonNumber: 2,
        episodeNumber: 8,
        title: "And the Toy Phone",
        hasFile: false,
      },
    ];
    expect(sonarrUpcomingRows(recent, TODAY)).toEqual([
      {
        tconst: "tt1",
        kind: "series",
        source: "sonarr",
        date: "2026-08-29",
        date_kind: "airDate",
        detail: "S2E8",
        episode_title: "And the Toy Phone",
        has_file: 0,
      },
    ]);
  });

  /**
   * Distance, not "the next one to air". A show whose latest episode aired yesterday and
   * whose next is a week out should report yesterday -- that is where the show IS, and it
   * is the row whose has_file means anything.
   */
  test("the episode nearest to today wins, past or future", () => {
    const straddling: SonarrCalendarEntry[] = [
      { series: { imdbId: "tt1" }, airDate: "2026-08-30", seasonNumber: 1, episodeNumber: 4, hasFile: false },
      { series: { imdbId: "tt1" }, airDate: "2026-09-07", seasonNumber: 1, episodeNumber: 5, hasFile: false },
    ];
    const rows = sonarrUpcomingRows(straddling, TODAY);
    expect(rows.map((r) => [r.date, r.detail])).toEqual([["2026-08-30", "S1E4"]]);
  });

  /**
   * aannarr, 2026-08-31: Last Week Tonight sat on "Airing soon" with an episode from 23
   * August. Two faults met -- a seven-day look-back was long enough to hold a whole
   * broadcast cycle, and Sonarr had returned a row OUTSIDE the window that was asked for
   * (it filters on airDateUtc, so the answer spills a day past each end). The window is
   * enforced here now rather than trusted from the request.
   */
  test("an episode older than the look-back is refused even when Sonarr sends it", () => {
    const stale: SonarrCalendarEntry[] = [
      { series: { imdbId: "tt1" }, airDate: "2026-08-23", seasonNumber: 13, episodeNumber: 22 },
    ];
    expect(sonarrUpcomingRows(stale, TODAY)).toEqual([]);
  });

  test("an episode beyond the future horizon is refused too", () => {
    const far: SonarrCalendarEntry[] = [
      { series: { imdbId: "tt1" }, airDate: "2026-09-30", seasonNumber: 1, episodeNumber: 1 },
    ];
    expect(sonarrUpcomingRows(far, TODAY)).toEqual([]);
  });

  /** Four days back, fourteen ahead. Both edges are inclusive. */
  test("the window edges themselves are kept", () => {
    const edges: SonarrCalendarEntry[] = [
      { series: { imdbId: "tt-back" }, airDate: "2026-08-27", seasonNumber: 1, episodeNumber: 1 },
      { series: { imdbId: "tt-fwd" }, airDate: "2026-09-14", seasonNumber: 1, episodeNumber: 1 },
    ];
    expect(sonarrUpcomingRows(edges, TODAY).map((r) => r.tconst)).toEqual(["tt-back", "tt-fwd"]);
  });

  /** A tie goes to the earlier date, so today beats tomorrow and nothing is skipped over. */
  test("equidistant episodes break toward the earlier one", () => {
    const tie: SonarrCalendarEntry[] = [
      { series: { imdbId: "tt1" }, airDate: "2026-09-01", seasonNumber: 1, episodeNumber: 2 },
      { series: { imdbId: "tt1" }, airDate: "2026-08-30", seasonNumber: 1, episodeNumber: 1 },
    ];
    expect(sonarrUpcomingRows(tie, TODAY).map((r) => r.detail)).toEqual(["S1E1"]);
  });
});

describe("calendarWindow", () => {
  test("it spans from today to today plus the window, as plain dates", () => {
    expect(calendarWindow(14, new Date("2026-08-31T12:00:00Z"))).toEqual({
      start: "2026-08-31",
      end: "2026-09-14",
    });
  });

  /** The look-back is what gives `hasFile` something to say. */
  test("a look-back moves the start date earlier", () => {
    expect(calendarWindow(14, new Date("2026-08-31T12:00:00Z"), 7)).toEqual({
      start: "2026-08-24",
      end: "2026-09-14",
    });
  });
});

describe("syncTmdbTrending", () => {
  let dataDir: string;
  let store: Store;
  let asked: string[];

  beforeEach(() => {
    dataDir = mkdtempSync(`${tmpdir()}/finderr-trending-test-`);
    process.env.FINDERR_DATA_DIR = dataDir;
    store = new Store(loadConfig(true));
    asked = [];
  });

  afterEach(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.FINDERR_DATA_DIR;
  });

  /** TMDB's trending page plus whatever `external_ids` each id needs, all from memory. */
  function apiFor(
    results: { id: number; media_type?: string | null }[],
    imdbOf: Record<string, string | null> = {},
    trendingStatus = 200,
  ): TmdbApi {
    const fetchImpl: PluginFetch = async (input) => {
      const url = new URL(String(input));
      asked.push(url.pathname);
      if (url.pathname === "/3/trending/all/week") {
        return trendingStatus === 200
          ? Response.json({ results })
          : new Response("nope", { status: trendingStatus });
      }
      const ext = /^\/3\/(movie|tv)\/(\d+)\/external_ids$/.exec(url.pathname);
      if (ext) return Response.json({ imdb_id: imdbOf[`${ext[1]}:${ext[2]}`] ?? null });
      return new Response("not found", { status: 404 });
    };
    return new TmdbApi(fetchImpl, "0123456789abcdef0123456789abcdef");
  }

  const deps = (known: string[]) => ({ store, hasRow: (t: string) => known.includes(t) });

  test("mirrors the list in TMDB's order, tagging each row with its kind", async () => {
    const api = apiFor(
      [
        { id: 1, media_type: "movie" },
        { id: 2, media_type: "tv" },
      ],
      { "movie:1": "tt0000001", "tv:2": "tt0000002" },
    );
    const res = await syncTmdbTrending(deps(["tt0000001", "tt0000002"]), api);

    expect(res).toEqual({ source: "tmdb-trending", rows: 2 });
    expect(store.trending()).toEqual([
      { tconst: "tt0000001", kind: "movie", position: 0 },
      { tconst: "tt0000002", kind: "series", position: 1 },
    ]);
  });

  /**
   * The position must number the rows we KEEP. Numbering the raw response instead would
   * leave gaps, and a shelf ordered by a gapped column is still fine -- but a later reader
   * comparing `position` to a list length would be quietly wrong.
   */
  test("positions are contiguous over the rows kept, not over the raw response", async () => {
    const api = apiFor(
      [
        { id: 1, media_type: "movie" },
        { id: 9, media_type: "movie" },
        { id: 2, media_type: "movie" },
      ],
      { "movie:1": "tt0000001", "movie:9": "tt0000009", "movie:2": "tt0000002" },
    );
    // tt0000009 crosswalks fine but is not in our index, so no card can be drawn for it.
    await syncTmdbTrending(deps(["tt0000001", "tt0000002"]), api);
    expect(store.trending().map((r) => [r.tconst, r.position])).toEqual([
      ["tt0000001", 0],
      ["tt0000002", 1],
    ]);
  });

  /** `person` is a real `media_type` on this endpoint and is not a title. */
  test("a result that is not a film or a series is skipped and costs no crosswalk", async () => {
    const api = apiFor([{ id: 5, media_type: "person" }, { id: 6 }]);
    const res = await syncTmdbTrending(deps([]), api);
    expect(res.rows).toBe(0);
    expect(asked.filter((p) => p.includes("external_ids"))).toEqual([]);
  });

  /**
   * The rule every mirror in this tree follows. An emptied shelf and a broken sync look
   * identical on screen, so a failed call must leave last week's list standing.
   */
  test("a failed call throws and never reaches the store", async () => {
    await syncTmdbTrending(
      deps(["tt0000001"]),
      apiFor([{ id: 1, media_type: "movie" }], { "movie:1": "tt0000001" }),
    );
    expect(store.trendingCount()).toBe(1);

    await expect(syncTmdbTrending(deps(["tt0000001"]), apiFor([], {}, 503))).rejects.toThrow();
    // Still standing.
    expect(store.trendingCount()).toBe(1);
  });

  /** A successful call that genuinely matches nothing IS an answer, and it does clear. */
  test("a successful empty answer clears the table", async () => {
    await syncTmdbTrending(
      deps(["tt0000001"]),
      apiFor([{ id: 1, media_type: "movie" }], { "movie:1": "tt0000001" }),
    );
    expect(store.trendingCount()).toBe(1);

    await syncTmdbTrending(deps([]), apiFor([]));
    expect(store.trendingCount()).toBe(0);
  });

  /**
   * The crosswalk is parked forever and SHARED with the upcoming sync, so a title that
   * trends two weeks running costs one `external_ids` call in total, not one per run.
   */
  test("the tmdbId -> tconst crosswalk is bought once, including a null one", async () => {
    const results = [
      { id: 1, media_type: "movie" },
      { id: 7, media_type: "movie" },
    ];
    const imdb = { "movie:1": "tt0000001" };
    await syncTmdbTrending(deps(["tt0000001"]), apiFor(results, imdb));
    const first = asked.filter((p) => p.includes("external_ids")).length;
    expect(first).toBe(2);

    asked = [];
    await syncTmdbTrending(deps(["tt0000001"]), apiFor(results, imdb));
    expect(asked.filter((p) => p.includes("external_ids"))).toEqual([]);
  });
});
