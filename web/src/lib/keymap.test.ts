/**
 * The keymap's rules, tested where they live: as pure functions, with no DOM.
 *
 * The two that matter most are `firesFrom` -- the guard that keeps a global listener from
 * eating the search box -- and the platform fold, which is the one thing in this feature
 * that renders differently on the machine running the tests and so has to be asserted
 * against an explicit platform rather than against the host's.
 */

import { describe, expect, test } from "bun:test";
import {
  ariaKeyShortcuts,
  detectPlatform,
  firesFrom,
  firesWhileTyping,
  glyphsFor,
  isTypingTarget,
  KEYMAP,
  type KeyBinding,
  keyActionParts,
  matchesBinding,
} from "./keymap";

const NO_MODS = { metaKey: false, ctrlKey: false, altKey: false };

describe("the table itself", () => {
  test("every action has a glyph, so none can render blank", () => {
    for (const [action, binding] of Object.entries(KEYMAP)) {
      expect(binding.glyph, action).not.toBe("");
      expect(binding.key, action).not.toBe("");
    }
  });

  /** The one deliberate collision. Both are "step back"; they never share a screen. */
  test("Escape is the only key two actions share", () => {
    const byKey = new Map<string, string[]>();
    for (const [action, binding] of Object.entries(KEYMAP)) {
      const chord = `${binding.mod ?? ""}${binding.key}`;
      byKey.set(chord, [...(byKey.get(chord) ?? []), action]);
    }
    const shared = [...byKey.entries()].filter(([, actions]) => actions.length > 1);
    expect(shared).toEqual([["Escape", ["back", "clearFilters"]]]);
  });
});

describe("the platform fold", () => {
  test("draws the command modifier the way each platform writes it", () => {
    expect(glyphsFor(KEYMAP.request, "mac")).toEqual(["⌘", "⏎"]);
    expect(glyphsFor(KEYMAP.request, "other")).toEqual(["Ctrl", "⏎"]);
  });

  test("leaves an unmodified key alone on both", () => {
    expect(glyphsFor(KEYMAP.back, "mac")).toEqual(["esc"]);
    expect(glyphsFor(KEYMAP.back, "other")).toEqual(["esc"]);
  });

  test("names the modifier for ARIA after the DOM flag, not after the glyph", () => {
    expect(ariaKeyShortcuts(KEYMAP.request, "mac")).toBe("Meta+Enter");
    expect(ariaKeyShortcuts(KEYMAP.request, "other")).toBe("Control+Enter");
    expect(ariaKeyShortcuts(KEYMAP.focusSearch, "mac")).toBe("/");
  });

  test("reads a Mac out of either navigator field, and iPadOS out of the user agent", () => {
    expect(detectPlatform({ platform: "MacIntel" })).toBe("mac");
    expect(detectPlatform({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" })).toBe("mac");
    expect(detectPlatform({ userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)" })).toBe("mac");
    expect(detectPlatform({ platform: "Win32", userAgent: "Mozilla/5.0 (Windows NT 10.0)" })).toBe("other");
    expect(detectPlatform(undefined)).toBe("other");
  });
});

describe("matching a keystroke", () => {
  test("the command modifier is ⌘ on a Mac and Ctrl elsewhere", () => {
    const cmd = { key: "Enter", ...NO_MODS, metaKey: true };
    const ctrl = { key: "Enter", ...NO_MODS, ctrlKey: true };
    expect(matchesBinding(cmd, KEYMAP.request, "mac")).toBe(true);
    expect(matchesBinding(ctrl, KEYMAP.request, "mac")).toBe(false);
    expect(matchesBinding(ctrl, KEYMAP.request, "other")).toBe(true);
    expect(matchesBinding(cmd, KEYMAP.request, "other")).toBe(false);
  });

  test("a bare Enter never counts as the request chord -- that is the whole point of it", () => {
    expect(matchesBinding({ key: "Enter", ...NO_MODS }, KEYMAP.request, "mac")).toBe(false);
    expect(matchesBinding({ key: "Enter", ...NO_MODS }, KEYMAP.loadMore, "mac")).toBe(true);
  });

  test("an unmodified binding refuses a modified keystroke", () => {
    expect(matchesBinding({ key: "Escape", ...NO_MODS, metaKey: true }, KEYMAP.back, "mac")).toBe(false);
    expect(matchesBinding({ key: "Escape", ...NO_MODS, altKey: true }, KEYMAP.back, "mac")).toBe(false);
  });

  /** `/` is a shifted key on plenty of layouts, so shift must not disqualify it. */
  test("shift is not part of the comparison", () => {
    const shifted = { key: "/", ...NO_MODS };
    expect(matchesBinding(shifted, KEYMAP.focusSearch, "other")).toBe(true);
  });
});

describe("where a keystroke landed", () => {
  const searchBox = { tagName: "INPUT" };
  const requestButton = { tagName: "BUTTON" };

  /**
   * The glyph asks this one directly, so that a hint is withdrawn by the same rule that
   * would have refused the keystroke. Two predicates here would drift into a `/` drawn
   * beside a box that is swallowing it.
   */
  test("the caret rule is one predicate, and the glyph reads it too", () => {
    expect(firesWhileTyping(KEYMAP.request)).toBe(true);
    expect(firesWhileTyping(KEYMAP.clearFilters)).toBe(true);
    expect(firesWhileTyping(KEYMAP.focusSearch)).toBe(false);
    expect(firesWhileTyping(KEYMAP.nextSeason)).toBe(false);
    expect(firesWhileTyping(KEYMAP.loadMore)).toBe(false);
  });

  test("nothing unmodified fires while there is a caret -- except Escape", () => {
    expect(firesFrom(searchBox, KEYMAP.focusSearch)).toBe(false);
    expect(firesFrom(searchBox, KEYMAP.loadMore)).toBe(false);
    expect(firesFrom(searchBox, KEYMAP.prevSeason)).toBe(false);
    expect(firesFrom(searchBox, KEYMAP.back)).toBe(true);
    expect(firesFrom(searchBox, KEYMAP.clearFilters)).toBe(true);
  });

  test("a command chord produces no character, so it fires from inside the box", () => {
    expect(firesFrom(searchBox, KEYMAP.request)).toBe(true);
  });

  test("a contenteditable counts as a caret even though its tag does not", () => {
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: "div" })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  /** Otherwise tabbing to a title and pressing Enter would navigate AND page the grid. */
  test("a bare Enter yields to whatever the browser is about to activate", () => {
    expect(firesFrom(requestButton, KEYMAP.loadMore)).toBe(false);
    expect(firesFrom({ tagName: "A" }, KEYMAP.loadMore)).toBe(false);
    expect(firesFrom({ tagName: "DIV" }, KEYMAP.loadMore)).toBe(true);
    // The modified chord is not an activation key, so it is unaffected.
    expect(firesFrom(requestButton, KEYMAP.request)).toBe(true);
    // Nor is Escape, which no button answers to.
    expect(firesFrom(requestButton, KEYMAP.back)).toBe(true);
  });

  test("an unknown target is treated as neutral rather than as a text box", () => {
    const custom: KeyBinding = KEYMAP.focusSearch;
    expect(firesFrom(null, custom)).toBe(true);
    expect(firesFrom(undefined, custom)).toBe(true);
  });
});

/**
 * The regression this file exists for: the two halves of a bound action are gated on
 * different things, and collapsing them into one flag silently un-announces the shortcut
 * on the one control most likely to hold the caret.
 */
describe("what a control announces versus what it draws", () => {
  test("the caret being in a text field never removes aria-keyshortcuts", () => {
    // focusSearch is the case that bit: `/` cannot fire while typing, so the glyph goes
    // away -- but the search box is itself a text field, and a screen reader reads
    // aria-keyshortcuts ON FOCUS. Gating the attribute on the caret meant focusing the
    // box was exactly what stripped its own shortcut, and nothing ever put it back.
    const focused = keyActionParts(KEYMAP.focusSearch, true, true);
    expect(focused.announce).toBe(true);
    expect(focused.draw).toBe(false);

    const blurred = keyActionParts(KEYMAP.focusSearch, true, false);
    expect(blurred.announce).toBe(true);
    expect(blurred.draw).toBe(true);
  });

  test("a chord that fires while typing keeps both halves", () => {
    expect(keyActionParts(KEYMAP.request, true, true)).toEqual({ announce: true, draw: true });
    // Escape means the same thing with or without a caret, which is why the clear-filters
    // hatch stays drawn while the search box has focus.
    expect(keyActionParts(KEYMAP.back, true, true)).toEqual({ announce: true, draw: true });
  });

  test("a disabled action advertises nothing at all", () => {
    // The original rule, still true: a glyph on a dead key is worse than no glyph, and an
    // unbound action must not claim a shortcut it will not answer.
    expect(keyActionParts(KEYMAP.request, false, false)).toEqual({ announce: false, draw: false });
    expect(keyActionParts(KEYMAP.focusSearch, false, true)).toEqual({ announce: false, draw: false });
  });
});
