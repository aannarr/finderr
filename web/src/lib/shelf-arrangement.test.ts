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
import {
  arrangementChoices,
  moveShelf,
  reorderShelves,
  sameArrangement,
  toggleShelfHidden,
} from "./shelf-arrangement";

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

/*
  THE DROP, as two ids and an edge.

  The adapter deals in elements and pointer geometry and cannot be driven from a test without
  a real browser; this is the seam it hands off to, and it is where every rule a drop has to
  obey can actually be asserted. The reorder ARITHMETIC is `reorderWithEdge`'s -- what is
  pinned here is the wiring around it, which is ours: which drops are no-ops, and that a drop
  never invents or loses a row.
*/
describe("reorderShelves", () => {
  const FOUR = [shelf("a"), shelf("b"), shelf("c"), shelf("d")];

  test("dropping on the top edge of a row above puts it there", () => {
    expect(ids(reorderShelves(FOUR, "d", "b", "top"))).toEqual(["a", "d", "b", "c"]);
  });

  test("dropping on the bottom edge of a row above puts it after that row", () => {
    expect(ids(reorderShelves(FOUR, "d", "b", "bottom"))).toEqual(["a", "b", "d", "c"]);
  });

  test("dragging downwards lands after the target on its bottom edge", () => {
    expect(ids(reorderShelves(FOUR, "a", "c", "bottom"))).toEqual(["b", "c", "a", "d"]);
  });

  test("dragging downwards onto a top edge lands before the target", () => {
    expect(ids(reorderShelves(FOUR, "a", "c", "top"))).toEqual(["b", "a", "c", "d"]);
  });

  /*
    THE NO-OPS, ALL FOUR, AND EACH RETURNS THE IDENTICAL ARRAY.

    Every edit on this screen commits by itself now, so "the reader let go where they picked
    it up" has to be distinguishable from "the reader reordered the page" -- otherwise a drag
    that changed nothing writes a preference and marks an untouched reader as customised.
    `reorderWithEdge` always allocates, so identity is the signal and it is made here.
  */
  test.each([
    ["dropped on itself", "b", "b", "top" as const],
    ["source is not on the page", "nope", "b", "top" as const],
    ["target is not on the page", "b", "nope", "top" as const],
    ["landed exactly where it started", "b", "a", "bottom" as const],
  ])("%s changes nothing and returns the same array", (_name, source, target, edge) => {
    expect(reorderShelves(FOUR, source, target, edge)).toBe(FOUR);
  });

  test("a null edge is tolerated rather than throwing", () => {
    expect(() => reorderShelves(FOUR, "a", "c", null)).not.toThrow();
  });

  /*
    A DROP MAY ONLY PERMUTE. It cannot add a shelf, lose one, or duplicate one -- the same
    promise `applyShelfPreference` makes on the server, asserted on this side because the list
    that reaches the PUT is whatever this function returned.
  */
  test("every drop is a permutation, whatever the edge", () => {
    const before = ids(FOUR).sort();
    for (const source of ids(FOUR)) {
      for (const target of ids(FOUR)) {
        for (const edge of ["top", "bottom"] as const) {
          const after = reorderShelves(FOUR, source, target, edge);
          expect(ids(after).sort()).toEqual(before);
          expect(after).toHaveLength(FOUR.length);
        }
      }
    }
  });

  test("it carries the hidden flag with the row rather than with the position", () => {
    const page = [shelf("a"), shelf("b", true), shelf("c")];
    const moved = reorderShelves(page, "b", "a", "top");
    expect(moved.find((s) => s.id === "b")?.hidden).toBe(true);
    expect(moved.find((s) => s.id === "a")?.hidden).toBe(false);
  });
});
