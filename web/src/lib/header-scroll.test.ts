import { describe, expect, test } from "bun:test";
import {
  COLLAPSE_AFTER_PX,
  type HeaderState,
  INITIAL_HEADER_STATE,
  nextHeaderState,
  SCROLL_STEP_PX,
} from "./header-scroll";

/** Feed a sequence of scroll positions through the reducer and return the final state. */
function scrollThrough(ys: number[], pinned = false, from: HeaderState = INITIAL_HEADER_STATE) {
  return ys.reduce((state, y) => nextHeaderState(state, { y, pinned }), from);
}

describe("nextHeaderState", () => {
  test("stays open near the top however far you flick", () => {
    // Below the fold the header is still visually the top of the page. Collapsing here
    // would read as a flicker rather than as reclaiming space.
    expect(scrollThrough([0, 40, 90, COLLAPSE_AFTER_PX]).collapsed).toBe(false);
  });

  test("collapses on a deliberate scroll down past the fold", () => {
    expect(scrollThrough([0, 200, 400]).collapsed).toBe(true);
  });

  test("re-opens on a deliberate scroll up, without going back to the top", () => {
    const collapsed = scrollThrough([0, 200, 400]);
    expect(collapsed.collapsed).toBe(true);
    expect(nextHeaderState(collapsed, { y: 300, pinned: false }).collapsed).toBe(false);
  });

  test("re-opens on returning to the top", () => {
    const collapsed = scrollThrough([0, 200, 400]);
    expect(nextHeaderState(collapsed, { y: 0, pinned: false }).collapsed).toBe(false);
  });

  test("jitter under the threshold changes nothing, however much of it there is", () => {
    // The scar this defends: a trackpad's momentum tail and iOS rubber-banding produce
    // single-pixel direction flips, and without hysteresis the box flutters.
    let state = scrollThrough([0, 300]);
    const before = state;
    for (let i = 0; i < 50; i++) {
      state = nextHeaderState(state, { y: 300 + (i % 2 === 0 ? 3 : -3), pinned: false });
    }
    expect(state).toBe(before);
  });

  test("a slow but STEADY scroll does accumulate, and should", () => {
    // The other half of the anchor rule, and the one that is easy to get backwards. The
    // anchor not advancing inside the dead zone is what lets many small same-direction
    // events add up: a slow trackpad drag delivers 3px at a time and is still a scroll.
    // What the threshold rejects is OSCILLATION, not slowness -- see the test above.
    let state = scrollThrough([0, 300]);
    for (let i = 1; i <= 10; i++) {
      state = nextHeaderState(state, { y: 300 + i * 3, pinned: false });
    }
    expect(state.collapsed).toBe(true);
    // The anchor RE-ANCHORS as it goes, so it trails the current position by less than one
    // step rather than staying where the collapse first fired. That is what makes a scroll
    // UP re-open promptly: the threshold is measured from where the reader is now, not from
    // wherever they happened to cross it.
    expect(330 - state.anchorY).toBeLessThan(SCROLL_STEP_PX);
  });

  test("exactly one step is enough -- the threshold is inclusive", () => {
    const at300 = scrollThrough([0, 300]);
    expect(nextHeaderState(at300, { y: 300 + SCROLL_STEP_PX, pinned: false }).collapsed).toBe(true);
  });

  test("pinned always wins, even scrolling down hard", () => {
    // Collapsing the control somebody is typing into is the one behaviour that would make
    // this worse than no feature at all.
    expect(scrollThrough([0, 400, 800, 1200], true).collapsed).toBe(false);
  });

  test("pinning re-opens a box that was already collapsed", () => {
    const collapsed = scrollThrough([0, 200, 400]);
    expect(collapsed.collapsed).toBe(true);
    expect(nextHeaderState(collapsed, { y: 400, pinned: true }).collapsed).toBe(false);
  });

  test("unpinning does not collapse it -- that takes another scroll down", () => {
    // Blurring the box must not make it vanish under the cursor. The reader has to scroll.
    const pinnedOpen = nextHeaderState(scrollThrough([0, 200, 400]), { y: 400, pinned: true });
    expect(nextHeaderState(pinnedOpen, { y: 400, pinned: false }).collapsed).toBe(false);
  });

  test("a negative scrollY is treated as the top, not as a scroll up from nowhere", () => {
    // iOS reports negative while rubber-banding at the top.
    expect(nextHeaderState({ collapsed: true, anchorY: 400 }, { y: -80, pinned: false })).toEqual({
      collapsed: false,
      anchorY: 0,
    });
  });

  test("an unchanged position returns the SAME object, so nothing re-renders", () => {
    // A scroll listener fires per frame. Allocating and re-rendering on every one of those
    // is how a header animation becomes the jank it was meant to avoid.
    const state = scrollThrough([0, 300]);
    expect(nextHeaderState(state, { y: 300, pinned: false })).toBe(state);

    const collapsed = scrollThrough([0, 200, 400]);
    expect(nextHeaderState(collapsed, { y: 402, pinned: false })).toBe(collapsed);
  });

  test("a long scroll down then up then down again tracks the last direction", () => {
    let state = scrollThrough([0, 500]);
    expect(state.collapsed).toBe(true);
    state = nextHeaderState(state, { y: 200, pinned: false });
    expect(state.collapsed).toBe(false);
    state = nextHeaderState(state, { y: 600, pinned: false });
    expect(state.collapsed).toBe(true);
  });
});
