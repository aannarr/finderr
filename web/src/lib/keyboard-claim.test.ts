import { describe, expect, test } from "bun:test";
import { claimKeyboard, keyboardClaimed } from "./keyboard-claim";

describe("claiming the keyboard", () => {
  test("a claim holds until released, and a double release does not free somebody else's claim", () => {
    expect(keyboardClaimed()).toBe(false);
    const first = claimKeyboard();
    const second = claimKeyboard();
    first();
    first();
    expect(keyboardClaimed()).toBe(true);
    second();
    expect(keyboardClaimed()).toBe(false);
  });
});
