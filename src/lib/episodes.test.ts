import { describe, expect, test } from "bun:test";
import {
  airedWithoutFile,
  type EpisodeState,
  episodeStanding,
  hasMissingEpisodes,
  missingEpisodeIdsIn,
  seasonsWithMissing,
  todayUtc,
} from "./episodes";

const TODAY = "2026-08-31";

describe("episodeStanding", () => {
  const state = (over: Partial<{ hasFile: boolean; monitored: boolean; airDate: string | null }> = {}) => ({
    hasFile: false,
    monitored: false,
    airDate: "2025-05-28",
    ...over,
  });

  test("an episode Sonarr does not list says nothing at all", () => {
    // The whole series is in this state when Sonarr does not hold the show, which is why
    // the pane looks exactly as it did before any of this existed for those shows.
    expect(episodeStanding(undefined, TODAY)).toBe("unknown");
  });

  test("a file we hold is owned, whatever else is true of it", () => {
    expect(episodeStanding(state({ hasFile: true, monitored: false }), TODAY)).toBe("owned");
  });

  test("aired and monitored is `wanted` -- Sonarr is already looking", () => {
    // No per-row request button here on purpose: pressing it would repeat a running search.
    expect(episodeStanding(state({ monitored: true }), TODAY)).toBe("wanted");
  });

  test("aired and unmonitored is the ONE state a per-row request button belongs in", () => {
    expect(episodeStanding(state(), TODAY)).toBe("missing");
  });

  test("an episode that has not aired is unknown, not missing", () => {
    // Otherwise every future episode of every airing show would wear a Request button for
    // a file that does not exist anywhere yet.
    expect(episodeStanding(state({ airDate: "2026-09-01" }), TODAY)).toBe("unknown");
    expect(episodeStanding(state({ airDate: null }), TODAY)).toBe("unknown");
  });

  test("today counts as aired", () => {
    expect(episodeStanding(state({ airDate: TODAY }), TODAY)).toBe("missing");
  });
});

describe("airedWithoutFile", () => {
  test("is exactly the wanted/missing pair", () => {
    expect(airedWithoutFile("wanted")).toBe(true);
    expect(airedWithoutFile("missing")).toBe(true);
    expect(airedWithoutFile("owned")).toBe(false);
    expect(airedWithoutFile("unknown")).toBe(false);
  });
});

describe("todayUtc", () => {
  test("is a plain UTC date, so it compares against a stored airDate as a string", () => {
    // Late evening in UTC+X is still the previous UTC day, and every date in this product
    // is UTC -- taking the local day here would mark an episode aired hours early.
    expect(todayUtc(new Date("2026-08-31T23:59:59.000Z"))).toBe("2026-08-31");
    expect(todayUtc(new Date("2026-09-01T00:00:01.000Z"))).toBe("2026-09-01");
  });
});

describe("missingEpisodeIdsIn", () => {
  const episode = (over: Partial<EpisodeState> & { episode: number }): EpisodeState => ({
    season: 1,
    arrEpisodeId: over.episode * 10,
    hasFile: false,
    monitored: false,
    airDate: "2025-05-28",
    ...over,
  });

  test("takes the aired episodes of THAT season with no file", () => {
    const ids = missingEpisodeIdsIn(
      [
        episode({ episode: 1, hasFile: true }),
        episode({ episode: 2 }),
        episode({ episode: 3 }),
        episode({ episode: 1, season: 2 }),
      ],
      [1],
      TODAY,
    );
    expect(ids).toEqual([20, 30]);
  });

  test("INCLUDES the ones Sonarr is already searching for", () => {
    // This is the whole difference between the season grain and the per-row one: the
    // summary counts `wanted` as a hole, so the button must fetch it or the two disagree.
    expect(missingEpisodeIdsIn([episode({ episode: 4, monitored: true })], [1], TODAY)).toEqual([40]);
  });

  test("never asks for an episode that has not aired", () => {
    const states = [episode({ episode: 5, airDate: "2026-09-01" }), episode({ episode: 6, airDate: null })];
    expect(missingEpisodeIdsIn(states, [1], TODAY)).toEqual([]);
  });

  test("comes back in broadcast order whatever order the mirror was read in", () => {
    const states = [episode({ episode: 9 }), episode({ episode: 2 }), episode({ episode: 10 })];
    expect(missingEpisodeIdsIn(states, [1], TODAY)).toEqual([20, 90, 100]);
  });

  test("a season we hold in full is an empty list, not a partial one", () => {
    const states = [episode({ episode: 1, hasFile: true }), episode({ episode: 2, hasFile: true })];
    expect(missingEpisodeIdsIn(states, [1], TODAY)).toEqual([]);
  });

  test("several seasons come back in broadcast order across the whole selection", () => {
    // The reader ticked 3 and then 2; the show still happened in the other order, and so
    // does the queue.
    const states = [
      episode({ episode: 2, season: 3 }),
      episode({ episode: 1, season: 2 }),
      episode({ episode: 1, season: 3 }),
    ];
    const ids = missingEpisodeIdsIn(states, [3, 2], TODAY);
    expect(ids).toEqual([
      states[1]?.arrEpisodeId as number,
      states[2]?.arrEpisodeId as number,
      states[0]?.arrEpisodeId as number,
    ]);
  });

  test("a season in the selection with nothing to fetch is dropped, not refused", () => {
    const states = [episode({ episode: 1, season: 1, hasFile: true }), episode({ episode: 1, season: 2 })];
    expect(missingEpisodeIdsIn(states, [1, 2], TODAY)).toEqual([10]);
  });

  test("a season nobody has heard of contributes nothing", () => {
    expect(missingEpisodeIdsIn([episode({ episode: 1 })], [9], TODAY)).toEqual([]);
  });
});

describe("seasonsWithMissing", () => {
  const episode = (over: Partial<EpisodeState> & { episode: number }): EpisodeState => ({
    season: 1,
    arrEpisodeId: over.episode * 10,
    hasFile: false,
    monitored: false,
    airDate: "2025-05-28",
    ...over,
  });

  test("names only the seasons that actually had a hole", () => {
    // The reader asked for 1-3; season 2 was already complete, so the answer says so
    // rather than echoing the question back.
    const states = [
      episode({ episode: 1, season: 1 }),
      episode({ episode: 1, season: 2, hasFile: true }),
      episode({ episode: 1, season: 3 }),
    ];
    expect(seasonsWithMissing(states, [1, 2, 3], TODAY)).toEqual([1, 3]);
  });

  test("counts a season once however many episodes are missing from it", () => {
    const states = [episode({ episode: 1, season: 4 }), episode({ episode: 2, season: 4 })];
    expect(seasonsWithMissing(states, [4], TODAY)).toEqual([4]);
  });

  test("agrees with the id list about which seasons are owed", () => {
    const states = [episode({ episode: 1, season: 2 }), episode({ episode: 1, season: 5, hasFile: true })];
    const seasons = seasonsWithMissing(states, [2, 5], TODAY);
    const ids = missingEpisodeIdsIn(states, [2, 5], TODAY);
    expect(seasons.length > 0).toBe(ids.length > 0);
    expect(seasons).toEqual([2]);
  });
});

describe("hasMissingEpisodes", () => {
  const episode = (over: Partial<EpisodeState> & { episode: number }): EpisodeState => ({
    season: 1,
    arrEpisodeId: over.episode * 10,
    hasFile: false,
    monitored: false,
    airDate: "2025-05-28",
    ...over,
  });

  test("a series with an aired episode we lack has a hole", () => {
    expect(hasMissingEpisodes([episode({ episode: 1, hasFile: true }), episode({ episode: 2 })], TODAY)).toBe(
      true,
    );
  });

  test("a series we hold in full has none", () => {
    expect(hasMissingEpisodes([episode({ episode: 1, hasFile: true })], TODAY)).toBe(false);
  });

  test("SPECIALS DO NOT COUNT -- a complete show never grows a Request button for them", () => {
    // Burn Notice's seven behind-the-scenes clips are exactly this shape, and `seriesGap`
    // skips season 0 for the same reason. If these two disagreed, the header would offer a
    // dialog with nothing to tick.
    const states = [episode({ episode: 1, hasFile: true }), episode({ episode: 1, season: 0 })];
    expect(hasMissingEpisodes(states, TODAY)).toBe(false);
  });

  test("an unaired episode is not a hole", () => {
    expect(hasMissingEpisodes([episode({ episode: 1, airDate: "2026-09-01" })], TODAY)).toBe(false);
  });

  test("a series Sonarr does not hold has nothing to say", () => {
    expect(hasMissingEpisodes([], TODAY)).toBe(false);
  });
});
