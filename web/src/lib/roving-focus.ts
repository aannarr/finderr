/**
 * Where an arrow key sends focus, and which chip a typed prefix picks.
 *
 * PURE AND DOM-FREE, the same split `keymap.ts` and `jump-keys.ts` use: this module owns
 * the arithmetic, `components/RovingFocus.ts` owns the elements and the focus call. That
 * is what makes every rule below testable without a browser, which matters here because
 * the rules are ordinal and easy to get subtly wrong at the edges.
 *
 * > [!IMPORTANT] None of this is a named action, and it deliberately does not enter `KEYMAP`
 * > `jump-keys.ts` makes the same argument about its hint keys and it applies verbatim:
 * > "one card to the right" addresses an ORDINAL POSITION that means something different
 * > on every screen width and after every scroll, not a named thing a control could wear a
 * > glyph for. `KEYMAP` stays the owner of the app's four verbs; moving focus is not one of
 * > them, it is the browser's own job done properly over a grid the browser sees as a pile
 * > of links.
 */

/** The shape focus is moving over: how many items, and how many of them fit on a row. */
export interface RovingLayout {
  count: number;
  /** A single row -- a shelf, a chip bar -- has `columns === count`. See `nextRovingIndex`. */
  columns: number;
}

/**
 * How far one arrow moves, in items. A vertical step is one ROW, which is `columns` items.
 *
 * The single-row case needs no branch of its own and gets none: a row where `columns`
 * equals `count` puts every vertical step outside the list, so `nextRovingIndex` declines
 * it and the browser scrolls the page instead. That is the right answer for a shelf --
 * scrolling down is the only way to reach the next shelf, and a row that swallowed ↓ would
 * be a keyboard trap.
 */
function stepFor(key: string, columns: number): number | null {
  switch (key) {
    case "ArrowRight":
      return 1;
    case "ArrowLeft":
      return -1;
    case "ArrowDown":
      return columns;
    case "ArrowUp":
      return -columns;
    default:
      return null;
  }
}

/**
 * The item this keystroke moves to, or `null` for "not ours, leave it to the browser".
 *
 * Clamping is deliberately absent: an arrow with nowhere to go returns `null` rather than
 * the index it started on, so the handler does not `preventDefault` and the page scrolls
 * as it always did. A grid that ate every arrow at its edges would strand a reader at the
 * bottom of a long browse page.
 *
 * → at the end of a row DOES wrap onto the next row, and that is not an oversight. The
 * items are one ordered list that happens to be drawn in rows -- walking it end to end
 * with one key is what a reader scanning a grid of posters actually wants, and the row
 * boundary is a layout accident they never chose.
 */
export function nextRovingIndex(key: string, from: number, layout: RovingLayout): number | null {
  const { count, columns } = layout;
  if (from < 0 || from >= count) return null;
  const step = stepFor(key, columns);
  if (step === null) return null;
  const to = from + step;
  return to >= 0 && to < count ? to : null;
}

/**
 * How many columns a container draws, read from its own computed `grid-template-columns`.
 *
 * THE BREAKPOINTS ARE NOT RESTATED HERE, and that is the whole point of asking the layout.
 * The grid is `grid-cols-2 sm:3 lg:4 xl:5`; a copy of that table in TypeScript would be a
 * second owner of the app's breakpoints and would drift the first time one moves. The
 * browser has already resolved the question -- `getComputedStyle` returns the used tracks,
 * `"156px 156px 156px"` -- so counting them is the one answer that cannot disagree.
 *
 * `none` is what a flex row reports, and it means "one row": every item is a sibling on the
 * same line, so `columns` is the whole count. Line names (`[full-start]`) are stripped
 * because Firefox includes them in the computed value, and an unresolved function such as
 * `repeat(...)` falls back to one row rather than guessing at a track count.
 */
export function columnsInGrid(template: string, count: number): number {
  const tracks = template.replace(/\[[^\]]*\]/g, " ").trim();
  if (tracks === "" || tracks === "none" || tracks.includes("(")) return count;
  const found = tracks.split(/\s+/).length;
  // More tracks than items means the last row is short; the items are what focus moves
  // over, so the count is the ceiling.
  return Math.min(found, count);
}

/**
 * Which item in a group is the group's single TAB STOP.
 *
 * A roving-tabindex group is one stop in the page's tab order, not one per chip: twenty
 * refinement chips between the search box and the results is a tab order nobody walks to
 * the end of. The chosen chip is the stop, because that is where a returning reader left
 * off; with nothing chosen it is the first, which is where they would start.
 */
export function rovingStopIndex(chosen: readonly boolean[]): number {
  return Math.max(0, chosen.indexOf(true));
}

/**
 * How long a type-ahead prefix survives without another keystroke.
 *
 * Long enough to type "adv" at an unhurried pace, short enough that a letter pressed a
 * moment later starts a new search rather than extending a prefix the reader has forgotten
 * they began. The value every toolbar implementation converges on.
 */
export const TYPE_AHEAD_WINDOW_MS = 600;

/**
 * Is this keystroke a character somebody is spelling a label with?
 *
 * Letters and digits in ANY script, so a season named in Japanese is reachable the same
 * way "Adventure" is. Everything else is left alone on purpose: `/` focuses the search box
 * and `Escape` clears the filters, and a chip bar that swallowed them would take working
 * shortcuts away from the one place a reader is most likely to want them.
 */
export function isTypeAheadKey(key: string): boolean {
  return key.length === 1 && /[\p{L}\p{N}]/u.test(key);
}

/**
 * The chip a typed prefix picks, searching forward from where focus is.
 *
 * A SINGLE character starts at the item AFTER the current one, so pressing `d` twice walks
 * "Documentary" then "Drama" rather than sitting on the first `d` forever. A prefix of two
 * or more starts AT the current one, so typing "d", "r", "a" lands on Drama and stays
 * there instead of skipping to the next match on every letter. Both are the ARIA
 * type-ahead behaviour, and the difference between them is the entire reason this is a
 * function rather than a `findIndex` at the call site.
 *
 * Wraps, because a chip bar is a ring the reader thinks of as one row.
 */
export function typeAheadIndex(labels: readonly string[], prefix: string, from: number): number | null {
  const needle = prefix.toLowerCase();
  if (needle === "" || labels.length === 0) return null;
  const start = needle.length > 1 ? Math.max(from, 0) : from + 1;
  for (let i = 0; i < labels.length; i++) {
    const at = (((start + i) % labels.length) + labels.length) % labels.length;
    if (labels[at]?.toLowerCase().startsWith(needle)) return at;
  }
  return null;
}
