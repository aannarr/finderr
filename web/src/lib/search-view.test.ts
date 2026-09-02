/**
 * Which of the four search-view states is on screen.
 *
 * The states only became distinguishable when the fetch was debounced -- before that the
 * window between "typed" and "answered" was a single keystroke wide. Each test below names
 * the thing a reader would see if the state were decided wrongly.
 */

import { describe, expect, test } from "bun:test";
import { isSearching, searchPhase } from "./search-view";

const KEY = 'matrix|{"genre":"Drama"}';

describe("searchPhase", () => {
  test("an empty box is idle, whatever is still painted", () => {
    // The discover shelves own the page. A result left over from before the box was
    // cleared must not keep the grid up.
    expect(searchPhase("", null, "|{}")).toBe("idle");
    expect(searchPhase("   ", KEY, "|{}")).toBe("idle");
  });

  test("painted result matching the typed query is settled", () => {
    expect(searchPhase("matrix", KEY, KEY)).toBe("settled");
  });

  test("nothing painted yet is `first`, and gets the skeleton", () => {
    // The first query of a session. Showing an empty grid here reads as "no results".
    expect(searchPhase("matrix", null, KEY)).toBe("first");
  });

  test("a painted result for an OLDER query is `refining`", () => {
    // Results are on screen and worth keeping. Swapping them for a skeleton on every
    // settled keystroke is the flicker the debounce was supposed to remove.
    expect(searchPhase("matrix reloaded", KEY, 'matrix reloaded|{"genre":"Drama"}')).toBe("refining");
  });

  test("a facet toggle with unchanged text still counts as working", () => {
    // The query text is identical and the ANSWER is not, which is exactly why the phase is
    // decided on the full key rather than on the query string.
    expect(searchPhase("matrix", KEY, 'matrix|{"genre":"Comedy"}')).toBe("refining");
  });

  test("clearing the results while typing drops back to `first`", () => {
    // `resultFor` is set to null when the seed misses on an empty cache, so a reader who
    // clears the box and types again gets the skeleton rather than a stale grid.
    expect(searchPhase("dune", null, "dune|{}")).toBe("first");
  });
});

describe("isSearching", () => {
  test("both waiting states are working, and neither settled nor idle is", () => {
    expect(isSearching("first")).toBe(true);
    expect(isSearching("refining")).toBe(true);
    expect(isSearching("settled")).toBe(false);
    expect(isSearching("idle")).toBe(false);
  });
});
