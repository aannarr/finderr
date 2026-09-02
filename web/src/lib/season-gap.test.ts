/**
 * What we say about a series we hold only part of.
 *
 * Pure, with `today` injected: every assertion here turns on whether an episode has aired,
 * and a test that read the wall clock would start failing on its own on some future
 * Tuesday. The dates below are Game of Thrones' real ones.
 */

import { describe, expect, test } from "bun:test";
import type { EpisodeState } from "../../../src/lib/episodes";
import type { Episode, Season } from "./facets";
import { type SeasonGap, seriesGap, summariseSeriesGap } from "./season-gap";

const TODAY = "2026-09-03";

function season(number: number): Season {
  return { number, name: null, episodeCount: null, premiereDate: null, endDate: null, image: null };
}

function episode(season: number, number: number): Episode {
  return { season, number, title: null, airDate: null, overview: null, image: null, runtime: null };
}

/** Sonarr's answer for one episode. Aired and downloaded unless a test says otherwise. */
function state(season: number, episode: number, over: Partial<EpisodeState> = {}): EpisodeState {
  return {
    season,
    episode,
    arrEpisodeId: season * 100 + episode,
    hasFile: true,
    monitored: true,
    airDate: "2011-04-17",
    ...over,
  };
}

/** `count` episodes of one season, as skyhook lists them. */
function seasonEpisodes(number: number, count: number): Episode[] {
  return Array.from({ length: count }, (_, i) => episode(number, i + 1));
}

function gapOf(
  seasons: readonly Season[],
  episodes: readonly Episode[],
  episodeState: readonly EpisodeState[] | undefined,
): SeasonGap[] {
  return seriesGap(seasons, episodes, episodeState, TODAY);
}

describe("a series Sonarr does not hold", () => {
  /**
   * The common case by a wide margin: every title in search that nobody has asked for.
   * No episode state means no opinion, and no opinion means no sentence.
   */
  test("gets no gap and no sentence", () => {
    const gap = gapOf([season(1)], seasonEpisodes(1, 10), undefined);
    expect(gap).toEqual([]);
    expect(summariseSeriesGap(gap)).toBeNull();
  });

  test("an empty episode list is the same answer as no list at all", () => {
    expect(gapOf([season(1)], seasonEpisodes(1, 10), [])).toEqual([]);
  });
});

describe("the sentence the card asked for", () => {
  const seasons = [season(1), season(2), season(3)];
  const episodes = [...seasonEpisodes(1, 10), ...seasonEpisodes(2, 10), ...seasonEpisodes(3, 10)];

  /** Seasons 1 and 2 complete, season 3 short by four. */
  const held: EpisodeState[] = [
    ...seasonEpisodes(1, 10).map((e) => state(e.season, e.number)),
    ...seasonEpisodes(2, 10).map((e) => state(e.season, e.number)),
    ...seasonEpisodes(3, 10).map((e) => state(e.season, e.number, { hasFile: e.number <= 6 })),
  ];

  test("collapses the complete run and names what is short", () => {
    expect(summariseSeriesGap(gapOf(seasons, episodes, held))).toBe(
      "Downloaded: Seasons 1-2 complete, Season 3 missing 4 episodes",
    );
  });

  test("says nothing about Plex or availability -- this is the arr's hasFile and only that", () => {
    const sentence = summariseSeriesGap(gapOf(seasons, episodes, held)) ?? "";
    expect(sentence).toStartWith("Downloaded:");
    expect(sentence).not.toContain("available");
    expect(sentence).not.toContain("watch");
  });

  test("a single missing episode is not pluralised", () => {
    const nearly = held.map((s) => (s.season === 3 && s.episode === 10 ? { ...s, hasFile: false } : s));
    const almost = nearly.map((s) =>
      s.season === 3 && s.episode > 6 && s.episode < 10 ? { ...s, hasFile: true } : s,
    );
    expect(summariseSeriesGap(gapOf(seasons, episodes, almost))).toBe(
      "Downloaded: Seasons 1-2 complete, Season 3 missing 1 episode",
    );
  });

  test("a show held in full says so rather than saying nothing", () => {
    const all = held.map((s) => ({ ...s, hasFile: true }));
    expect(summariseSeriesGap(gapOf(seasons, episodes, all))).toBe("Downloaded: Seasons 1-3 complete");
  });

  /**
   * Eight seasons of nothing is one clause, not eight. The per-season detail is a chip
   * away; a line nobody reads to the end answers nothing.
   */
  test("collapses the missing seasons too, so the line stays one line", () => {
    const eight = Array.from({ length: 8 }, (_, i) => season(i + 1));
    const eightEpisodes = eight.flatMap((s) => seasonEpisodes(s.number, 10));
    const none = eightEpisodes.map((e) => state(e.season, e.number, { hasFile: false }));
    expect(summariseSeriesGap(gapOf(eight, eightEpisodes, none))).toBe(
      "Downloaded: Seasons 1-8 missing 80 episodes",
    );
  });
});

describe("season 0", () => {
  /**
   * Every series has one and nobody wants 55 behind-the-scenes clips. Counting them would
   * tell a reader who holds the whole show that they are 55 episodes short of it.
   */
  test("is never counted as missing content", () => {
    const seasons = [season(0), season(1)];
    const episodes = [...seasonEpisodes(0, 55), ...seasonEpisodes(1, 10)];
    const held = episodes.map((e) => state(e.season, e.number, { hasFile: e.season !== 0 }));

    expect(gapOf(seasons, episodes, held)).toEqual([{ season: 1, holding: "complete", missing: 0 }]);
  });
});

describe("a season that has not finished airing", () => {
  const seasons = [season(1)];
  const episodes = seasonEpisodes(1, 10);

  /** Six aired and held, four still to come. "Complete" would be a promise the show has not kept. */
  test("is up to date rather than complete when every aired episode is held", () => {
    const held = episodes.map((e) =>
      state(e.season, e.number, e.number > 6 ? { hasFile: false, airDate: "2027-01-01" } : {}),
    );
    expect(gapOf(seasons, episodes, held)).toEqual([{ season: 1, holding: "current", missing: 0 }]);
    expect(summariseSeriesGap(gapOf(seasons, episodes, held))).toBe("Downloaded: Season 1 up to date");
  });

  test("a season where nothing has aired yet is left out entirely", () => {
    const unaired = episodes.map((e) => state(e.season, e.number, { hasFile: false, airDate: "2027-01-01" }));
    expect(gapOf(seasons, episodes, unaired)).toEqual([]);
  });

  /** A dateless episode is one nobody can have; it must not read as a hole. */
  test("an episode Sonarr has no date for is not counted as missing", () => {
    const dateless = episodes.map((e) =>
      state(e.season, e.number, e.number > 6 ? { hasFile: false, airDate: null } : {}),
    );
    expect(gapOf(seasons, episodes, dateless)).toEqual([{ season: 1, holding: "current", missing: 0 }]);
  });
});

describe("what counts as missing", () => {
  const seasons = [season(1)];
  const episodes = seasonEpisodes(1, 4);

  /**
   * `wanted` (Sonarr is already searching) and `missing` (unmonitored) are different rows
   * on screen, and the same answer to "do I have it".
   */
  test("an episode Sonarr is already searching for is still an episode we do not have", () => {
    const held = [
      state(1, 1),
      state(1, 2, { hasFile: false, monitored: true }),
      state(1, 3, { hasFile: false, monitored: false }),
      state(1, 4),
    ];
    expect(gapOf(seasons, episodes, held)).toEqual([{ season: 1, holding: "partial", missing: 2 }]);
  });

  /**
   * Skyhook is ahead of the mirror often enough to matter -- an episode announced upstream
   * that Sonarr has not picked up yet. Never claim a hole we cannot prove.
   */
  test("an episode Sonarr does not list is not a hole", () => {
    expect(gapOf(seasons, episodes, [state(1, 1), state(1, 2)])).toEqual([
      { season: 1, holding: "current", missing: 0 },
    ]);
  });
});

describe("the seasons the provider sent but the episodes facet did not", () => {
  /** A season with no episodes on the page is a season we can say nothing about. */
  test("are left out rather than reported as empty", () => {
    expect(gapOf([season(1), season(2)], seasonEpisodes(1, 2), [state(1, 1), state(1, 2)])).toEqual([
      { season: 1, holding: "complete", missing: 0 },
    ]);
  });
});
