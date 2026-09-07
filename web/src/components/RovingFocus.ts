/**
 * The DOM half of roving focus: which elements are the items, and moving focus onto one.
 *
 * `lib/roving-focus.ts` owns WHICH index an arrow picks. This owns which element is at that
 * index right now and what it takes to make it visible -- questions only a browser can
 * answer. Same split as `jump-keys.ts`/`JumpKeys.tsx` and `keymap.ts`/`Kbd.tsx`.
 *
 * > [!CAUTION] THE LISTENER IS ON THE CONTAINER, never on `window`, and that is what keeps
 * > this from becoming a second source of actions
 * > Every named shortcut in this app hangs a global listener (`useKeyAction`) because the
 * > point of a named shortcut is that it works without tabbing to anything first. Arrow
 * > keys are the opposite: they mean "one more of what I am already on", so they are only
 * > ever meaningful when focus is ALREADY inside the thing they move over. A container
 * > listener says exactly that and needs no `enabled` flag, no route knowledge, and no
 * > entry in `KEYMAP` -- and it cannot fight the global bindings, because outside the
 * > container it does not exist.
 */

import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useRef } from "react";
import {
  columnsInGrid,
  isTypeAheadKey,
  nextRovingIndex,
  rovingStopIndex,
  TYPE_AHEAD_WINDOW_MS,
  typeAheadIndex,
} from "../lib/roving-focus";

/** What arrow keys move between, and what takes focus when the item is not focusable itself. */
export interface RovingItems {
  /** Selects the items, in document order, from inside the container. */
  selector: string;
  /**
   * Selects the focusable element INSIDE an item. Omitted where the item is itself the
   * control -- a chip is a `<button>`, a title card is an `<article>` wrapping a link.
   */
  focusable?: string;
}

function itemsIn(container: HTMLElement, selector: string): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(selector)];
}

/**
 * Which item currently holds focus, or -1.
 *
 * `contains` rather than identity, because a card holds three focusable things -- the
 * poster link, the title link and the request button -- and an arrow pressed on any of
 * them means "one card over" rather than "nothing, you are not on a card".
 */
function focusedIndex(items: readonly HTMLElement[]): number {
  const active = document.activeElement;
  if (!active) return -1;
  return items.findIndex((item) => item.contains(active));
}

/**
 * Focus an element and make sure the reader can see it.
 *
 * > [!IMPORTANT] `scrollIntoView` is what makes an arrow key visible, not belt and braces
 * > A grid is taller than the viewport, so ↓ from the last visible row focuses a card that
 * > is off screen: the reader presses ↓, nothing appears to happen, and the next ↓ moves a
 * > selection they cannot see. `block: "nearest"` scrolls the minimum that brings it into
 * > view, which for a one-step move is usually a single row, and does nothing at all when
 * > the target was already visible.
 * >
 * > It was written for a sharper version of the same failure -- `.card-grid` carried
 * > `content-visibility: auto`, which SKIPS RENDERING offscreen rows entirely -- and that
 * > property is gone (`styles.css` carries why). The line stays because the ordinary case
 * > above it is reason enough on its own.
 */
function revealAndFocus(el: HTMLElement): void {
  el.focus();
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function focusTargetOf(item: HTMLElement, items: RovingItems): HTMLElement | null {
  return items.focusable ? item.querySelector<HTMLElement>(items.focusable) : item;
}

/**
 * Move focus one item along, and report which element took it.
 *
 * `null` means "this keystroke was not a move" -- an unbound key, or an edge with nothing
 * beyond it -- and every caller answers it the same way: do nothing, do not
 * `preventDefault`, let the browser scroll.
 */
export function moveRovingFocus(container: HTMLElement, items: RovingItems, key: string): HTMLElement | null {
  const found = itemsIn(container, items.selector);
  const to = nextRovingIndex(key, focusedIndex(found), {
    count: found.length,
    columns: columnsInGrid(getComputedStyle(container).gridTemplateColumns, found.length),
  });
  if (to === null) return null;
  const item = found[to];
  const target = item && focusTargetOf(item, items);
  if (!target) return null;
  revealAndFocus(target);
  return target;
}

/** A chip group's items: every button in it, including the Clear chip that sits alongside. */
const CHIP_ITEMS: RovingItems = { selector: "button" };

export interface ChipGroupOptions {
  /**
   * Does moving focus also CHOOSE?
   *
   * True for a set where exactly one thing is chosen and choosing is free -- the season
   * selector, where ← and → have always switched season outright. False for the refinement
   * bar, where each chip is an independent filter and choosing means a navigation and a
   * refetch: arrowing across eight genres would fire eight searches nobody asked for.
   * Both are the ARIA pattern for their kind of set; the difference is a prop rather than a
   * second hook.
   */
  selectionFollowsFocus?: boolean;
}

/**
 * A row of chips, driveable from the keyboard: ONE tab stop, arrows between, type to jump.
 *
 * Space and Enter are deliberately absent -- these are real `<button>` elements and the
 * browser already activates them on both. A handler here would either duplicate that or
 * double-fire it, which is the whole reason `ToggleChip` was left a plain button.
 *
 * > [!IMPORTANT] The season row's ← and → are ALSO a global binding, and this wins while
 * > focus is inside the group
 * > `SeriesPane` binds `prevSeason`/`nextSeason` on `window`, so an arrow pressed anywhere
 * > on the title page steps the season. A container handler runs first, so this one calls
 * > `stopPropagation` on the moves it takes -- otherwise a single → would step the season
 * > twice, once for the focus move and once for the global key. With
 * > `selectionFollowsFocus` the outcome is identical either way, which is exactly why the
 * > season row sets it: the reader gets one step, and focus goes where the selection went.
 */
export function useChipGroup<Container extends HTMLElement = HTMLDivElement>({
  selectionFollowsFocus = false,
}: ChipGroupOptions = {}) {
  /*
    Generic over the container because the element that HOLDS the chips is chosen by the
    ARIA, not by this hook: a toolbar and a group are divs, but the request dialog's
    tick-boxes are inside a form and therefore a real `<fieldset>`. A `RefObject` is
    invariant, so one hardcoded element type would force a cast at that call site -- a lie
    to the compiler in exchange for nothing.
  */
  const ref = useRef<Container | null>(null);
  const typed = useRef({ prefix: "", at: 0 });

  /*
    Roving tabindex, re-applied after EVERY render rather than on a dependency list.

    The chips are handed to this hook as children, so it has no props describing them: the
    facet bar draws three separate `map`s over counts that change with every result, and
    the tab stop follows whichever chip is pressed. Reading the rendered buttons is the only
    reading that cannot be stale, and it is a handful of nodes.

    Writing `tabIndex` imperatively is safe here because React never sets it on these
    buttons -- it does not reset attributes it does not own -- and it keeps every call site
    from having to thread an index through to `ToggleChip`.
  */
  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    const chips = itemsIn(container, CHIP_ITEMS.selector);
    const stop = rovingStopIndex(chips.map((chip) => chip.getAttribute("aria-pressed") === "true"));
    chips.forEach((chip, i) => {
      chip.tabIndex = i === stop ? 0 : -1;
    });
  });

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      // A modified chord belongs to the browser or to a global binding. `⌘/` opens
      // navigation mode from anywhere, and swallowing it here would make this a trap.
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const container = event.currentTarget;

      const moved = moveRovingFocus(container, CHIP_ITEMS, event.key);
      if (moved) {
        event.preventDefault();
        event.stopPropagation();
        if (selectionFollowsFocus) moved.click();
        return;
      }

      if (!isTypeAheadKey(event.key)) return;
      const now = Date.now();
      const stale = now - typed.current.at > TYPE_AHEAD_WINDOW_MS;
      const prefix = stale ? event.key : typed.current.prefix + event.key;
      typed.current = { prefix, at: now };

      const chips = itemsIn(container, CHIP_ITEMS.selector);
      // The whole chip is the label, count and all: "Adventure12" still starts with "adv",
      // and reading the rendered text needs no second copy of what each chip is called.
      const to = typeAheadIndex(
        chips.map((chip) => chip.textContent ?? ""),
        prefix,
        focusedIndex(chips),
      );
      const target = to === null ? null : chips[to];
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      revealAndFocus(target);
      if (selectionFollowsFocus) target.click();
    },
    [selectionFollowsFocus],
  );

  return { ref, onKeyDown };
}
