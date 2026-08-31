import { describe, expect, test } from "bun:test";
import type { RadarrCalendarEntry, SonarrCalendarEntry } from "./arr";
import {
  calendarWindow,
  radarrUpcomingRows,
  sonarrUpcomingRows,
  soonestFutureDate,
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
