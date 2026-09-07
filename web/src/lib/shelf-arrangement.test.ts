/**
 * The list edits, with no DOM anywhere near them.
 *
 * What is worth pinning here is the pair of rules the screen leans on and could not assert
 * for itself: a move at either end returns the SAME ARRAY (which is what lets the arrows stay
 * focusable rather than going `disabled` and dropping focus mid-reorder), and `sameArrangement`
 * compares order and visibility while ignoring the title -- so a shelf renamed upstream while
 * the screen is open does not read as an edit the reader made.
 */

import { describe, expect, test } from "bun:test";
import type { ShelfChoiceView } from "./api";
import { arrangementChoices, moveShelf, sameArrangement, toggleShelfHidden } from "./shelf-arrangement";

const shelf = (id: string, hidden = false): ShelfChoiceView => ({ id, title: id.toUpperCase(), hidden });
const PAGE: ShelfChoiceView[] = [shelf("trending"), shelf("newest"), shelf("horror")];
const ids = (shelves: readonly ShelfChoiceView[]) => shelves.map((s) => s.id);

describe("moveShelf", () => {
  test("up swaps a shelf with the one above it", () => {
    expect(ids(moveShelf(PAGE, "newest", "up"))).toEqual(["newest", "trending", "horror"]);
  });

  test("down swaps a shelf with the one below it", () => {
    expect(ids(moveShelf(PAGE, "newest", "down"))).toEqual(["trending", "horror", "newest"]);
  });

  /**
   * THE ONE THE SCREEN DEPENDS ON. The arrows stay pressable at the ends -- a `disabled`
   * button leaves the tab order the moment it becomes disabled, which would throw a keyboard
   * reader back to `<body>` the instant they moved a shelf to the top. So the press has to be
   * a no-op, and identity is how the caller tells "nothing happened" from "it moved".
   */
  test("a move off either end returns the same array, not a copy", () => {
    expect(moveShelf(PAGE, "trending", "up")).toBe(PAGE);
    expect(moveShelf(PAGE, "horror", "down")).toBe(PAGE);
  });

  test("an id no shelf carries changes nothing", () => {
    expect(moveShelf(PAGE, "retired-genre", "up")).toBe(PAGE);
  });

  test("the shelves either side keep their hidden flags", () => {
    const page = [shelf("trending"), shelf("newest", true)];
    expect(moveShelf(page, "newest", "up").map((s) => s.hidden)).toEqual([true, false]);
  });
});

describe("toggleShelfHidden", () => {
  test("hiding a shelf leaves it exactly where it was", () => {
    const next = toggleShelfHidden(PAGE, "newest");
    expect(ids(next)).toEqual(ids(PAGE));
    expect(next[1].hidden).toBe(true);
  });

  test("it is its own undo", () => {
    expect(toggleShelfHidden(toggleShelfHidden(PAGE, "newest"), "newest")).toEqual(PAGE);
  });

  test("nothing else on the page moves or changes", () => {
    const next = toggleShelfHidden(PAGE, "newest");
    expect(next[0]).toBe(PAGE[0]);
    expect(next[2]).toBe(PAGE[2]);
  });
});

describe("arrangementChoices", () => {
  test("the whole page is sent, in the drawn order, without the titles", () => {
    expect(arrangementChoices([shelf("trending"), shelf("newest", true)])).toEqual([
      { id: "trending", hidden: false },
      { id: "newest", hidden: true },
    ]);
  });
});

describe("sameArrangement", () => {
  test("an untouched list matches", () => {
    expect(sameArrangement(PAGE, [...PAGE])).toBe(true);
  });

  test("a reorder does not", () => {
    expect(sameArrangement(moveShelf(PAGE, "newest", "up"), PAGE)).toBe(false);
  });

  test("a hidden flag does not", () => {
    expect(sameArrangement(toggleShelfHidden(PAGE, "newest"), PAGE)).toBe(false);
  });

  /** A shelf renamed by tonight's index build is not an edit anybody made. */
  test("a title that changed underneath is not a change", () => {
    const renamed = PAGE.map((s) => ({ ...s, title: `${s.title} (2026)` }));
    expect(sameArrangement(renamed, PAGE)).toBe(true);
  });

  test("a shelf that arrived or retired is a difference", () => {
    expect(sameArrangement(PAGE, [...PAGE, shelf("comedy")])).toBe(false);
  });
});
