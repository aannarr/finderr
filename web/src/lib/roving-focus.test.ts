/**
 * The ordinal rules behind arrow-key focus and chip type-ahead.
 *
 * Every case here is an EDGE, because the middle of a grid is the part that cannot go
 * wrong: what breaks is the last row of a short grid, the first item of a shelf, a prefix
 * that matches nothing, and the difference between one letter and three. None of it needs
 * a DOM, which is the reason these rules live apart from the hook that calls them.
 */

import { describe, expect, test } from "bun:test";
import {
  columnsInGrid,
  isTypeAheadKey,
  nextRovingIndex,
  rovingStopIndex,
  typeAheadIndex,
} from "./roving-focus";

/** The browse grid at its widest: 23 titles over 5 columns, so the last row is short. */
const GRID = { count: 23, columns: 5 };
/** A shelf: one row, so `columns` is the whole count. */
const SHELF = { count: 6, columns: 6 };

describe("nextRovingIndex", () => {
  test("moves one along the row", () => {
    expect(nextRovingIndex("ArrowRight", 0, GRID)).toBe(1);
    expect(nextRovingIndex("ArrowLeft", 7, GRID)).toBe(6);
  });

  test("moves one ROW, not one item, on the vertical arrows", () => {
    expect(nextRovingIndex("ArrowDown", 2, GRID)).toBe(7);
    expect(nextRovingIndex("ArrowUp", 7, GRID)).toBe(2);
  });

  test("→ at the end of a row crosses onto the next", () => {
    // The items are one ordered list drawn in rows. A reader walking a grid with one key
    // means "the next poster", and the row boundary is a layout accident they never chose.
    expect(nextRovingIndex("ArrowRight", 4, GRID)).toBe(5);
  });

  test("declines rather than clamping at every edge", () => {
    // `null` is what stops the handler calling preventDefault, so the page still scrolls.
    // Clamping to the current index would eat the key and strand a reader at the bottom
    // of a long browse page.
    expect(nextRovingIndex("ArrowLeft", 0, GRID)).toBeNull();
    expect(nextRovingIndex("ArrowUp", 3, GRID)).toBeNull();
    expect(nextRovingIndex("ArrowRight", 22, GRID)).toBeNull();
  });

  test("declines a ↓ out of the last, short row", () => {
    // 23 items over 5 columns: index 20 is in the final row of three, and 25 is nothing.
    expect(nextRovingIndex("ArrowDown", 20, GRID)).toBeNull();
    // One row up from it there IS something below, even though the row is short.
    expect(nextRovingIndex("ArrowDown", 17, GRID)).toBe(22);
  });

  test("a single row swallows neither ↑ nor ↓", () => {
    // The whole of the shelf rule, and it needs no branch of its own: a vertical step is
    // `columns` items, and on one row that is always outside the list. So the page scrolls
    // and the next shelf is reachable.
    expect(nextRovingIndex("ArrowDown", 2, SHELF)).toBeNull();
    expect(nextRovingIndex("ArrowUp", 2, SHELF)).toBeNull();
    expect(nextRovingIndex("ArrowRight", 2, SHELF)).toBe(3);
  });

  test("ignores keys that are not arrows, and a focus that is not in the list", () => {
    expect(nextRovingIndex("Enter", 0, GRID)).toBeNull();
    expect(nextRovingIndex("a", 0, GRID)).toBeNull();
    // -1 is "focus is not on any item", which is every keystroke that reaches an empty grid.
    expect(nextRovingIndex("ArrowRight", -1, GRID)).toBeNull();
    expect(nextRovingIndex("ArrowRight", 0, { count: 0, columns: 0 })).toBeNull();
  });
});

describe("columnsInGrid", () => {
  test("counts the tracks the browser resolved", () => {
    expect(columnsInGrid("156px 156px 156px 156px", 20)).toBe(4);
  });

  test("a flex row reports `none`, which is one row", () => {
    // The shelf and the chip bar both land here, and both want `columns === count` so the
    // vertical arrows decline. Nothing about the breakpoints is restated to get that.
    expect(columnsInGrid("none", 6)).toBe(6);
    expect(columnsInGrid("", 6)).toBe(6);
  });

  test("never claims more columns than there are items", () => {
    // Five tracks, three cards: the last row is short and three is the ceiling that matters.
    expect(columnsInGrid("100px 100px 100px 100px 100px", 3)).toBe(3);
  });

  test("strips Firefox's line names", () => {
    expect(columnsInGrid("[full-start] 100px [mid] 100px [full-end]", 9)).toBe(2);
  });

  test("falls back to one row on an unresolved track function", () => {
    // Better to decline the vertical arrows than to guess a column count out of `repeat`.
    expect(columnsInGrid("repeat(4, minmax(0, 1fr))", 12)).toBe(12);
  });
});

describe("rovingStopIndex", () => {
  test("the chosen chip is the group's tab stop", () => {
    expect(rovingStopIndex([false, false, true, false])).toBe(2);
  });

  test("with nothing chosen it is the first", () => {
    // Which is where a reader arriving at the group would start anyway.
    expect(rovingStopIndex([false, false])).toBe(0);
    expect(rovingStopIndex([])).toBe(0);
  });
});

describe("isTypeAheadKey", () => {
  test("takes letters and digits in any script", () => {
    expect(isTypeAheadKey("a")).toBe(true);
    expect(isTypeAheadKey("7")).toBe(true);
    expect(isTypeAheadKey("é")).toBe(true);
    expect(isTypeAheadKey("春")).toBe(true);
  });

  test("leaves the bound keys alone", () => {
    // `/` focuses the search box and Escape clears the filters. A chip bar that ate them
    // would take working shortcuts away exactly where a reader wants them most.
    expect(isTypeAheadKey("/")).toBe(false);
    expect(isTypeAheadKey("Escape")).toBe(false);
    expect(isTypeAheadKey(" ")).toBe(false);
    expect(isTypeAheadKey("ArrowRight")).toBe(false);
  });
});

describe("typeAheadIndex", () => {
  const CHIPS = ["Films", "Series", "Action", "Adventure", "Animation", "Drama", "Documentary"];

  test("typing a prefix jumps to the chip that starts with it", () => {
    // The card's own example.
    expect(typeAheadIndex(CHIPS, "adv", 0)).toBe(3);
  });

  test("is case-insensitive, which is what a reader typing lowercase expects", () => {
    expect(typeAheadIndex(CHIPS, "DRA", -1)).toBe(5);
  });

  test("one letter pressed twice walks the matches", () => {
    // Starts AFTER the current chip, so `d` then `d` goes Drama, Documentary rather than
    // sitting on Drama forever.
    expect(typeAheadIndex(CHIPS, "d", 0)).toBe(5);
    expect(typeAheadIndex(CHIPS, "d", 5)).toBe(6);
  });

  test("a longer prefix stays where it landed", () => {
    // Starts AT the current chip, so typing "a", "n", "i" ends on Animation instead of
    // skipping to the next `a` on every letter.
    expect(typeAheadIndex(CHIPS, "a", -1)).toBe(2);
    expect(typeAheadIndex(CHIPS, "an", 2)).toBe(4);
    expect(typeAheadIndex(CHIPS, "ani", 4)).toBe(4);
  });

  test("wraps, because a chip bar is one row the reader thinks of as a ring", () => {
    expect(typeAheadIndex(CHIPS, "f", 4)).toBe(0);
  });

  test("nothing matching is nothing done", () => {
    // The handler leaves the keystroke alone, so a letter meant for something else still
    // reaches it.
    expect(typeAheadIndex(CHIPS, "z", 0)).toBeNull();
    expect(typeAheadIndex(CHIPS, "", 0)).toBeNull();
    expect(typeAheadIndex([], "a", -1)).toBeNull();
  });

  test("matches a chip whose label carries its count", () => {
    // The group reads `textContent`, so a chip drawn as `Adventure` + `12` arrives as one
    // string. The prefix is still the label.
    expect(typeAheadIndex(["Adventure12", "Action7"], "adv", -1)).toBe(0);
  });
});
