/**
 * Navigation mode: label every card on screen, then one key opens one.
 *
 * PURE AND DOM-FREE, the same split `keymap.ts` uses: this module decides which key
 * addresses which position, `components/JumpKeys.tsx` decides which cards are on screen
 * and clicks one. That is what makes the rules below testable without a browser.
 *
 * > [!IMPORTANT] A MODE, not a held modifier, and the reason is that the alphabet is taken
 * > This started as hold-Alt-and-press-a-key, which does not survive contact with a real
 * > browser: on Windows and Linux `Alt`+letter is the MENU ACCELERATOR. `Alt+D` focuses
 * > Chrome's address bar, `Alt+F` opens the File menu, `Alt+E`, `Alt+V` and friends open
 * > theirs. Roughly half the alphabet was fighting the browser for the same chord, and the
 * > browser wins. Every other modifier is worse: `Ctrl`+letter is browser shortcuts,
 * > `Cmd`+letter is browser shortcuts, and the Windows key is the OS.
 * >
 * > **Inside a mode there is no modifier to collide with.** One chord gets in
 * > (`KEYMAP.jumpMode`, the only part of this that is a named action), the mode then owns
 * > the keyboard, and a hint is a single bare keystroke -- which is both faster and the
 * > shape vim readers already know from Vimium's `f`.
 */

/**
 * The labels, in the order positions are handed out: 1-9, then a-z.
 *
 * DIGITS FIRST because the first row of a grid is where a reader looks, and "the third
 * one" is a thought people already have about a row of cards. Zero is left out on purpose
 * -- it would have to mean either "10" or "the tenth", and either reading puts a
 * two-character label on a badge sized for one.
 *
 * Thirty-five positions. Past that a card gets no label rather than a two-key sequence:
 * Vimium pairs letters up (`fj`, `fk`) because a whole page of links needs hundreds of
 * targets, and a screen of posters needs about twenty. One keystroke per card is worth
 * more here than reaching the thirty-sixth.
 */
export const JUMP_KEYS: readonly string[] = [..."123456789", ..."abcdefghijklmnopqrstuvwxyz"];

/** The label for a position, or `null` past the end of the alphabet. */
export function jumpLabelAt(index: number): string | null {
  return JUMP_KEYS[index] ?? null;
}

/**
 * Which label this keystroke picks, or `null` if it picks none.
 *
 * ONLY EVER CALLED WHILE THE MODE IS ACTIVE, which is what lets it be this permissive: a
 * bare key is a hint here because nothing else is listening for one.
 *
 * > [!IMPORTANT] It reads `key`, and the Alt version had to read `code` -- the reversal is real
 * > Under the old hold-Alt design `key` was unusable: macOS treats Option as a compose
 * > modifier, so `Alt+a` arrives as `"å"` and `Alt+3` as `"£"` on a UK layout, and a
 * > matcher on `key` worked on Linux and silently did nothing on a Mac. `code` was the fix.
 * >
 * > With no modifier held that trap is gone, and `code` becomes the WRONG answer instead:
 * > it is the physical key, so on AZERTY the keycap printed `A` reports `KeyQ` and a
 * > reader pressing the letter they can see on the badge would open the wrong card.
 * > `key` is the character the keyboard actually produced, which is exactly what the badge
 * > shows. Layout-correct by construction, on every layout, with no table.
 *
 * A modifier disqualifies the keystroke rather than being ignored: `⌘R` inside the mode is
 * a reload, not a pick, and swallowing it would make the mode a trap.
 */
export function jumpLabelFor(chord: JumpChord): string | null {
  if (chord.metaKey || chord.ctrlKey || chord.altKey) return null;
  const label = chord.key.toLowerCase();
  return JUMP_KEYS.includes(label) ? label : null;
}

/** A `KeyboardEvent`, reduced to what the rule above reads, so a test needs no DOM. */
export interface JumpChord {
  /** `KeyboardEvent.key`: the character produced, which is what the badge shows. */
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

/** How a jump key is announced to a screen reader, from the same single source. */
export function jumpAriaKeyShortcut(label: string): string {
  return label;
}
