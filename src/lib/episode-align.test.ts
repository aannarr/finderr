/**
 * The alignment, against the three shapes the lab found and one it must not break.
 *
 * Every fixture here is REAL -- the season lengths, the titles and the divergences were read
 * off skyhook and the index on 2026-09-07, not invented. That matters more than usual for
 * this module: the whole class of bug is "the obvious rule looks right on made-up data", and
 * a fixture somebody imagined would have agreed with the broken join.
 */

import { describe, expect, test } from "bun:test";
import {
  alignEpisodes,
  foldEpisodeTitle,
  type IndexEpisode,
  type SkeletonEpisode,
  titleKeys,
} from "./episode-align";

function sky(season: number, number: number, title: string | null): SkeletonEpisode {
  return { season, number, title };
}
function idx(season: number, number: number, title: string | null, rating: number | null): IndexEpisode {
  return { season, number, title, rating, votes: rating === null ? 0 : 100 };
}

/** What the grid would draw at one skeleton coordinate. */
function at(rows: ReturnType<typeof alignEpisodes>, season: number, number: number) {
  return rows.find((r) => r.season === season && r.number === number) ?? null;
}

describe("the shapes already agree", () => {
  const skeleton = [sky(1, 1, "Pilot"), sky(1, 2, "Second"), sky(1, 3, "Third")];
  const index = [idx(1, 1, "Pilot", 8.1), idx(1, 2, "Second", 7.4), idx(1, 3, "Third", 9.0)];

  test("every episode keeps its own score", () => {
    const rows = alignEpisodes(skeleton, index);
    expect(rows.map((r) => r.rating)).toEqual([8.1, 7.4, 9.0]);
  });

  test("nothing is marked as a part of anything", () => {
    expect(alignEpisodes(skeleton, index).every((r) => r.part === undefined)).toBe(true);
  });
});

describe("a split double episode -- Star Trek: The Next Generation, season 1", () => {
  /*
    Real and measured. TVDB numbers the feature-length pilot as two slots, IMDb keeps one
    row, and the old join therefore slid EVERY later episode of the whole series by one:
    24 cells drew the previous episode's rating and the grid looked entirely normal.
  */
  const skeleton = [
    sky(1, 1, "Encounter at Farpoint (1)"),
    sky(1, 2, "Encounter at Farpoint (2)"),
    sky(1, 3, "The Naked Now"),
    sky(1, 4, "Code of Honor"),
    sky(1, 5, "The Last Outpost"),
  ];
  const index = [
    idx(1, 1, "Encounter at Farpoint", 7.6),
    idx(1, 2, "The Naked Now", 6.6),
    idx(1, 3, "Code of Honor", 5.4),
    idx(1, 4, "The Last Outpost", 6.2),
  ];

  test("the shifted episodes get their OWN score, not the previous one's", () => {
    const rows = alignEpisodes(skeleton, index);
    expect(at(rows, 1, 3)?.rating).toBe(6.6); // The Naked Now, not Farpoint
    expect(at(rows, 1, 4)?.rating).toBe(5.4);
    expect(at(rows, 1, 5)?.rating).toBe(6.2);
  });

  test("the old naive join is what this test would have caught", () => {
    // Pinned so the fixture cannot quietly stop reproducing the bug it was written for.
    const naive = skeleton.map((s) => index.find((i) => i.season === s.season && i.number === s.number));
    expect(naive[2]?.rating).toBe(5.4); // S1E3 would have drawn Code of Honor's score
  });

  test("both halves of the double carry the score and say which part they are", () => {
    const rows = alignEpisodes(skeleton, index);
    expect(at(rows, 1, 1)).toMatchObject({ rating: 7.6, part: { index: 1, total: 2 } });
    expect(at(rows, 1, 2)).toMatchObject({ rating: 7.6, part: { index: 2, total: 2 } });
  });

  test("an episode that is not part of a double carries no part marker", () => {
    expect(at(alignEpisodes(skeleton, index), 1, 3)?.part).toBeUndefined();
  });
});

describe("a marked pair that is NOT a double -- The X-Files, Dreamland", () => {
  /*
    Found by scoring the shipped code against the oracle, and it cost 5 of 5,048 cells.
    TVDB writes `Dreamland (1)` and `(2)`; IMDb writes `Dreamland` and `Dreamland II`. BOTH
    sources hold two episodes -- they only spell the second differently -- so collapsing the
    pair mapped both slots onto `Dreamland` and stranded `Dreamland II` entirely.

    A part marker is therefore not itself evidence of a split. The index side has to be
    missing the episodes before a run may collapse, and the count is by PREFIX because
    `II`, `: Episode II` and `, Part Two` are three spellings no suffix pattern should chase.
  */
  const skeleton = [
    sky(6, 4, "Dreamland (1)"),
    sky(6, 5, "Dreamland (2)"),
    sky(6, 6, "How the Ghosts Stole Christmas"),
  ];
  const index = [
    idx(6, 4, "Dreamland", 7.9),
    idx(6, 5, "Dreamland II", 8.0),
    idx(6, 6, "How the Ghosts Stole Christmas", 8.3),
  ];

  test("each part keeps its OWN score", () => {
    const rows = alignEpisodes(skeleton, index);
    expect(at(rows, 6, 4)?.rating).toBe(7.9);
    expect(at(rows, 6, 5)?.rating).toBe(8.0);
  });

  test("and neither is marked as part of a double, because it is not one", () => {
    const rows = alignEpisodes(skeleton, index);
    expect(at(rows, 6, 4)?.part).toBeUndefined();
    expect(at(rows, 6, 5)?.part).toBeUndefined();
  });

  test("the same shape spelled `: Episode II` -- South Park's Imaginationland", () => {
    const rows = alignEpisodes(
      [
        sky(11, 10, "Imaginationland (1)"),
        sky(11, 11, "Imaginationland (2)"),
        sky(11, 12, "Imaginationland (3)"),
      ],
      [
        idx(11, 10, "Imaginationland", 8.6),
        idx(11, 11, "Imaginationland: Episode II", 8.5),
        idx(11, 12, "Imaginationland: Episode III", 8.7),
      ],
    );
    expect(rows.map((r) => r.rating)).toEqual([8.6, 8.5, 8.7]);
    expect(rows.every((r) => r.part === undefined)).toBe(true);
  });

  test("but a run the index genuinely lacks DOES collapse", () => {
    // One index row against two marked slots: a real split, and the part marks say so.
    const rows = alignEpisodes(
      [sky(1, 1, "The Pilot (1)"), sky(1, 2, "The Pilot (2)"), sky(1, 3, "Next")],
      [idx(1, 1, "The Pilot", 8.4), idx(1, 2, "Next", 7.0)],
    );
    expect(at(rows, 1, 1)).toMatchObject({ rating: 8.4, part: { index: 1, total: 2 } });
    expect(at(rows, 1, 2)).toMatchObject({ rating: 8.4, part: { index: 2, total: 2 } });
    expect(at(rows, 1, 3)?.rating).toBe(7.0);
  });
});

describe("a whole-run repartition -- Futurama", () => {
  /*
    The report that started this. IMDb's season 6 is the four DVD films split into sixteen
    parts; TVDB files those as specials and calls the 2010 Comedy Central run season 6. So
    the S6 column drew `Bender's Big Score: Part 1-4` ratings under `Rebirth`, `In-A-Gadda-
    Da-Leela` and friends -- and S6E1 agreed by coincidence, which is how it hid.
  */
  const skeleton = [
    sky(6, 1, "Rebirth"),
    sky(6, 2, "In-A-Gadda-Da-Leela"),
    sky(6, 3, "Attack of the Killer App!"),
    sky(6, 4, "Proposition Infinity"),
  ];
  const index = [
    idx(6, 1, "Bender's Big Score: Part 1", 7.8),
    idx(6, 2, "Bender's Big Score: Part 2", 7.9),
    idx(6, 3, "Bender's Big Score: Part 3", 8.0),
    idx(6, 4, "Bender's Big Score: Part 4", 8.2),
    idx(7, 1, "Rebirth", 7.8),
    idx(7, 2, "In-A-Gadda-Da-Leela", 7.1),
    idx(7, 3, "Attack of the Killer App", 7.6),
    idx(7, 4, "Proposition Infinity", 7.2),
  ];

  test("the scores come from the episodes actually named on screen", () => {
    const rows = alignEpisodes(skeleton, index);
    expect(at(rows, 6, 2)?.rating).toBe(7.1); // In-A-Gadda-Da-Leela, NOT 7.9
    expect(at(rows, 6, 3)?.rating).toBe(7.6);
    expect(at(rows, 6, 4)?.rating).toBe(7.2);
  });

  test("the `!` on one side does not stop the match", () => {
    // `Attack of the Killer App!` vs `Attack of the Killer App` -- the fold drops both.
    expect(at(alignEpisodes(skeleton, index), 6, 3)?.rating).toBe(7.6);
  });
});

describe("a decorated title prefix -- Cowboy Bebop", () => {
  /*
    18 of the first version's 21 remaining errors were this one show: TVDB prints the
    session number in the title, IMDb does not, so nothing anchored and a differently
    ordered run was mapped onto itself positionally.
  */
  const skeleton = [
    sky(1, 1, "Session #2: Stray Dog Strut"),
    sky(1, 2, "Session #3: Honky Tonk Women"),
    sky(1, 3, "Session #7: Heavy Metal Queen"),
  ];
  const index = [
    idx(1, 1, "Asteroid Blues", 8.2),
    idx(1, 2, "Stray Dog Strut", 7.8),
    idx(1, 3, "Honky Tonk Women", 7.9),
    idx(1, 7, "Heavy Metal Queen", 8.1),
  ];

  test("the numbering prefix is stripped and the real title anchors", () => {
    const rows = alignEpisodes(skeleton, index);
    expect(at(rows, 1, 1)?.rating).toBe(7.8);
    expect(at(rows, 1, 2)?.rating).toBe(7.9);
    expect(at(rows, 1, 3)?.rating).toBe(8.1);
  });

  test("a colon in a REAL title is not mistaken for a prefix", () => {
    // The closed word list is what protects this: `Apollo` is not a numbering word.
    expect(titleKeys("Apollo 13: The Landing")).toContain(foldEpisodeTitle("Apollo 13: The Landing"));
    expect(titleKeys("Apollo 13: The Landing")).not.toContain(foldEpisodeTitle("The Landing"));
  });
});

describe("SILENCE IS NOT EVIDENCE -- Last Week Tonight with John Oliver", () => {
  /*
    The regression this module's step 6 exists to prevent, and it was MEASURED before the
    step was written: without it, 373 of this show's 377 cells went blank. Its episodes are
    titled by guest and date so nothing anchors, every run therefore reads as "unequal", and
    a strategy that refuses on silence blanks a show that was never wrong.
  */
  const skeleton = [sky(1, 1, "February 27, 2014"), sky(1, 2, "March 6, 2014"), sky(1, 3, "March 13, 2014")];
  const index = [
    idx(1, 1, "Episode #1.1", 7.9),
    idx(1, 2, "Episode #1.2", 8.0),
    idx(1, 3, "Episode #1.3", 8.1),
  ];

  test("a season with no anchors and matching lengths keeps the naive join", () => {
    const rows = alignEpisodes(skeleton, index);
    expect(rows.map((r) => r.rating)).toEqual([7.9, 8.0, 8.1]);
  });

  test("but it refuses once the lengths disagree, because now something DOES contradict it", () => {
    const rows = alignEpisodes(skeleton, [...index, idx(1, 4, "Episode #1.4", 7.0)]);
    expect(rows).toEqual([]);
  });
});

describe("refusing rather than guessing", () => {
  test("an unequal run between anchors draws nothing at all", () => {
    const skeleton = [sky(1, 1, "Start"), sky(1, 2, "Mystery"), sky(1, 3, "End")];
    const index = [idx(1, 1, "Start", 8.0), idx(1, 2, "A", 7.0), idx(1, 3, "B", 6.0), idx(1, 4, "End", 5.0)];
    const rows = alignEpisodes(skeleton, index);
    expect(at(rows, 1, 1)?.rating).toBe(8.0);
    expect(at(rows, 1, 3)?.rating).toBe(5.0);
    // Two index episodes for one skeleton slot: no honest answer, so no score.
    expect(at(rows, 1, 2)).toBeNull();
  });

  test("a title claimed twice on one side cannot anchor", () => {
    const skeleton = [sky(1, 1, "Recap"), sky(1, 2, "Recap")];
    const index = [idx(1, 1, "Recap", 5.0), idx(1, 2, "Recap", 6.0)];
    // No anchors, no season-length disagreement -> step 6 keeps the naive join.
    expect(alignEpisodes(skeleton, index).map((r) => r.rating)).toEqual([5.0, 6.0]);
  });

  test("an unrated episode keeps a null rating rather than becoming a zero", () => {
    const rows = alignEpisodes([sky(1, 1, "New")], [idx(1, 1, "New", null)]);
    expect(rows[0].rating).toBeNull();
    expect(rows[0].votes).toBe(0);
  });
});

describe("the degenerate inputs a real title page actually hands it", () => {
  test("no skeleton, no rows", () => {
    expect(alignEpisodes([], [idx(1, 1, "x", 8)])).toEqual([]);
  });

  test("an index with no episodes for this series -- the pre-stage index", () => {
    expect(alignEpisodes([sky(1, 1, "x")], [])).toEqual([]);
  });

  test("untitled on both sides falls through to the naive join", () => {
    const rows = alignEpisodes([sky(1, 1, null), sky(1, 2, null)], [idx(1, 1, null, 7), idx(1, 2, null, 8)]);
    expect(rows.map((r) => r.rating)).toEqual([7, 8]);
  });

  test("a season the index knows and the provider does not is not a disagreement", () => {
    // The grid only ever draws the provider's seasons, so IMDb knowing more is fine.
    const rows = alignEpisodes([sky(1, 1, "A")], [idx(1, 1, "A", 8), idx(2, 1, "B", 9)]);
    expect(at(rows, 1, 1)?.rating).toBe(8);
  });
});

describe("titleKeys", () => {
  test("yields the raw fold, the prefix-stripped one and the part-stripped one", () => {
    expect(titleKeys("Session #2: Stray Dog Strut")).toEqual(["session2straydogstrut", "straydogstrut"]);
    expect(titleKeys("Encounter at Farpoint (1)")).toEqual(["encounteratfarpoint1", "encounteratfarpoint"]);
    expect(titleKeys("The Fugitive, Part 2")).toContain("thefugitive");
  });

  test("nothing at all for an absent title", () => {
    expect(titleKeys(null)).toEqual([]);
    expect(titleKeys("")).toEqual([]);
    expect(titleKeys("   ")).toEqual([]);
  });
});
