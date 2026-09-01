/**
 * Alt+<key> to open a card you can see, without reaching for the mouse.
 *
 * PURE AND DOM-FREE, the same split `keymap.ts` uses: this module decides which key
 * addresses which position, `components/JumpKeys.tsx` decides which cards are on screen
 * and clicks one. That is what makes the rules below testable without a browser.
 *
 * > [!IMPORTANT] This is deliberately NOT an entry in `KEYMAP`, and the reason is the shape
 * > `KEYMAP` is a `Record<ActionId, KeyBinding>` -- one NAMED action, one key. A jump key
 * > is the opposite: thirty-five keys addressing an ORDINAL POSITION that means something
 * > different on every scroll. Spelling it as thirty-five `ActionId`s would be a keymap
 * > entry per row of a grid, and every consumer of `KEYMAP` (the glyph, the aria fold, the
 * > match rule) would have to learn to ignore them.
 * >
 * > The two systems cannot collide, and that is by construction rather than by agreement:
 * > `matchesBinding` returns false for ANY chord with Alt held, so no named binding can
 * > fire from a jump chord and no jump chord can be swallowed by one. That clause was
 * > already there, and it is load-bearing for this file -- do not relax it to "allow Alt
 * > bindings" without giving jump keys somewhere else to be excluded.
 */

import type { KeyChord } from "./keymap";

/**
 * The labels, in the order positions are handed out: 1-9, then a-z.
 *
 * DIGITS FIRST because the first row of a grid is where a reader looks, and `Alt+1` is a
 * shorter thought than `Alt+a`. Zero is left out on purpose -- it would have to mean
 * either "10" or "the tenth", and either reading puts a two-character label on a badge
 * sized for one.
 *
 * Thirty-five positions in total. Past that a card gets no label rather than a second
 * modifier or a two-key sequence: a reader who has scrolled thirty-five cards deep is
 * scrolling, and the ones on screen get renumbered as they arrive anyway.
 */
export const JUMP_KEYS: readonly string[] = [..."123456789", ..."abcdefghijklmnopqrstuvwxyz"];

/** The label for a position, or `null` past the end of the alphabet. */
export function jumpLabelAt(index: number): string | null {
  return JUMP_KEYS[index] ?? null;
}

/**
 * Which position this keystroke addresses, or `null` if it addresses none.
 *
 * ALT AND NOTHING ELSE. A chord that also holds ⌘ or Ctrl is an application command the
 * browser or the OS very likely owns -- Alt+⌘+arrow switches tabs, Ctrl+Alt+letter is a
 * dead key on a Windows layout -- and quietly stealing one is worse than not having the
 * shortcut. Shift is not checked, for `matchesBinding`'s reason: it is part of how the
 * character is produced on plenty of layouts.
 *
 * > [!CAUTION] `event.key` IS THE WRONG THING TO READ HERE, on a Mac
 * > macOS treats Option as a compose modifier: Alt+3 arrives with `key` of `"£"` on a UK
 * > layout, and Alt+a as `"å"`. Reading `key` would give a shortcut that works on Linux
 * > and silently does nothing on the machine this was written on. `code` is the physical
 * > key and is unaffected -- `Digit3`, `KeyA` -- which is why this takes a chord carrying
 * > BOTH and matches on `code` alone.
 */
export function jumpIndexFor(chord: JumpChord): number | null {
  if (!chord.altKey || chord.metaKey || chord.ctrlKey) return null;
  const label = labelOfCode(chord.code);
  if (label === null) return null;
  const index = JUMP_KEYS.indexOf(label);
  return index === -1 ? null : index;
}

/** A `KeyboardEvent` reduced to what the rule above reads. `code`, not `key` -- see there. */
export interface JumpChord extends Omit<KeyChord, "key"> {
  /** `KeyboardEvent.code`: the physical key, unchanged by Option-as-compose. */
  code: string;
}

/**
 * `Digit3` -> `3`, `KeyA` -> `a`, anything else -> null.
 *
 * The numeric keypad is deliberately excluded (`Numpad3`): it is a different physical key
 * and a reader pressing it means the number, not the third card on screen.
 */
function labelOfCode(code: string): string | null {
  const digit = /^Digit([1-9])$/.exec(code);
  if (digit) return digit[1];
  const letter = /^Key([A-Z])$/.exec(code);
  return letter ? letter[1].toLowerCase() : null;
}

/** How a jump key is announced to a screen reader, from the same single source. */
export function jumpAriaKeyShortcut(label: string): string {
  return `Alt+${label}`;
}
