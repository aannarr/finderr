/**
 * The player's keys, as pure mapping: every binding, the guards, and the overlay's coverage.
 *
 * No DOM. A keystroke is a `KeyChord` and a focus target is a `KeyTarget`, the same seam the
 * page's own keymap tests use.
 */

import { describe, expect, test } from "bun:test";
import {
  firesFrom,
  KEYMAP,
  type KeyChord,
  PLAYER_KEYMAP,
  PLAYER_SHORTCUT_ROWS,
  type PlayerActionId,
  playerActionFor,
  playerGlyph,
  shortcutGlyphs,
} from "./keymap";

const press = (key: string, mods: Partial<KeyChord> = {}): KeyChord => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...mods,
});

const onBody = { tagName: "BODY" };

describe("every YouTube binding fires its action", () => {
  const cases: [string, PlayerActionId][] = [
    [" ", "playPause"],
    ["k", "playPause"],
    ["j", "back10"],
    ["l", "forward10"],
    ["ArrowLeft", "back5"],
    ["ArrowRight", "forward5"],
    ["ArrowUp", "volumeUp"],
    ["ArrowDown", "volumeDown"],
    ["m", "mute"],
    ["f", "fullscreen"],
    ["c", "subtitles"],
    ["a", "nextAudio"],
    ["0", "seekPercent"],
    ["7", "seekPercent"],
    ["Home", "seekStart"],
    ["End", "seekEnd"],
    [",", "frameBack"],
    [".", "frameForward"],
    ["<", "slower"],
    [">", "faster"],
    ["i", "stats"],
    ["?", "shortcuts"],
    ["Escape", "close"],
  ];
  for (const [key, action] of cases) {
    test(`${JSON.stringify(key)} -> ${action}`, () => {
      expect(playerActionFor(press(key), onBody, "mac")?.action).toBe(action);
    });
  }

  test("a digit reports WHICH digit, because the seek reads it", () => {
    expect(playerActionFor(press("4"), onBody, "other")).toEqual({ action: "seekPercent", key: "4" });
  });

  test("Caps Lock does not disable the letter keys", () => {
    expect(playerActionFor(press("K"), onBody, "mac")?.action).toBe("playPause");
  });
});

describe("the guards", () => {
  test("a command-modified chord is somebody else's -- ⌘. is the assistant, not a frame step", () => {
    expect(playerActionFor(press(".", { metaKey: true }), onBody, "mac")).toBeNull();
    expect(playerActionFor(press("f", { ctrlKey: true }), onBody, "other")).toBeNull();
    expect(playerActionFor(press("j", { altKey: true }), onBody, "mac")).toBeNull();
  });

  test("Space on a focused button activates the button and does not also toggle playback", () => {
    expect(playerActionFor(press(" "), { tagName: "BUTTON" }, "mac")).toBeNull();
    // k is not an activation key, so it still plays from a focused button.
    expect(playerActionFor(press("k"), { tagName: "BUTTON" }, "mac")?.action).toBe("playPause");
  });

  test("nothing but Escape fires while the caret is in a text field", () => {
    const field = { tagName: "INPUT" };
    expect(playerActionFor(press("k"), field, "mac")).toBeNull();
    expect(playerActionFor(press(" "), field, "mac")).toBeNull();
    expect(playerActionFor(press("Escape"), field, "mac")?.action).toBe("close");
  });

  test("Space joins Enter as a key that yields to an activation target, for every binding", () => {
    expect(firesFrom({ tagName: "A" }, { key: " ", glyph: "Space" })).toBe(false);
    expect(firesFrom({ tagName: "DIV" }, { key: " ", glyph: "Space" })).toBe(true);
    // The page's own Enter binding is unchanged by it.
    expect(firesFrom({ tagName: "BUTTON" }, KEYMAP.loadMore)).toBe(false);
  });
});

describe("the ? overlay cannot drift from the handler", () => {
  test("every player action appears in the overlay exactly once", () => {
    const listed = PLAYER_SHORTCUT_ROWS.flatMap((g) => g.rows.flatMap((r) => r.actions));
    expect([...listed].sort()).toEqual((Object.keys(PLAYER_KEYMAP) as PlayerActionId[]).sort());
  });

  test("a row draws the glyphs its bindings wear, unless it names a summary", () => {
    const seeking = PLAYER_SHORTCUT_ROWS.find((g) => g.group === "Seeking");
    const tens = seeking?.rows.find((r) => r.actions.includes("back10"));
    const digits = seeking?.rows.find((r) => r.actions.includes("seekPercent"));
    expect(tens && shortcutGlyphs(tens)).toEqual(["j", "l"]);
    expect(digits && shortcutGlyphs(digits)).toEqual(["0-9"]);
  });

  test("a control's tooltip glyph is its action's first key", () => {
    expect(playerGlyph("playPause")).toBe("Space");
    expect(playerGlyph("close")).toBe("esc");
  });
});
