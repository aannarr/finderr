import { describe, expect, it } from "bun:test";
import {
  averageRating,
  bandFor,
  type EpisodeScore,
  episodeGrid,
  formatVotes,
  scoreIndex,
  seasonList,
  timeline,
  trendline,
} from "./episode-scores";
import type { Episode, Season } from "./facets";

function season(number: number, name: string | null = null): Season {
  return { number, name, episodeCount: null, premiereDate: null, endDate: null, image: null };
}

function episode(s: number, n: number, over: Partial<Episode> = {}): Episode {
  return {
    season: s,
    number: n,
    title: `E${n}`,
    airDate: null,
    overview: null,
    image: null,
    runtime: null,
    ...over,
  };
}

function score(s: number, n: number, rating: number | null, votes = 100): EpisodeScore {
  return { season: s, number: n, rating, votes };
}

describe("bandFor", () => {
  it("puts each score in the band its floor claims", () => {
    expect(bandFor(9.8)).toBe("cinema");
    expect(bandFor(9.7)).toBe("cinema");
    expect(bandFor(9.6)).toBe("awesome");
    expect(bandFor(9)).toBe("awesome");
    expect(bandFor(8.9)).toBe("great");
    expect(bandFor(8)).toBe("great");
    expect(bandFor(7.9)).toBe("good");
    expect(bandFor(7)).toBe("good");
    expect(bandFor(6.9)).toBe("average");
    expect(bandFor(6)).toBe("average");
    expect(bandFor(5.9)).toBe("bad");
    expect(bandFor(4)).toBe("bad");
    expect(bandFor(3.9)).toBe("garbage");
    expect(bandFor(0)).toBe("garbage");
  });

  it("gives an unrated episode NO band rather than the worst one", () => {
    // The scar: coercing null to 0 would print "Garbage" over an episode nobody has
    // watched yet -- the harshest label in the set, earned by not existing.
    expect(bandFor(null)).toBeNull();
    expect(bandFor(undefined)).toBeNull();
    expect(bandFor(Number.NaN)).toBeNull();
  });
});

describe("averageRating", () => {
  it("excludes unrated episodes instead of counting them as zero", () => {
    expect(averageRating([{ rating: 8 }, { rating: 9 }, { rating: null }])).toBe(8.5);
  });

  it("is null when nothing is rated, so a caller can print a placeholder", () => {
    expect(averageRating([{ rating: null }, { rating: null }])).toBeNull();
    expect(averageRating([])).toBeNull();
  });

  it("rounds to one decimal, matching what the reader is shown", () => {
    expect(averageRating([{ rating: 8.16 }, { rating: 7.963 }])).toBe(8.1);
  });
});

describe("scoreIndex", () => {
  it("keeps the first row for a pair, so a duplicate cannot shadow it", () => {
    const index = scoreIndex([score(1, 1, 8.2), score(1, 1, 1)]);
    expect(index.get("1:1")?.rating).toBe(8.2);
  });

  it("tolerates no scores at all", () => {
    expect(scoreIndex(undefined).size).toBe(0);
  });
});

describe("episodeGrid", () => {
  const seasons = [season(1), season(2)];
  const episodes = [episode(1, 1), episode(1, 2), episode(1, 3), episode(2, 1), episode(2, 2)];

  it("gives a column per season and a row per episode number of the longest season", () => {
    const grid = episodeGrid(seasons, episodes, []);
    expect(grid.columns.map((c) => c.label)).toEqual(["S1", "S2"]);
    expect(grid.rows).toEqual([1, 2, 3]);
  });

  it("pads a short season with nulls rather than staggering its rows", () => {
    const grid = episodeGrid(seasons, episodes, []);
    const s2 = grid.columns[1];
    expect(s2.cells[2]).toBeNull();
    expect(s2.cells[0]?.number).toBe(1);
  });

  it("joins scores on the (season, number) pair", () => {
    const grid = episodeGrid(seasons, episodes, [score(1, 2, 9.3, 5546)]);
    expect(grid.columns[0].cells[1]?.rating).toBe(9.3);
    expect(grid.columns[0].cells[1]?.votes).toBe(5546);
    expect(grid.columns[0].cells[1]?.band).toBe("awesome");
  });

  it("keeps an episode with NO score, because that is what an unaired cell is", () => {
    // Measured against the real dumps: IMDb has no row for an episode that has not
    // aired. Walking the scores instead of the skeleton would drop this cell entirely
    // and the grid would silently lose its whole last column.
    const grid = episodeGrid(seasons, episodes, [score(1, 1, 8.2)]);
    const unrated = grid.columns[0].cells[2];
    expect(unrated).not.toBeNull();
    expect(unrated?.rating).toBeNull();
    expect(unrated?.band).toBeNull();
  });

  it("leaves a hole rather than shifting later episodes up when one is missing", () => {
    const gappy = [episode(1, 1), episode(1, 3)];
    const grid = episodeGrid([season(1)], gappy, []);
    expect(grid.rows).toEqual([1, 2, 3]);
    expect(grid.columns[0].cells[1]).toBeNull();
    expect(grid.columns[0].cells[2]?.number).toBe(3);
  });

  it("leaves the SPECIALS out of the grid entirely", () => {
    /*
      Measured in a browser on 2026-09-05, and it is why this rule exists. Rick and Morty's
      season 0 carries 187 entries -- shorts, recaps, behind-the-scenes clips -- against a
      longest real season of 11. Because the grid is as tall as its longest column, one
      specials season turned an 11-row shape into a 187-row one, 94% of it empty, and the
      thing the grid exists to show was pushed off the screen.

      Specials are not part of a show's shape. They stay reachable in the list view, which
      is one season at a time and does not pay for their length.
    */
    const grid = episodeGrid([season(0), season(1)], [episode(0, 1), episode(0, 187), episode(1, 1)], []);
    expect(grid.columns.map((c) => c.label)).toEqual(["S1"]);
    expect(grid.rows).toEqual([1]);
  });

  it("draws nothing at all for a series that is only specials", () => {
    const grid = episodeGrid([season(0)], [episode(0, 1)], []);
    expect(grid.columns).toEqual([]);
    expect(grid.rows).toEqual([]);
  });

  it("averages each column over its rated episodes only", () => {
    const grid = episodeGrid(seasons, episodes, [score(1, 1, 8), score(1, 2, 9)]);
    expect(grid.columns[0].average).toBe(8.5);
    expect(grid.columns[0].averageBand).toBe("great");
    expect(grid.columns[1].average).toBeNull();
    expect(grid.columns[1].averageBand).toBeNull();
  });

  it("survives a series with no episodes at all", () => {
    const grid = episodeGrid([season(1)], [], []);
    expect(grid.rows).toEqual([]);
    expect(grid.columns[0].cells).toEqual([]);
  });

  it("CLAMPS the height, and says how many rows it held back", () => {
    // Even with the specials gone a real season can be enormous -- a daily soap, a
    // long-run anime cour. The grid is as tall as its longest column, so the height has
    // to be bounded by the component rather than by the data.
    const episodes = Array.from({ length: 120 }, (_, i) => episode(1, i + 1));
    const grid = episodeGrid([season(1)], episodes, [], 30);
    expect(grid.rows).toHaveLength(30);
    expect(grid.rows.at(-1)).toBe(30);
    expect(grid.columns[0].cells).toHaveLength(30);
    expect(grid.hiddenRows).toBe(90);
  });

  it("hides nothing when the grid already fits", () => {
    const grid = episodeGrid(seasons, episodes, [], 30);
    expect(grid.hiddenRows).toBe(0);
  });

  it("averages over the WHOLE season, not just the rows on screen", () => {
    // The clamp is a rendering limit. An average that changed when the reader pressed
    // "show all" would be two different answers to one question.
    const eps = Array.from({ length: 4 }, (_, i) => episode(1, i + 1));
    const scores = [score(1, 1, 10), score(1, 2, 10), score(1, 3, 2), score(1, 4, 2)];
    expect(episodeGrid([season(1)], eps, scores, 2).columns[0].average).toBe(6);
  });
});

describe("seasonList", () => {
  it("returns one season's episodes in order with its average", () => {
    const episodes = [episode(1, 2), episode(1, 1), episode(2, 1)];
    const list = seasonList(episodes, [score(1, 1, 7.9), score(1, 2, 8.6)], 1);
    expect(list.episodes.map((e) => e.number)).toEqual([1, 2]);
    expect(list.average).toBe(8.3);
  });

  it("carries the still and the overview for the hover card", () => {
    const episodes = [episode(1, 1, { image: "/img/f/abc", overview: "Gotta keep it in the family." })];
    const list = seasonList(episodes, [], 1);
    expect(list.episodes[0].image).toBe("/img/f/abc");
    expect(list.episodes[0].overview).toBe("Gotta keep it in the family.");
  });
});

describe("timeline", () => {
  const seasons = [season(1), season(2)];
  const episodes = [episode(1, 1), episode(1, 2), episode(2, 1), episode(2, 2)];

  it("drops unrated episodes, because a line chart cannot draw a gap", () => {
    const t = timeline(seasons, episodes, [score(1, 1, 8), score(2, 1, 9)]);
    expect(t.points.map((p) => p.rating)).toEqual([8, 9]);
    expect(t.points.map((p) => p.x)).toEqual([0, 1]);
  });

  it("still gives an all-unrated season a band, so it keeps its place", () => {
    const t = timeline(seasons, episodes, [score(1, 1, 8), score(1, 2, 9)]);
    const s2 = t.bands.find((b) => b.season === 2);
    expect(s2).toBeDefined();
    expect(s2?.from).toBe(2);
    expect(s2?.to).toBe(2);
  });

  it("pads the y range around the data rather than pinning it to 0-10", () => {
    const t = timeline(seasons, episodes, [score(1, 1, 8.2), score(1, 2, 9.4)]);
    expect(t.min).toBe(7);
    expect(t.max).toBe(10);
  });

  it("never returns an inverted or zero-height range", () => {
    const t = timeline([season(1)], [episode(1, 1)], [score(1, 1, 10)]);
    expect(t.max).toBeGreaterThan(t.min);
  });

  it("has a usable range with no points at all", () => {
    const t = timeline([season(1)], [episode(1, 1)], []);
    expect(t.points).toEqual([]);
    expect(t.max).toBeGreaterThan(t.min);
  });
});

describe("trendline", () => {
  it("is symmetric for symmetric input, which a trailing average is not", () => {
    const t = timeline(
      [season(1)],
      [episode(1, 1), episode(1, 2), episode(1, 3)],
      [score(1, 1, 5), score(1, 2, 10), score(1, 3, 5)],
    );
    const line = trendline(t.points, 3);
    expect(line[0]).toBeCloseTo(line[2], 10);
  });

  it("crosses a step where the step is, rather than after it", () => {
    // The property that separates a centred window from a trailing one. Input steps
    // between index 2 and 3; the trendline must cross the halfway value in that same
    // gap. A trailing average would still be at the old level at index 3.
    const episodes = [1, 2, 3, 4, 5, 6].map((n) => episode(1, n));
    const scores = [4, 4, 4, 10, 10, 10].map((r, i) => score(1, i + 1, r));
    const line = trendline(timeline([season(1)], episodes, scores).points, 3);
    expect(line[2]).toBeLessThan(7);
    expect(line[3]).toBeGreaterThan(7);
  });

  it("shrinks the window at the ends instead of stopping short", () => {
    const t = timeline([season(1)], [episode(1, 1), episode(1, 2)], [score(1, 1, 8), score(1, 2, 9)]);
    expect(trendline(t.points, 5)).toHaveLength(2);
  });

  it("returns nothing for no points", () => {
    expect(trendline([], 5)).toEqual([]);
  });
});

describe("formatVotes", () => {
  it("groups thousands and singularises one", () => {
    expect(formatVotes(23136, "en-GB")).toBe("23,136 votes");
    expect(formatVotes(1, "en-GB")).toBe("1 vote");
  });
});
