/**
 * The three drawer-motion rules, against a stubbed `matchMedia`.
 *
 * Each one has a wrong answer that is invisible in a browser you happen to be testing in:
 * the compact check is right on every phone and wrong on a narrowed desktop window, and the
 * reduced-motion check is right for everybody who never set the preference. Stubbing the
 * query is the only way to see both sides of either.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { DRAWER_MS, drawerMs, isCompactViewport, SM_QUERY } from "./drawer-motion";

const original = Object.getOwnPropertyDescriptor(globalThis, "window");

afterEach(() => {
  if (original) Object.defineProperty(globalThis, "window", original);
  else delete (globalThis as { window?: unknown }).window;
});

/** A window whose `matchMedia` answers `true` for exactly the queries listed. */
function withMatching(...queries: string[]) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: { matchMedia: (q: string) => ({ matches: queries.includes(q) }) },
  });
}

/** A window with no `matchMedia` at all -- an old browser, or a bare test runner. */
function withoutMatchMedia() {
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: {} });
}

describe("isCompactViewport", () => {
  test("a viewport below `sm` is compact -- the drawer is the whole screen there", () => {
    withMatching();
    expect(isCompactViewport()).toBe(true);
  });

  test("a viewport at or above `sm` is not, so the page stays visible beside the panel", () => {
    withMatching(SM_QUERY);
    expect(isCompactViewport()).toBe(false);
  });

  test("it asks the SAME breakpoint the panel's own width class uses", () => {
    // `w-full sm:w-[26rem]` and `sm:hidden` on the scrim are the other two owners of this
    // boundary. A second number here would create a band of widths where the page is
    // readable beside the drawer and the drawer retracts anyway.
    expect(SM_QUERY).toBe("(min-width: 40rem)");
  });

  test("with no `matchMedia` it says NOT compact, which leaves the panel open", () => {
    // The asymmetry is the point: guessing wrong this way is today's behaviour, guessing
    // wrong the other way closes a panel on somebody who was reading it.
    withoutMatchMedia();
    expect(isCompactViewport()).toBe(false);
  });
});

describe("drawerMs", () => {
  test("a reader with no preference gets the full slide", () => {
    withMatching();
    expect(drawerMs()).toBe(DRAWER_MS);
  });

  test("`prefers-reduced-motion: reduce` unmounts immediately", () => {
    // The stylesheet has already floored the transition at 0.01ms, so the panel is off the
    // screen. Waiting the full duration would leave an invisible element over the page,
    // still taking the taps meant for it.
    withMatching("(prefers-reduced-motion: reduce)");
    expect(drawerMs()).toBe(0);
  });

  test("no `matchMedia` is treated as reduce, not as full motion", () => {
    withoutMatchMedia();
    expect(drawerMs()).toBe(0);
  });
});
