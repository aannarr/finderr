import { describe, expect, test } from "bun:test";
import { countRows } from "./bench-scenarios";
import type { PersonPage } from "./people";
import type { BrowseResult, SearchResult } from "./search";

/**
 * The `rows` column is the harness's only defence against a query that got faster by
 * returning less, and it was blind for a sixth of the suite until 2026-09-07.
 *
 * `countRows` understood `rows`, `results` and `credits` and fell through to `1` for anything
 * else. A `SearchResult` carries its rows under `hits`, so all six `search.*` scenarios
 * reported exactly one row whatever came back -- including `search.fuzzy`, which on macOS
 * returned ZERO and was printed as one. Nothing was red; the number was simply wrong.
 */
describe("countRows", () => {
  /*
    The field names, pinned to the real types rather than typed out as strings.

    Rename `SearchResult.hits` and this file stops COMPILING, which is the cheapest thing that
    can keep `ROW_KEYS` honest -- the alternative is constructing an engine and an index just
    to discover that a key was renamed.
  */
  const SEARCH_ROWS: keyof SearchResult = "hits";
  const BROWSE_ROWS: keyof BrowseResult = "rows";
  const PERSON_ROWS: keyof PersonPage = "credits";

  test("counts a SearchResult's hits -- the regression", () => {
    expect(countRows({ [SEARCH_ROWS]: [1, 2, 3], tier: "exact", candidates: 3 })).toBe(3);
  });

  test("a search that found NOTHING counts zero, not one", () => {
    // The whole point. `search.fuzzy` against an unloaded spellfix1 returns `tier: "empty"`
    // with no hits, and reporting that as one row is what made an absent tier look measured.
    expect(countRows({ [SEARCH_ROWS]: [], tier: "empty", candidates: 0 })).toBe(0);
  });

  test("counts a BrowseResult's rows, ignoring its total", () => {
    expect(countRows({ [BROWSE_ROWS]: [1, 2], total: 4_000 })).toBe(2);
  });

  test("counts a PersonPage's credits, not its category tally", () => {
    // Two arrays, and only one of them is the answer. The order of ROW_KEYS is what decides.
    expect(countRows({ [PERSON_ROWS]: [1, 2, 3], categories: [{ category: "actor", count: 3 }] })).toBe(3);
  });

  test("a bare array is its own length, and a missing result is zero rows", () => {
    expect(countRows(["Drama", "Comedy"])).toBe(2);
    expect(countRows([])).toBe(0);
    expect(countRows(null)).toBe(0);
    expect(countRows(undefined)).toBe(0);
  });

  test("a single object with no array in it is one row", () => {
    // `byTconst` returns a title and `idsFor` returns one title's ids. Both genuinely are
    // one row, and the guard below must not mistake either for an unknown shape.
    expect(countRows({ tconst: "tt0111161", title: "The Shawshank Redemption", genres: "Drama" })).toBe(1);
    expect(countRows({ tmdb: 278, tvdb: null })).toBe(1);
  });

  test("an array under a name ROW_KEYS does not have THROWS rather than reporting 1", () => {
    // The failure this replaces was silent and permanent. A new result shape must cost an
    // entry in ROW_KEYS, and the only way to make that a step nobody skips is to fail loudly.
    expect(() => countRows({ awards: [1, 2, 3], total: 3 })).toThrow(/awards/);
    expect(() => countRows({ awards: [] })).toThrow(/ROW_KEYS/);
  });
});
