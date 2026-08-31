/**
 * When the sticky header's search box collapses, as a pure function.
 *
 * Kept out of the component and out of the effect for the same reason `pollWhileWorking`
 * is (`./use-title-detail.ts`): the policy is the part with decisions in it, the effect is
 * plumbing, and a policy tested through a scroll event is a policy nobody tests. Everything
 * here is a pure reducer over a scroll position -- no DOM, no React, no listeners.
 *
 * The rule in one sentence: **collapse only while scrolling DOWN, past the fold, and only
 * when the reader is not using the box.**
 */

/**
 * How far the page must have scrolled before collapsing is allowed at all.
 *
 * Below this the header is still visually part of the top of the page and hiding the box
 * would be a flicker rather than a reclaim of space. It is deliberately larger than
 * `SCROLL_STEP` so a short flick near the top can never collapse anything.
 */
export const COLLAPSE_AFTER_PX = 120;

/**
 * How many pixels of travel in one direction count as a deliberate scroll.
 *
 * Without it, iOS rubber-banding and a trackpad's momentum tail produce single-pixel
 * direction flips and the box flutters open and shut. This is hysteresis, not a delay:
 * a real scroll clears it in one frame, and jitter never does.
 */
export const SCROLL_STEP_PX = 12;

export interface HeaderState {
  /** Is the search box collapsed to its button? */
  collapsed: boolean;
  /** The scroll position this state was decided at -- the reference for the next step. */
  anchorY: number;
}

export interface ScrollInput {
  /** `window.scrollY`. */
  y: number;
  /**
   * Must the box stay open regardless of scrolling?
   *
   * True while the box has focus or holds a query. Collapsing the control somebody is
   * typing into is the one behaviour that would make this feature worse than no feature,
   * and a reader who has a query on screen is mid-task even if the caret is elsewhere.
   */
  pinned: boolean;
}

export const INITIAL_HEADER_STATE: HeaderState = { collapsed: false, anchorY: 0 };

/**
 * The next header state, given where the page is now.
 *
 * Returns the SAME OBJECT when nothing changed, so a caller can `if (next === prev) return`
 * and skip the re-render. A scroll listener fires per frame; allocating and re-rendering on
 * every one of those is how a header animation becomes a jank source.
 */
export function nextHeaderState(prev: HeaderState, input: ScrollInput): HeaderState {
  // iOS reports a negative scrollY while rubber-banding at the top. Clamping rather than
  // special-casing: past the clamp it is simply "at the top", which is what it looks like.
  const y = Math.max(0, input.y);

  // Both overrides expand rather than merely refusing to collapse, because both describe a
  // reader who wants the box: one is at the top of the page, the other is using it.
  if (input.pinned || y <= COLLAPSE_AFTER_PX) {
    return prev.collapsed || prev.anchorY !== y ? { collapsed: false, anchorY: y } : prev;
  }

  const moved = y - prev.anchorY;
  if (moved >= SCROLL_STEP_PX) return { collapsed: true, anchorY: y };
  if (moved <= -SCROLL_STEP_PX) return { collapsed: false, anchorY: y };

  /*
    Inside the dead zone the anchor deliberately does NOT move, and that is what makes the
    threshold reject JITTER rather than SLOWNESS.

    Oscillation around one position never gets a full step from the anchor, so it never
    fires. A slow steady drag delivering 3px at a time does -- it crosses the step on its
    fourth event and collapses, which is right: that is a scroll, just an unhurried one.
    Advancing the anchor here would invert both halves.
  */
  return prev;
}
