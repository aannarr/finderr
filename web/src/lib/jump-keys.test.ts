import { describe, expect, test } from "bun:test";
import { JUMP_KEYS, jumpAriaKeyShortcut, jumpLabelAt, jumpLabelFor } from "./jump-keys";
import { firesWhileTyping, KEYMAP, matchesBinding } from "./keymap";

/** A bare keystroke inside the mode, with every modifier explicit. */
function chord(key: string, over: Partial<Parameters<typeof jumpLabelFor>[0]> = {}) {
  return { key, metaKey: false, ctrlKey: false, altKey: false, ...over };
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

  /** Past the alphabet a card gets no label rather than a two-key sequence. */
  test("past the end is null, not a wrap-around", () => {
    expect(jumpLabelAt(35)).toBeNull();
    expect(jumpLabelAt(999)).toBeNull();
  });
});

describe("jumpLabelFor", () => {
  test("a bare digit or letter picks its label", () => {
    expect(jumpLabelFor(chord("1"))).toBe("1");
    expect(jumpLabelFor(chord("9"))).toBe("9");
    expect(jumpLabelFor(chord("a"))).toBe("a");
    expect(jumpLabelFor(chord("z"))).toBe("z");
  });

  /** Caps Lock or a held Shift must not make a labelled card unreachable. */
  test("case is folded, so a capital picks the same card", () => {
    expect(jumpLabelFor(chord("A"))).toBe("a");
    expect(jumpLabelFor(chord("Z"))).toBe("z");
  });

  /**
   * `⌘R` inside the mode is a reload, not a pick. Swallowing a modified chord would make
   * the mode a trap, so it is disqualified here and the provider lets it through.
   */
  test("any modifier disqualifies the keystroke", () => {
    expect(jumpLabelFor(chord("a", { metaKey: true }))).toBeNull();
    expect(jumpLabelFor(chord("a", { ctrlKey: true }))).toBeNull();
    expect(jumpLabelFor(chord("a", { altKey: true }))).toBeNull();
  });

  test("zero, punctuation and named keys are not labels", () => {
    expect(jumpLabelFor(chord("0"))).toBeNull();
    expect(jumpLabelFor(chord("/"))).toBeNull();
    expect(jumpLabelFor(chord("Enter"))).toBeNull();
    expect(jumpLabelFor(chord("Escape"))).toBeNull();
    expect(jumpLabelFor(chord("ArrowLeft"))).toBeNull();
  });

  /**
   * The reversal worth knowing. The Alt-held design this replaced HAD to read `code`,
   * because macOS composes with Option (`Alt+a` arrives as `"å"`). With no modifier held
   * that trap is gone and `code` becomes the wrong answer instead: it is the PHYSICAL key,
   * so on AZERTY the keycap printed `A` reports `KeyQ` and a reader pressing the letter
   * they can see on the badge would open the wrong card. `key` is what the keyboard
   * produced, which is exactly what the badge shows -- layout-correct with no table.
   */
  test("it reads the character produced, not the physical key", () => {
    // An AZERTY reader pressing the key labelled A: key "a", code "KeyQ".
    expect(jumpLabelFor({ ...chord("a"), key: "a" })).toBe("a");
    // A composed character is not a label, so a dead key cannot pick a card by accident.
    expect(jumpLabelFor(chord("å"))).toBeNull();
    expect(jumpLabelFor(chord("£"))).toBeNull();
  });
});

/**
 * Mode ENTRY is a named binding; the hint keys are not, and cannot be -- they address an
 * ordinal position that means something different on every scroll.
 */
describe("KEYMAP.jumpMode", () => {
  test("it is command-modified, which is the only way it fires from the search box", () => {
    // The box is autofocused and holds the caret almost permanently. `firesWhileTyping`
    // lets a command-modified chord through a caret and nothing else, so an unmodified
    // entry key could never fire where a reader actually is.
    expect(KEYMAP.jumpMode.mod).toBe("command");
    expect(firesWhileTyping(KEYMAP.jumpMode)).toBe(true);
  });

  test("it is the same slash that focuses search, one modifier apart", () => {
    expect(KEYMAP.jumpMode.key).toBe(KEYMAP.focusSearch.key);
    expect(KEYMAP.focusSearch.mod).toBeUndefined();
  });

  test("it folds to the platform's own command modifier", () => {
    const cmd = { key: "/", metaKey: true, ctrlKey: false, altKey: false };
    const ctrl = { key: "/", metaKey: false, ctrlKey: true, altKey: false };
    expect(matchesBinding(cmd, KEYMAP.jumpMode, "mac")).toBe(true);
    expect(matchesBinding(ctrl, KEYMAP.jumpMode, "other")).toBe(true);
    // A bare slash is still just "focus the search box".
    expect(
      matchesBinding({ key: "/", metaKey: false, ctrlKey: false, altKey: false }, KEYMAP.jumpMode, "mac"),
    ).toBe(false);
  });

  /**
   * The mode owns the keyboard while it is open, so no hint key may also be a named
   * binding -- a reader pressing `a` must open a card and nothing else. Every named
   * binding is a named key (Enter, Escape, arrows) or a modified one, and this pins it.
   */
  test("no named binding collides with a bare hint key", () => {
    for (const binding of Object.values(KEYMAP)) {
      if (binding.mod) continue;
      expect(JUMP_KEYS).not.toContain(binding.key.toLowerCase());
    }
  });
});

describe("jumpAriaKeyShortcut", () => {
  /** Bare inside the mode, so the attribute names the key alone -- no modifier to spell. */
  test("names the key a reader actually presses", () => {
    expect(jumpAriaKeyShortcut("1")).toBe("1");
    expect(jumpAriaKeyShortcut("z")).toBe("z");
  });
});
