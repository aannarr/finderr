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
});

describe("sonarrUpcomingRows", () => {
  const entries: SonarrCalendarEntry[] = [
    { series: { imdbId: "tt1" }, airDate: "2026-09-04", seasonNumber: 2, episodeNumber: 11 },
    { series: { imdbId: "tt1" }, airDate: "2026-09-01", seasonNumber: 2, episodeNumber: 9 },
    { series: { imdbId: "tt1" }, airDate: "2026-09-08", seasonNumber: 2, episodeNumber: 12 },
    { series: { imdbId: "tt2" }, airDate: "2026-09-02", seasonNumber: 1, episodeNumber: 3 },
    { airDate: "2026-09-03", seasonNumber: 1, episodeNumber: 1 },
  ];

  /**
   * The collapse is the point: a show airing three times in the window is one card, and
   * the episode it names must be the NEXT one rather than whichever row arrived last.
   */
  test("a series airing several times is one row carrying its next episode", () => {
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

  test("episodes that already aired do not come back", () => {
    const past: SonarrCalendarEntry[] = [
      { series: { imdbId: "tt1" }, airDate: "2026-08-30", seasonNumber: 2, episodeNumber: 8 },
    ];
    expect(sonarrUpcomingRows(past, TODAY)).toEqual([]);
  });
});

describe("calendarWindow", () => {
  test("it spans from today to today plus the window, as plain dates", () => {
    expect(calendarWindow(14, new Date("2026-08-31T12:00:00Z"))).toEqual({
      start: "2026-08-31",
      end: "2026-09-14",
    });
  });
});
