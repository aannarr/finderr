/**
 * The other half of the iOS focus-zoom guard. The CSS half is in `styles.css`.
 *
 * > [!IMPORTANT] 16px IS NOT A FLOOR, IT IS A RENDERED SIZE -- and that is the whole bug here
 * > Safari's heuristic reads the size the field ACTUALLY RENDERS AT, after page scale. A
 * > 16px control on a page sitting at scale 0.84 renders at 13.4pt, so the browser zooms
 * > exactly as it would for a 13px control on an unscaled page. The stylesheet cannot see
 * > the scale, so a static `font-size: 16px` is correct only while the scale is 1 -- and
 * > the page does not stay at 1.
 *
 * Where a sub-1 scale comes from, both measured on a real iPhone rather than reasoned about:
 * Safari's per-site **Page Zoom** (aA menu, a preset like 85%, persisted per website and
 * across restarts), and the aftermath of the auto-zoom itself, which zooms IN and never
 * returns -- pinching back out lands wherever the fingers stop, not at 1.0. Either way the
 * page is left below 1 and every subsequent focus re-triggers the zoom. That loop is what
 * this module breaks.
 *
 * It publishes ONE custom property, `--field-font-size`, which is the author size a control
 * needs in order to RENDER at the threshold. At scale 1 it is exactly 16px and nothing on
 * the page moves, which is the case every desktop and most phones are in.
 *
 * It deliberately does NOT try to correct the scale itself. `visualViewport` is read-only,
 * the scale is the reader's own choice as often as it is an accident, and a page that
 * fights a pinch is worse than one that zooms.
 */

/** Safari's threshold. Below this a focused control zooms the page; at or above it does not. */
export const ZOOM_THRESHOLD_PX = 16;

/**
 * The largest author size the compensation will ask for.
 *
 * > [!IMPORTANT] A BIGGER NUMBER HERE DOES NOT MEAN A BIGGER FIELD ON SCREEN
 * > The scale applies to the whole page, so a 32px control at scale 0.5 occupies exactly
 * > the room a 16px one does at scale 1. The compensation RESTORES the proportion the
 * > reader's zoom took away; it does not add size to a layout. That is why the cap is set
 * > by what the reader can actually ask for rather than by what looks large in the source.
 *
 * 32px is `16 / 0.5`, and **0.5 is the smallest Page Zoom preset Safari offers**, so every
 * scale a reader can choose is covered. A first pass capped this at 24 on a layout argument
 * that does not hold, and `field-zoom.test.ts` caught it: 24px at the 50% preset renders at
 * 12pt, four under the threshold, so the zoom survived at the one setting furthest out.
 *
 * The cap still exists for the case below any preset: shrink-to-fit can put a page at 0.14,
 * which would ask for a 114px field. That page has a different problem and the compensation
 * declines to make it worse.
 */
export const MAX_FIELD_FONT_PX = 32;

/** The custom property both halves agree on. The stylesheet's fallback is the same 16px. */
export const FIELD_FONT_VAR = "--field-font-size";

/**
 * The author `font-size` a form control needs so it renders at the threshold under `scale`.
 *
 * Pure, and the only place the arithmetic lives. A scale at or above 1 needs no help; an
 * absent, zero or nonsense scale is treated as 1, because "I cannot measure the scale" and
 * "the scale is fine" want the same answer -- the plain 16px the stylesheet would have used
 * on its own.
 *
 * Rounded UP to two decimals: rounding down lands a hair under the threshold and buys the
 * bug back for a fraction of a pixel.
 */
export function fieldFontSize(scale: number | undefined | null): number {
  if (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0 || scale >= 1) {
    return ZOOM_THRESHOLD_PX;
  }
  const wanted = Math.ceil((ZOOM_THRESHOLD_PX / scale) * 100) / 100;
  return Math.min(wanted, MAX_FIELD_FONT_PX);
}

/** The window surface this needs, so a test can hand it an object instead of a browser. */
export interface ScaleSource {
  visualViewport: {
    scale: number;
    addEventListener(type: string, fn: () => void): void;
    removeEventListener(type: string, fn: () => void): void;
  } | null;
  document: { documentElement: { style: { setProperty(name: string, value: string): void } } };
}

/**
 * Publish `--field-font-size` and keep it in step with the page scale.
 *
 * `visualViewport` fires `resize` on every scale change, including the involuntary zoom
 * itself, so the property is correct by the time the reader gets back to a field. It is
 * also written once on install, which is what covers a Page Zoom that was already in force
 * when the app opened.
 *
 * Returns an unsubscribe. Both entry points call this and neither unsubscribes -- the
 * return value exists so a test can clean up after itself.
 */
export function watchFieldScale(win: ScaleSource): () => void {
  const vv = win.visualViewport;
  const apply = () => {
    win.document.documentElement.style.setProperty(FIELD_FONT_VAR, `${fieldFontSize(vv?.scale)}px`);
  };
  apply();
  if (!vv) return () => {};
  vv.addEventListener("resize", apply);
  return () => vv.removeEventListener("resize", apply);
}
