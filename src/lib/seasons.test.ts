import { describe, expect, test } from "bun:test";
import { seasonSelection } from "./arr";
import { decodeSeasons, encodeSeasons, parseSeasonsInput } from "./seasons";

describe("encodeSeasons", () => {
  test("sorts and deduplicates so one selection has one spelling", () => {
    expect(encodeSeasons([3, 1, 2, 1])).toBe("1,2,3");
  });

  test("keeps season 0 -- it is the specials, not an absent value", () => {
    expect(encodeSeasons([0, 1])).toBe("0,1");
  });

  test("null, undefined and empty all mean 'the reader never chose'", () => {
    expect(encodeSeasons(null)).toBeNull();
    expect(encodeSeasons(undefined)).toBeNull();
    expect(encodeSeasons([])).toBeNull();
  });
});

describe("decodeSeasons", () => {
  test("round-trips what encodeSeasons wrote", () => {
    expect(decodeSeasons(encodeSeasons([2, 0, 5]))).toEqual([0, 2, 5]);
  });

  test("a request written before the column existed reads as 'all'", () => {
    expect(decodeSeasons(null)).toBeNull();
    expect(decodeSeasons("")).toBeNull();
  });

  test("never returns an empty array -- 'monitor nothing' is not a request anyone made", () => {
    expect(decodeSeasons(",,")).toBeNull();
  });
});

describe("parseSeasonsInput", () => {
  test("absent means 'all', which is not an error", () => {
    expect(parseSeasonsInput(undefined)).toEqual({ seasons: null });
    expect(parseSeasonsInput(null)).toEqual({ seasons: null });
  });

  test("normalises a good list", () => {
    expect(parseSeasonsInput([2, 1, 2])).toEqual({ seasons: [1, 2] });
  });

  test("season 0 is accepted", () => {
    expect(parseSeasonsInput([0])).toEqual({ seasons: [0] });
  });

  test("refuses an empty array rather than reading it as 'all'", () => {
    // The dangerous coercion: [] -> null would silently queue every season for a
    // reader who deselected everything.
    expect(parseSeasonsInput([])).toHaveProperty("error");
  });

  test.each([
    ["not an array", "1,2,3"],
    ["a fractional season", [1.5]],
    ["a string element", ["1"]],
    ["a negative season", [-1]],
    ["an absurd season", [99999]],
  ])("refuses %s", (_label, input) => {
    expect(parseSeasonsInput(input)).toHaveProperty("error");
  });
});

describe("seasonSelection", () => {
  const found = {
    title: "Game of Thrones",
    seasons: [
      { seasonNumber: 0, monitored: false, statistics: { episodeCount: 55 } },
      { seasonNumber: 1, monitored: true, statistics: { episodeCount: 10 } },
      { seasonNumber: 2, monitored: true, statistics: { episodeCount: 10 } },
    ],
  };

  test("no selection sends Sonarr's own policy and does not touch seasons", () => {
    // This is the pre-selector request, byte for byte. If this test moves, every
    // request made without opening the selector has changed behaviour.
    expect(seasonSelection(found, null, true)).toEqual({
      addOptions: { searchForMissingEpisodes: true, monitor: "all" },
    });
  });

  test("a selection sets monitor:none so Sonarr does not re-monitor everything", () => {
    const out = seasonSelection(found, [1], true);
    expect(out.addOptions).toEqual({ searchForMissingEpisodes: true, monitor: "none" });
  });

  test("monitors exactly the chosen seasons and unmonitors the rest", () => {
    const out = seasonSelection(found, [2], true);
    expect(out.seasons).toEqual([
      { seasonNumber: 0, monitored: false, statistics: { episodeCount: 55 } },
      { seasonNumber: 1, monitored: false, statistics: { episodeCount: 10 } },
      { seasonNumber: 2, monitored: true, statistics: { episodeCount: 10 } },
    ]);
  });

  test("preserves fields beyond seasonNumber/monitored", () => {
    // Sonarr's season objects carry more than we read; rebuilding rather than
    // rewriting would hand it a partial season.
    const out = seasonSelection(found, [1], true) as { seasons: Record<string, unknown>[] };
    expect(out.seasons[0]?.statistics).toEqual({ episodeCount: 55 });
  });

  test("specials can be chosen like any other season", () => {
    const out = seasonSelection(found, [0], true) as { seasons: { monitored: boolean }[] };
    expect(out.seasons[0]?.monitored).toBe(true);
  });

  test("a season Sonarr does not know about is ignored, never invented", () => {
    const out = seasonSelection(found, [1, 99], true) as { seasons: unknown[] };
    expect(out.seasons).toHaveLength(3);
  });

  test("searchOnAdd rides through untouched", () => {
    const out = seasonSelection(found, [1], false) as { addOptions: { searchForMissingEpisodes: boolean } };
    expect(out.addOptions.searchForMissingEpisodes).toBe(false);
  });
});
