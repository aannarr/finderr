import { describe, expect, test } from "bun:test";
import type { Season } from "./facets";
import type { SeasonGap } from "./season-gap";
import {
  allSeasonNumbers,
  defaultSelection,
  episodesInSelection,
  fillSelection,
  formatSeasonRanges,
  isEverySeason,
  missingInSeason,
  seasonsFromNumbers,
  summariseSeasons,
  toggleSeason,
} from "./season-select";

function season(number: number): Season {
  return { number, name: null, episodeCount: null, premiereDate: null, endDate: null, image: null };
}

/** Game of Thrones as skyhook actually returns it: 8 real seasons plus the specials. */
const GOT = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(season);

describe("defaultSelection", () => {
  test("ticks every real season and leaves the specials alone", () => {
    // Sonarr's own lookup returns season 0 unmonitored and the rest monitored, so this
    // is its default rather than one we invented.
    expect(defaultSelection(GOT)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("a series with only specials selects nothing", () => {
    expect(defaultSelection([season(0)])).toEqual([]);
  });

  test("is sorted regardless of the order seasons arrive in", () => {
    expect(defaultSelection([season(3), season(1), season(2)])).toEqual([1, 2, 3]);
  });
});

describe("toggleSeason", () => {
  test("adds a season and keeps the list sorted", () => {
    expect(toggleSeason([1, 3], 2)).toEqual([1, 2, 3]);
  });

  test("removes one that is already there", () => {
    expect(toggleSeason([1, 2, 3], 2)).toEqual([1, 3]);
  });

  test("specials toggle like anything else -- 0 is not falsy here", () => {
    // The bug this pins: `chosen.includes(0)` is correct but `if (season)` is not, and
    // season 0 is the one value where the two disagree.
    expect(toggleSeason([1], 0)).toEqual([0, 1]);
    expect(toggleSeason([0, 1], 0)).toEqual([1]);
  });

  test("does not mutate its input", () => {
    const before = [1, 2];
    toggleSeason(before, 3);
    expect(before).toEqual([1, 2]);
  });
});

describe("formatSeasonRanges", () => {
  test.each([
    [[1, 2, 3], "1-3"],
    [[1, 3, 5], "1, 3, 5"],
    [[1, 2, 3, 5], "1-3, 5"],
    [[2], "2"],
    [[1, 2, 4, 5, 6, 9], "1-2, 4-6, 9"],
    [[], ""],
  ])("%j -> %s", (input, expected) => {
    expect(formatSeasonRanges(input)).toBe(expected);
  });

  test("sorts and deduplicates before collapsing", () => {
    expect(formatSeasonRanges([3, 1, 2, 2])).toBe("1-3");
  });
});

describe("summariseSeasons", () => {
  test("nothing chosen reads as 'all seasons', which is a real answer", () => {
    expect(summariseSeasons(null)).toBe("all seasons");
    expect(summariseSeasons([])).toBe("all seasons");
  });

  test("one season is singular", () => {
    expect(summariseSeasons([2])).toBe("Season 2");
  });

  test("a run is collapsed", () => {
    expect(summariseSeasons([1, 2, 3])).toBe("Seasons 1-3");
  });

  test("specials are named, never numbered", () => {
    // "Season 0" is an id. Nobody calls it that.
    expect(summariseSeasons([0, 1, 2])).toBe("Seasons 1-2 + specials");
  });

  test("specials alone say so rather than reading as 'Seasons '", () => {
    expect(summariseSeasons([0])).toBe("specials only");
  });
});

describe("isEverySeason", () => {
  test("true when the selection names all of them, specials included", () => {
    expect(isEverySeason(allSeasonNumbers(GOT), GOT)).toBe(true);
  });

  test("the default selection is NOT every season, because specials are out", () => {
    // Worth pinning: it is why the button can honestly say "Request Seasons 1-8"
    // rather than "Request all" on first open.
    expect(isEverySeason(defaultSelection(GOT), GOT)).toBe(false);
  });

  test("false when one is missing", () => {
    expect(isEverySeason([1, 2], [season(1), season(2), season(3)])).toBe(false);
  });

  test("no seasons at all is not 'every season'", () => {
    expect(isEverySeason([], [])).toBe(false);
  });
});

/**
 * The fill-mode half: what the chooser ticks and counts over a series we already hold.
 *
 * The gaps below are Burn Notice's real reading on the day this was built -- season 1
 * complete, season 2 two short, seasons 3 to 7 entirely absent.
 */
describe("fillSelection", () => {
  const BURN: SeasonGap[] = [
    { season: 1, holding: "complete", missing: 0 },
    { season: 2, holding: "partial", missing: 2 },
    { season: 3, holding: "partial", missing: 16 },
    { season: 4, holding: "partial", missing: 18 },
  ];

  test("ticks the seasons with a hole and nothing else", () => {
    expect(fillSelection(BURN)).toEqual([2, 3, 4]);
  });

  test("a season we hold in full is NOT ticked -- that would re-search what we have", () => {
    expect(fillSelection(BURN)).not.toContain(1);
  });

  test("a season still airing is not a hole, so it is left alone", () => {
    // `current` means we hold everything broadcast so far. Sonarr is already monitoring
    // the rest, and ticking it would search for episodes that do not exist yet.
    const gap: SeasonGap[] = [{ season: 9, holding: "current", missing: 0 }];
    expect(fillSelection(gap)).toEqual([]);
  });

  test("comes back sorted whatever order the gap was built in", () => {
    const gap: SeasonGap[] = [
      { season: 7, holding: "partial", missing: 1 },
      { season: 2, holding: "partial", missing: 1 },
    ];
    expect(fillSelection(gap)).toEqual([2, 7]);
  });

  test("a series with nothing missing ticks nothing", () => {
    expect(fillSelection([{ season: 1, holding: "complete", missing: 0 }])).toEqual([]);
  });
});

describe("episodesInSelection", () => {
  const GAP: SeasonGap[] = [
    { season: 1, holding: "complete", missing: 0 },
    { season: 2, holding: "partial", missing: 2 },
    { season: 3, holding: "partial", missing: 16 },
  ];

  test("adds up only the seasons that are ticked", () => {
    expect(episodesInSelection(GAP, [2, 3])).toBe(18);
    expect(episodesInSelection(GAP, [2])).toBe(2);
  });

  test("a ticked season with no hole contributes nothing rather than erroring", () => {
    // The server drops it the same way, and the two must agree about what a redundant
    // tick means or the button offers a number the queue will not honour.
    expect(episodesInSelection(GAP, [1, 2])).toBe(2);
  });

  test("nothing ticked is zero, which is what disables the confirm", () => {
    expect(episodesInSelection(GAP, [])).toBe(0);
  });

  test("a season the gap has never heard of is ignored", () => {
    expect(episodesInSelection(GAP, [99])).toBe(0);
  });
});

describe("missingInSeason", () => {
  const GAP: SeasonGap[] = [
    { season: 1, holding: "complete", missing: 0 },
    { season: 2, holding: "partial", missing: 2 },
  ];

  test("a season with a hole wears its count", () => {
    expect(missingInSeason(GAP, 2)).toBe(2);
  });

  test("a complete season wears NO number -- '0' would read as a count", () => {
    expect(missingInSeason(GAP, 1)).toBeUndefined();
  });

  test("a season outside the gap wears nothing", () => {
    expect(missingInSeason(GAP, 9)).toBeUndefined();
  });
});

describe("seasonsFromNumbers", () => {
  test("builds a chip-able season for every number, sorted and deduplicated", () => {
    // The episode mirror lists one row per EPISODE, so the same season arrives many times.
    expect(seasonsFromNumbers([3, 1, 3, 2, 1]).map((s) => s.number)).toEqual([1, 2, 3]);
  });

  test("every field but the number is null, which is what skyhook-less seasons look like", () => {
    const [first] = seasonsFromNumbers([1]);
    expect(first).toEqual({
      number: 1,
      name: null,
      episodeCount: null,
      premiereDate: null,
      endDate: null,
      image: null,
    });
  });

  test("no numbers is no seasons", () => {
    expect(seasonsFromNumbers([])).toEqual([]);
  });
});
