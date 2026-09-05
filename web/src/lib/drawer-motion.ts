/**
 * WHEN THE ASSISTANT DRAWER SLIDES, AND FOR HOW LONG.
 *
 * Three small facts that `Assistant` and `AssistantPanel` both need and neither should own:
 * how long the motion lasts, whether the viewport is the one where the drawer covers
 * everything, and what a reader who asked for less motion gets. Pure and DOM-light on
 * purpose -- every function here is decidable from a stubbed `matchMedia`, which is what
 * lets the rules be tested without a browser.
 *
 * > [!IMPORTANT] `DRAWER_MS` IS A COPY, and `styles.test.ts` is what stops it drifting
 * > The authority is `--fdr-drawer-ms` in `styles.css`, because the enter keyframe and the
 * > exit transition are both CSS. This module holds the same number for the JS half -- the
 * > timer that keeps the panel mounted while it slides out. A JS value SHORTER than the CSS
 * > makes the drawer vanish mid-slide; LONGER, and the page underneath sits behind an
 * > invisible panel that still eats taps. Neither fails loudly, so the pair is pinned by a
 * > test rather than by a comment. Same trade `field-zoom.ts` takes with `--field-font-size`.
 */

/** The one duration, in milliseconds. Must equal `--fdr-drawer-ms` in `styles.css`. */
export const DRAWER_MS = 220;

/**
 * Tailwind's `sm`, spelled as a media query.
 *
 * The drawer is `w-full sm:w-[26rem]` and its scrim is `sm:hidden`, so this exact boundary
 * is already what decides "does the panel cover the whole screen". Asking the same question
 * in JavaScript with a different number would give the retraction rule a second, disagreeing
 * owner -- there would be a band of widths where the page is visible beside the panel and the
 * panel retracts anyway, or worse, the reverse.
 */
export const SM_QUERY = "(min-width: 40rem)";

/** `matchMedia`, or `null` where there is none -- a test runner, or a server render. */
function mql(query: string): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia(query);
}

/**
 * Is the drawer the WHOLE SCREEN right now?
 *
 * The question the retract-on-navigation rule turns on, and it is about the viewport rather
 * than about the device: a desktop window dragged narrow gets the covering drawer and should
 * get the retraction with it, and a tablet held wide gets neither.
 *
 * **Defaults to `false` where it cannot be answered.** Nothing renders this in a headless
 * environment, but if anything ever does, the failure of a wrong guess is asymmetric --
 * a false negative leaves the panel open, which is today's behaviour, and a false positive
 * closes a panel on a reader who was reading it.
 */
export function isCompactViewport(): boolean {
  const m = mql(SM_QUERY);
  return m ? !m.matches : false;
}

/**
 * How long to hold the panel mounted after asking it to leave.
 *
 * Zero under `prefers-reduced-motion`, because the global rule in `styles.css` floors every
 * transition in the document at 0.01ms -- so the panel is already gone from the screen and
 * the only thing the full delay would buy is a fifth of a second of an invisible element
 * still swallowing taps over the page the reader just navigated to.
 *
 * A missing `matchMedia` is treated as "reduce", matching `prefersReducedMotion` in
 * `easter-eggs.ts`: the environments without one are the ones with no compositor to animate
 * on, and an unmount that happens too early is invisible while one that happens too late is
 * a component leaking past the end of a test.
 */
export function drawerMs(): number {
  const m = mql("(prefers-reduced-motion: reduce)");
  if (!m || m.matches) return 0;
  return DRAWER_MS;
}
