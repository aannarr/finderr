/**
 * The five ways this scoring was wrong before it was right.
 *
 * Every case below is a bug that actually shipped in the exploration that designed
 * `breakout.ts`, and every one of them was SILENT: the score was not wrong, the title was
 * simply absent, which on a shelf is indistinguishable from "nothing there qualified".
 *
 * > [!IMPORTANT] Two of these were found by aannarr naming titles, not by reading code
 * > He asked how `The Bridge` (Bron/Broen, `da,sv`) and `Beck` (Swedish, no language tag at
 * > all) scored. Neither was scored at all, for two different reasons, and between them they
 * > accounted for **12,224 of the 65,142 titles clearing the browse floor -- 18.8%**, none of
 * > which anything reported. That is the whole argument for these tests existing: the failure
 * > mode here is a quiet absence, so only a fixture naming the shape can catch it.
 *
 * Each was proved RED against `breakout.ts` before being trusted green.
 */

import { describe, expect, test } from "bun:test";
import {
  type BreakoutRow,
  breakoutCutoff,
  isLocalMarket,
  localeKeys,
  MIN_STRATUM,
  scoreBreakout,
} from "./breakout";

/** A stratum's worth of unremarkable titles, so a median has something to be the middle of. */
function filler(
  n: number,
  over: Partial<BreakoutRow> & Pick<BreakoutRow, "country">,
  startId = 1000,
): BreakoutRow[] {
  return Array.from({ length: n }, (_, i) => ({
    rowid: startId + i,
    year: 2015,
    kind: "movie",
    // Spread so the MAD is non-zero; a stratum of identical rows measures nothing.
    votes: 2000 + i * 50,
    rating: 6.5 + (i % 10) * 0.1,
    langs: [],
    ...over,
  }));
}

const scoreOf = (rows: BreakoutRow[], rowid: number) => scoreBreakout(rows).find((s) => s.rowid === rowid);

describe("bug 1: a title in more than one language is still scored", () => {
  // Bron/Broen is `da,sv`. The first implementation took titles with EXACTLY ONE language,
  // which dropped 3,181 floor-clearing titles including the one that exposed it.
  test("a bilingual title lands in both of its language strata", () => {
    const bridge: BreakoutRow = {
      rowid: 1,
      year: 2011,
      kind: "tvSeries",
      votes: 85442,
      rating: 8.6,
      country: "DE,DK,SE",
      langs: ["da", "sv"],
    };
    expect(localeKeys(bridge)).toEqual(["l:da", "l:sv"]);

    const rows = [
      bridge,
      ...filler(MIN_STRATUM, { country: "DK", langs: ["da"], kind: "tvSeries", year: 2011 }, 100),
      ...filler(MIN_STRATUM, { country: "SE", langs: ["sv"], kind: "tvSeries", year: 2011 }, 200),
    ];
    const got = scoreOf(rows, 1);
    expect(got).toBeDefined();
    // 85k votes against a ~2-3k locale median is unambiguously a breakout.
    expect(got!.reach).toBeGreaterThan(3);
  });
});

describe("bug 2: a title with no language falls back to its country", () => {
  // `Beck` carries no language row at all. 9,043 floor-clearing titles are in this state,
  // and an implementation keyed only on language scores none of them.
  test("country carries a title that language cannot", () => {
    const beck: BreakoutRow = {
      rowid: 1,
      year: 1997,
      kind: "tvSeries",
      votes: 7373,
      rating: 7.5,
      country: "SE",
      langs: [],
    };
    expect(localeKeys(beck)).toEqual(["c:SE"]);

    const rows = [beck, ...filler(MIN_STRATUM, { country: "SE", kind: "tvSeries", year: 1997 }, 100)];
    expect(scoreOf(rows, 1)).toBeDefined();
  });

  test("language WINS where both are present, because it is the sharper axis", () => {
    const row: BreakoutRow = {
      rowid: 1,
      year: 2015,
      kind: "movie",
      votes: 5000,
      rating: 7,
      country: "FR",
      langs: ["fr"],
    };
    expect(localeKeys(row)).toEqual(["l:fr"]);
  });
});

describe("bug 3: an undersized stratum climbs the ladder instead of vanishing", () => {
  // Swedish 1990s series clearing the vote floor is THIRTEEN titles on the real index, so
  // the most specific rung can never be scored and `Beck` fell out of the world entirely.
  test("too thin for (locale, decade, kind), still scored on the wider rung", () => {
    const beck: BreakoutRow = {
      rowid: 1,
      year: 1997,
      kind: "tvSeries",
      votes: 7373,
      rating: 7.5,
      country: "SE",
      langs: [],
    };
    const rows = [
      beck,
      // Thirteen Swedish 1990s series: under MIN_STRATUM, so that rung is unusable...
      ...filler(13, { country: "SE", kind: "tvSeries", year: 1997 }, 100),
      // ...but plenty of Swedish titles overall, which the last rung can use.
      ...filler(MIN_STRATUM, { country: "SE", kind: "movie", year: 1975 }, 200),
    ];
    expect(scoreOf(rows, 1)).toBeDefined();
  });

  test("a locale with nothing to compare against yields NO ROW, never a zero", () => {
    // Absent and zero are different answers: zero claims "exactly typical for its locale".
    const lonely: BreakoutRow = {
      rowid: 1,
      year: 2015,
      kind: "movie",
      votes: 9000,
      rating: 8,
      country: "IS",
      langs: ["is"],
    };
    const rows = [lonely, ...filler(MIN_STRATUM, { country: "FR", langs: ["fr"] }, 100)];
    expect(scoreOf(rows, 1)).toBeUndefined();
  });
});

describe("bug 4: a co-production credit is not where a film is from", () => {
  // Keying on country put Dune: Part One at the top of a Nordic breakout list, on the
  // strength of Norway appearing in `CA,HU,NO,US`.
  test.each([
    ["Dune: Part One", "CA,HU,NO,US"],
    ["Mission: Impossible - Fallout", "CN,FR,NO,US"],
    ["The LEGO Movie", "AU,DK,US"],
    ["a British co-production", "GB,SE"],
  ])("%s is not breaking out of anywhere", (_name, country) => {
    expect(isLocalMarket({ ...filler(1, { country })[0], country })).toBe(false);
  });

  test.each([
    ["Bron/Broen", "DE,DK,SE"],
    ["a purely Swedish title", "SE"],
  ])("%s is a local-market title", (_name, country) => {
    expect(isLocalMarket({ ...filler(1, { country })[0], country })).toBe(true);
  });

  test("a title with no country at all is NOT local -- we cannot say it broke out", () => {
    expect(isLocalMarket({ ...filler(1, { country: "" })[0], country: "" })).toBe(false);
  });

  test("the flag is scored, so the shelf filters on a column and not on a string test", () => {
    const rows = [
      {
        rowid: 1,
        year: 2021,
        kind: "movie",
        votes: 900000,
        rating: 8,
        country: "CA,HU,NO,US",
        langs: ["en"],
      },
      ...filler(MIN_STRATUM, { country: "US", langs: ["en"] }, 100),
    ];
    expect(scoreOf(rows, 1)?.local).toBe(false);
  });
});

describe("bug 5: a threshold is a percentile, because an absolute cutoff moves under you", () => {
  // `reach >= 3` was tuned against language strata. Switching to country strata changed the
  // denominator, the same literal became a different filter, and the shelf silently fell
  // from 25 candidates to 1 with every test still green.
  test("the same percentile keeps the same SHARE of a population at any scale", () => {
    const values = Array.from({ length: 1000 }, (_, i) => i / 100);
    const wide = values.map((v) => v * 37);

    const kept = (xs: number[], cut: number) => xs.filter((x) => x >= cut).length;
    expect(kept(values, breakoutCutoff(values, 0.92))).toBe(kept(wide, breakoutCutoff(wide, 0.92)));
  });

  test("an absolute literal does NOT survive the same rescale -- this is the bug", () => {
    const values = Array.from({ length: 1000 }, (_, i) => i / 100);
    const wide = values.map((v) => v * 37);
    const kept = (xs: number[], cut: number) => xs.filter((x) => x >= cut).length;
    expect(kept(values, 3)).not.toBe(kept(wide, 3));
  });

  test("an empty population clears nothing rather than inventing a number", () => {
    expect(breakoutCutoff([], 0.92)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("the two axes measure different things and must not be collapsed", () => {
  const peers = filler(MIN_STRATUM, { country: "FR", langs: ["fr"] }, 100);

  test("huge reach with an ordinary rating scores high reach and low love", () => {
    // Lupin's shape: 82x its locale, rated barely above its peers.
    const rows = [
      { rowid: 1, year: 2015, kind: "movie", votes: 160000, rating: 7.0, country: "FR", langs: ["fr"] },
      ...peers,
    ];
    const got = scoreOf(rows, 1)!;
    expect(got.reach).toBeGreaterThan(3);
    expect(got.love).toBeLessThan(got.reach);
  });

  test("love is shrunk by votes, so a tiny adoring audience does not win", () => {
    const rows = [
      { rowid: 1, year: 2015, kind: "movie", votes: 1100, rating: 9.6, country: "FR", langs: ["fr"] },
      { rowid: 2, year: 2015, kind: "movie", votes: 400000, rating: 8.6, country: "FR", langs: ["fr"] },
      ...peers,
    ];
    const scores = scoreBreakout(rows);
    const tiny = scores.find((s) => s.rowid === 1)!;
    const huge = scores.find((s) => s.rowid === 2)!;
    expect(huge.love).toBeGreaterThan(tiny.love);
  });

  test("a stratum where every title shares one rating does not divide by zero", () => {
    const flat = Array.from({ length: MIN_STRATUM }, (_, i) => ({
      rowid: 100 + i,
      year: 2015,
      kind: "movie",
      votes: 3000,
      rating: 7.0,
      country: "FR",
      langs: ["fr"],
    }));
    for (const s of scoreBreakout(flat)) {
      expect(Number.isFinite(s.love)).toBe(true);
      expect(Number.isFinite(s.reach)).toBe(true);
    }
  });
});
