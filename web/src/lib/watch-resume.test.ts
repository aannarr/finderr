import { describe, expect, test } from "bun:test";
import type { Episode } from "./facets";
import type { WatchEntry, WatchState } from "./watch-api";
import {
  episodeTitleLine,
  headerResume,
  nextEpisode,
  progressFraction,
  RESUME_MIN_SEC,
  resumeFor,
  watchIndex,
} from "./watch-resume";

const entry = (over: Partial<WatchEntry>): WatchEntry => ({
  tconst: "tt1",
  season: null,
  episode: null,
  positionSec: 2530,
  durationSec: 5800,
  finished: false,
  updatedAt: "2026-09-15T10:00:00Z",
  ...over,
});

const ep = (season: number, number: number, title: string | null = null): Episode => ({
  season,
  number,
  title,
  airDate: null,
  overview: null,
  image: null,
  runtime: null,
});

describe("where to resume", () => {
  test("a film resumes from its own entry", () => {
    const state: WatchState = { resume: entry({}), episodes: [] };
    expect(resumeFor(state, {})).toBe(2530);
  });

  test("an episode resumes from ITS entry, not from the title's most recent one", () => {
    const e = entry({ season: 1, episode: 2, positionSec: 400 });
    const state: WatchState = { resume: entry({ season: 1, episode: 3, positionSec: 900 }), episodes: [e] };
    expect(resumeFor(state, { season: 1, episode: 2 })).toBe(400);
    expect(resumeFor(state, { season: 1, episode: 4 })).toBeNull();
  });

  test("the opening seconds and a finished title start from the top", () => {
    expect(resumeFor({ resume: entry({ positionSec: RESUME_MIN_SEC - 1 }), episodes: [] }, {})).toBeNull();
    expect(resumeFor({ resume: entry({ finished: true }), episodes: [] }, {})).toBeNull();
    expect(resumeFor(null, {})).toBeNull();
  });

  test("a film is not resumed from an episode's entry", () => {
    expect(resumeFor({ resume: entry({ season: 1, episode: 1 }), episodes: [] }, {})).toBeNull();
  });

  test("the header offers the most recent unfinished entry", () => {
    const last = entry({ season: 2, episode: 4, positionSec: 600 });
    expect(headerResume({ resume: last, episodes: [last] })).toEqual(last);
    expect(headerResume({ resume: entry({ finished: true }), episodes: [] })).toBeNull();
  });
});

describe("the next episode", () => {
  const episodes = [ep(2, 1), ep(1, 2), ep(0, 1, "Special"), ep(1, 1), ep(1, 3)];

  test("the next number in the season", () => {
    expect(nextEpisode(episodes, { season: 1, episode: 1 })).toEqual(ep(1, 2));
  });

  test("across into the next season, whatever order the facet sent", () => {
    expect(nextEpisode(episodes, { season: 1, episode: 3 })).toEqual(ep(2, 1));
  });

  test("never into season 0, and nothing after the last one", () => {
    expect(nextEpisode([ep(1, 1), ep(0, 1)], { season: 1, episode: 1 })).toBeNull();
    expect(nextEpisode(episodes, { season: 2, episode: 1 })).toBeNull();
  });

  test("an episode we cannot play is skipped rather than offered", () => {
    expect(nextEpisode(episodes, { season: 1, episode: 1 }, (s, e) => !(s === 1 && e === 2))).toEqual(
      ep(1, 3),
    );
  });

  test("its line reads like the top bar", () => {
    expect(episodeTitleLine(ep(1, 3, "The Dragon's Nest"))).toBe("S1E3 · The Dragon's Nest");
    expect(episodeTitleLine(ep(1, 4))).toBe("S1E4 · Episode 4");
  });
});

describe("a row's progress", () => {
  test("a fraction while partway, nothing when unstarted or finished", () => {
    expect(progressFraction(entry({ positionSec: 1450, durationSec: 5800 }))).toBe(0.25);
    expect(progressFraction(entry({ finished: true }))).toBeNull();
    expect(progressFraction(undefined)).toBeNull();
  });

  test("entries are keyed on the rows' season:episode pair", () => {
    const e = entry({ season: 3, episode: 7 });
    expect(watchIndex([e]).get("3:7")).toBe(e);
  });
});
