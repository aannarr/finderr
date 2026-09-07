/**
 * The four edits a reader can make to their front page, as pure functions over a list.
 *
 * Separate from the screen that draws them for the reason `lib/roving-focus.ts` is separate
 * from `components/RovingFocus.ts`: moving an item one place along and deciding whether the
 * list still matches what the server holds are questions with no DOM in them, and testing
 * them through a rendered component would test React instead of the rule.
 *
 * THE SERVER OWNS EVERYTHING ELSE. Which shelves exist, where a shelf the reader never
 * mentioned lands, and what happens to an id that stopped naming a shelf are all decided by
 * `src/lib/shelf-preferences.ts` and re-decided on every save -- so nothing here may invent
 * a shelf, drop one, or reason about what a shelf id means. These functions only ever
 * permute and mark the list they were handed, which is what makes a round trip the single
 * owner of the resolution rule.
 */

import type { ShelfChoice, ShelfChoiceView } from "./api";

/** Which way an arrow moves a shelf: towards the top of the page, or away from it. */
export type ShelfMove = "up" | "down";

/**
 * One shelf swapped with its neighbour, or THE SAME ARRAY when there is no neighbour.
 *
 * Returning the identical reference at the ends is deliberate and is what makes an arrow at
 * the top of the list a no-op rather than a re-render: the screen keeps its `aria-disabled`
 * arrows focusable (a `disabled` one drops focus to `<body>` mid-reorder, which strands a
 * keyboard reader halfway through arranging), so a press that cannot move anything has to be
 * safe to make.
 */
export function moveShelf(
  shelves: readonly ShelfChoiceView[],
  id: string,
  move: ShelfMove,
): readonly ShelfChoiceView[] {
  const from = shelves.findIndex((shelf) => shelf.id === id);
  const to = from + (move === "up" ? -1 : 1);
  if (from === -1 || to < 0 || to >= shelves.length) return shelves;

  const next = [...shelves];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/** Hide a shelf, or put it back. Its POSITION is untouched -- un-hiding returns it where it was. */
export function toggleShelfHidden(
  shelves: readonly ShelfChoiceView[],
  id: string,
): readonly ShelfChoiceView[] {
  return shelves.map((shelf) => (shelf.id === id ? { ...shelf, hidden: !shelf.hidden } : shelf));
}

/**
 * The list as the server takes it: ids and hidden flags, in the drawn order.
 *
 * The title is dropped because it is the SERVER's -- it comes from whatever the shelf is
 * called today, and storing a copy would let a renamed shelf keep an old name on one
 * reader's page for as long as they never rearranged it.
 *
 * EVERY shelf is sent, not only the moved ones. The stored list is an ordering hint rather
 * than an allow-list, so a shelf left out is a shelf the server places for itself on the next
 * release -- sending the whole page is what makes "this is my order" mean what it says.
 */
export function arrangementChoices(shelves: readonly ShelfChoiceView[]): ShelfChoice[] {
  return shelves.map(({ id, hidden }) => ({ id, hidden }));
}

/**
 * Do these two lists say the same thing? Drives whether there is anything to save.
 *
 * Compared on ID AND ORDER AND HIDDEN, and on nothing else: the title is display, so a shelf
 * renamed upstream between the load and the save must not read as an edit the reader made.
 */
export function sameArrangement(a: readonly ShelfChoiceView[], b: readonly ShelfChoiceView[]): boolean {
  return a.length === b.length && a.every((shelf, i) => shelf.id === b[i].id && shelf.hidden === b[i].hidden);
}
