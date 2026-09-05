import { describe, expect, test } from "bun:test";
import {
  FIELD_FONT_VAR,
  fieldFontSize,
  MAX_FIELD_FONT_PX,
  type ScaleSource,
  watchFieldScale,
  ZOOM_THRESHOLD_PX,
} from "./field-zoom";

/**
 * The arithmetic is the whole feature, and it is the half no browser is needed for.
 * `styles.test.ts` pins the stylesheet's side of the same contract.
 */
describe("fieldFontSize", () => {
  test("an unscaled page gets the plain threshold and nothing moves", () => {
    expect(fieldFontSize(1)).toBe(ZOOM_THRESHOLD_PX);
  });

  test("a zoomed-IN page gets the threshold too -- it is already above it", () => {
    // The auto-zoom itself puts the page here. Shrinking the field in response would be
    // a second bug chasing the first one round.
    expect(fieldFontSize(1.4)).toBe(ZOOM_THRESHOLD_PX);
  });

  test("0.84 -- the scale measured on the phone that reported this -- clears the threshold", () => {
    const size = fieldFontSize(0.84);
    // The property that matters is not the number, it is that the number RENDERS at or
    // above 16 once the page scale is applied to it. Asserting 19.05 would pin the
    // rounding; asserting this pins the reason the rounding exists.
    expect(size * 0.84).toBeGreaterThanOrEqual(ZOOM_THRESHOLD_PX);
  });

  test("EVERY Page Zoom preset Safari offers clears it, including the smallest", () => {
    // This is the test that earned the cap its value. It failed at 0.5 against a cap of 24
    // (24 * 0.5 = 12pt rendered, four under the threshold) -- the zoom surviving at exactly
    // the setting a reader who needs zoom is most likely to be on.
    for (const scale of [0.5, 0.75, 0.85, 0.9, 1]) {
      expect(fieldFontSize(scale) * scale).toBeGreaterThanOrEqual(ZOOM_THRESHOLD_PX);
    }
  });

  test("it rounds UP, because a hair under the threshold is the bug", () => {
    // 16 / 0.85 = 18.8235..., and 18.82 renders at 15.997.
    expect(fieldFontSize(0.85)).toBe(18.83);
  });

  test("shrink-to-fit, which is below every preset, is capped rather than obeyed", () => {
    // 16 / 0.14 = 114px. That page is not zoomed, it is broken, and asking for a 114px
    // field does not fix it.
    expect(fieldFontSize(0.14)).toBe(MAX_FIELD_FONT_PX);
  });

  test("an unmeasurable scale falls back to the plain threshold", () => {
    // `visualViewport` is absent on older browsers, and 0 / NaN are what a broken one
    // reports. All three want the stylesheet's own value, never a division by zero.
    for (const bad of [undefined, null, 0, Number.NaN, -1]) {
      expect(fieldFontSize(bad)).toBe(ZOOM_THRESHOLD_PX);
    }
  });
});

/** A fake `visualViewport` -- one scale, one listener, and a way to move both. */
function fakeWindow(scale: number) {
  const listeners: Array<() => void> = [];
  const written: string[] = [];
  const win: ScaleSource = {
    visualViewport: {
      get scale() {
        return scale;
      },
      addEventListener: (_type, fn) => {
        listeners.push(fn);
      },
      removeEventListener: (_type, fn) => {
        const i = listeners.indexOf(fn);
        if (i !== -1) listeners.splice(i, 1);
      },
    },
    document: {
      documentElement: {
        style: {
          setProperty: (name, value) => {
            written.push(`${name}: ${value}`);
          },
        },
      },
    },
  };
  return {
    win,
    written,
    listeners,
    zoomTo(next: number) {
      scale = next;
      for (const fn of [...listeners]) fn();
    },
  };
}

describe("watchFieldScale", () => {
  test("it writes the property once on install, before any event", () => {
    // This is the case that matters most: a Page Zoom already in force when the app
    // opens fires no `resize`, so an install that only subscribed would never run.
    const { win, written } = fakeWindow(0.84);
    watchFieldScale(win);
    expect(written).toHaveLength(1);
    expect(written[0]).toBe(`${FIELD_FONT_VAR}: ${fieldFontSize(0.84)}px`);
  });

  test("it follows the scale when the reader pinches", () => {
    const h = fakeWindow(1);
    watchFieldScale(h.win);
    expect(h.written.at(-1)).toBe(`${FIELD_FONT_VAR}: 16px`);
    h.zoomTo(0.5);
    expect(h.written.at(-1)).toBe(`${FIELD_FONT_VAR}: ${fieldFontSize(0.5)}px`);
  });

  test("unsubscribing detaches the listener", () => {
    const h = fakeWindow(1);
    watchFieldScale(h.win)();
    expect(h.listeners).toHaveLength(0);
  });

  test("a browser with no visualViewport still gets the plain threshold", () => {
    const written: string[] = [];
    const stop = watchFieldScale({
      visualViewport: null,
      document: {
        documentElement: {
          style: { setProperty: (name, value) => written.push(`${name}: ${value}`) },
        },
      },
    });
    expect(written).toEqual([`${FIELD_FONT_VAR}: ${ZOOM_THRESHOLD_PX}px`]);
    // And the returned teardown is safe to call even though nothing was subscribed.
    expect(() => stop()).not.toThrow();
  });
});
