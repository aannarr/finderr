import { describe, expect, test } from "bun:test";
import { JUMP_KEYS, jumpAriaKeyShortcut, jumpIndexFor, jumpLabelAt } from "./jump-keys";
import { KEYMAP, matchesBinding } from "./keymap";

/** An Alt chord, with every modifier explicit so a test says what it is testing. */
function chord(code: string, over: Partial<Parameters<typeof jumpIndexFor>[0]> = {}) {
  return { code, altKey: true, metaKey: false, ctrlKey: false, ...over };
}

describe("JUMP_KEYS", () => {
  test("digits 1-9 then a-z, in that order", () => {
    expect(JUMP_KEYS.slice(0, 9)).toEqual([..."123456789"]);
    expect(JUMP_KEYS[9]).toBe("a");
    expect(JUMP_KEYS).toHaveLength(35);
  });

  /** Zero would have to mean "10" or "the tenth", and neither fits a one-character badge. */
  test("zero is not a label", () => {
    expect(JUMP_KEYS).not.toContain("0");
  });

  test("every label is distinct, or two cards would answer to one key", () => {
    expect(new Set(JUMP_KEYS).size).toBe(JUMP_KEYS.length);
  });
});

describe("jumpLabelAt", () => {
  test("hands out labels in order", () => {
    expect(jumpLabelAt(0)).toBe("1");
    expect(jumpLabelAt(8)).toBe("9");
    expect(jumpLabelAt(9)).toBe("a");
    expect(jumpLabelAt(34)).toBe("z");
  });

  /** Past the alphabet a card gets no label rather than a second modifier or a sequence. */
  test("past the end is null, not a wrap-around", () => {
    expect(jumpLabelAt(35)).toBeNull();
    expect(jumpLabelAt(999)).toBeNull();
  });
});

describe("jumpIndexFor", () => {
  test("Alt plus a digit or a letter addresses its position", () => {
    expect(jumpIndexFor(chord("Digit1"))).toBe(0);
    expect(jumpIndexFor(chord("Digit9"))).toBe(8);
    expect(jumpIndexFor(chord("KeyA"))).toBe(9);
    expect(jumpIndexFor(chord("KeyZ"))).toBe(34);
  });

  /**
   * THE ONE THAT WOULD HAVE SHIPPED BROKEN ON A MAC. macOS treats Option as a compose
   * modifier, so Alt+3 arrives with `key` of "£" on a UK layout and Alt+a as "å" -- a
   * matcher reading `key` works on Linux and silently does nothing here. `code` is the
   * physical key and is untouched by the composition.
   */
  test("it matches the physical key, so Option-as-compose cannot break it", () => {
    // The shape a real macOS event has: composed `key`, unchanged `code`.
    expect(jumpIndexFor({ ...chord("KeyA"), code: "KeyA" })).toBe(9);
    expect(jumpIndexFor(chord("Digit3"))).toBe(2);
  });

  test("without Alt it addresses nothing -- plain typing is not a jump", () => {
    expect(jumpIndexFor(chord("Digit1", { altKey: false }))).toBeNull();
  });

  /**
   * Alt+⌘+arrow switches tabs; Ctrl+Alt+letter is a dead key on Windows layouts. Quietly
   * stealing one is worse than not having the shortcut.
   */
  test("a second command modifier disqualifies the chord", () => {
    expect(jumpIndexFor(chord("Digit1", { metaKey: true }))).toBeNull();
    expect(jumpIndexFor(chord("Digit1", { ctrlKey: true }))).toBeNull();
  });

  test("zero, punctuation and the keypad are not jump keys", () => {
    expect(jumpIndexFor(chord("Digit0"))).toBeNull();
    expect(jumpIndexFor(chord("Numpad3"))).toBeNull();
    expect(jumpIndexFor(chord("Slash"))).toBeNull();
    expect(jumpIndexFor(chord("Enter"))).toBeNull();
    expect(jumpIndexFor(chord("Escape"))).toBeNull();
  });
});

/**
 * The two keyboard systems must not overlap, and this is where that is pinned.
 *
 * `matchesBinding` rejects ANY chord with Alt held, which is what makes the jump family
 * safe to live outside `KEYMAP`. Relaxing that clause to "allow Alt bindings" without
 * giving jump keys somewhere else to be excluded would have every jump chord also fire a
 * named action.
 */
describe("jump keys and KEYMAP cannot collide", () => {
  test("no named binding fires while Alt is held", () => {
    for (const binding of Object.values(KEYMAP)) {
      for (const platform of ["mac", "other"] as const) {
        const held = { key: binding.key, metaKey: true, ctrlKey: true, altKey: true };
        expect(matchesBinding(held, binding, platform)).toBe(false);
      }
    }
  });
});

describe("jumpAriaKeyShortcut", () => {
  /** The `aria-keyshortcuts` grammar names modifiers after the DOM's own event flags. */
  test("spells the chord the way the attribute expects", () => {
    expect(jumpAriaKeyShortcut("1")).toBe("Alt+1");
    expect(jumpAriaKeyShortcut("z")).toBe("Alt+z");
  });
});
