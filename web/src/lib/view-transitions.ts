/**
 * Navigation motion: which transition a navigation gets, and which element flies.
 *
 * The browser does the work -- `document.startViewTransition` is a platform API, and
 * TanStack Router already wraps every navigation in it (`viewTransition` on a `Link`,
 * `defaultViewTransition` on the router, feature-detected in `router-core`). This file owns
 * the two decisions the router has no opinion about:
 *
 * 1. **WHICH transition**, as a view-transition TYPE the CSS selects on. The router resolves
 *    `types` per navigation from `getLocationChangeInfo`, so `:active-view-transition-type()`
 *    in `styles.css` is what actually differs between going deeper and coming back.
 * 2. **WHICH element is the shared one**, via `view-transition-name`.
 *
 * > [!IMPORTANT] `view-transition-name` must be UNIQUE among rendered elements, and a
 * > duplicate SILENTLY skips the whole transition
 * > Not just the duplicated pair -- the entire animation, with no error and no warning
 * > anybody will see. That is the trap this file exists to make unfalliable, and the fix is
 * > structural rather than careful: the name is the CONSTANT `poster`, never
 * > `poster-${tconst}`. Only one element on the source page and one on the destination ever
 * > wears it, so uniqueness is not a property anybody has to maintain. Keying on the title
 * > id would be exactly wrong here, because the same title legitimately appears on three
 * > shelves of one grid.
 *
 * > [!CAUTION] The name is written to the DOM node directly, NOT through React state
 * > A click handler runs synchronously before the router starts the transition, so a direct
 * > `el.style.viewTransitionName = ...` is guaranteed to be in place when the browser takes
 * > its snapshot. A `setState` is batched into React's own transition and may land AFTER the
 * > capture, which produces a navigation that animates on some clicks and not others -- the
 * > worst possible failure, because it looks like flakiness rather than a bug.
 */

/** The one shared-element name in the product. See the caution above for why it is constant. */
export const POSTER_TRANSITION_NAME = "poster";

/**
 * Navigation types the stylesheet selects on.
 *
 * `deeper` is going from a list to one thing, `back` is the reverse, `lateral` is everything
 * else (grid to grid, section to section). Three rather than two because a sideways move
 * should not pretend to be a descent: sliding "forward" into a different section reads as
 * progress the reader did not make.
 */
export type NavKind = "deeper" | "back" | "lateral";

/**
 * How deep a path is, for deciding which way the content slides.
 *
 * Segment count is the whole heuristic and it is deliberately crude. `/` is 0, `/browse` is
 * 1, `/title/tt0111161` is 2 -- so grid to title is a descent and the reverse is a return,
 * which is the only distinction the motion needs to carry. It cannot know that
 * `/person/x` -> `/title/y` is "sideways-ish", and it does not need to: both are two
 * segments, so it says `lateral` and the page cross-fades, which is the honest answer for a
 * move whose direction nobody could name.
 */
function depthOf(pathname: string): number {
  return pathname.split("/").filter(Boolean).length;
}

/**
 * Which transition a navigation gets.
 *
 * Pure, and exported for the tests: the router calls it inside a callback that is awkward to
 * drive, and the rule is worth pinning independently of the plumbing.
 */
export function navKind(from: string, to: string): NavKind {
  if (from === to) return "lateral";
  const a = depthOf(from);
  const b = depthOf(to);
  if (b > a) return "deeper";
  if (b < a) return "back";
  return "lateral";
}

/**
 * Does this reader want motion at all?
 *
 * Read at the moment of navigating rather than cached, because the OS setting can change
 * while a tab is open and a cached answer would need an invalidation nobody would write.
 * Anything that cannot answer (no `matchMedia`, as in a test environment) is treated as
 * "reduced" -- the accessible default is the safe one when we do not know.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Whether this browser can do same-document view transitions at all. */
export function viewTransitionsSupported(): boolean {
  return typeof document !== "undefined" && typeof document.startViewTransition === "function";
}

/**
 * Mark one element as the poster that should fly on the NEXT navigation.
 *
 * Call it from a click handler, before navigating. It clears itself when the transition
 * settles, and that cleanup is the part that matters: a name left on a card that is still
 * mounted collides with the next navigation's name and silently kills that transition --
 * the failure is never on the click you are looking at.
 *
 * `document.startViewTransition` may not exist, and there may be no transition in flight by
 * the time this resolves, so the cleanup is ALSO scheduled on a timer. Belt and braces on
 * purpose: leaking the name is the one outcome with a lasting consequence.
 */
export function claimPosterTransition(el: HTMLElement | null): void {
  if (!el || !viewTransitionsSupported() || prefersReducedMotion()) return;

  // Only ever ONE claim outstanding. A second click before the first navigation settles
  // would otherwise leave two elements wearing the name, which is the duplicate this whole
  // file exists to prevent -- and it is reachable by an impatient reader, not just in theory.
  releaseClaims();

  el.style.viewTransitionName = POSTER_TRANSITION_NAME;
  claimed.add(el);

  // The router starts the transition AFTER this handler returns, so there is nothing to
  // await yet -- `installTransitionTracking` releases the claim when the transition it
  // starts settles. This timer is the fallback for the navigation that never happens
  // (a modified click, a blocked route, an unsupported browser slipping through), and it is
  // longer than any transition this product defines so it never fires first.
  window.clearTimeout(claimTimer);
  claimTimer = window.setTimeout(releaseClaims, 2000);
}

/** Elements currently wearing the shared name. At most one, and usually none. */
const claimed = new Set<HTMLElement>();
let claimTimer = 0;

/** Take the name back off. Idempotent, so both the timer and the transition may call it. */
function releaseClaims(): void {
  for (const el of claimed) el.style.viewTransitionName = "";
  claimed.clear();
}

/**
 * Watch `document.startViewTransition` so a claim is released when the ROUTER's transition
 * settles, rather than on a timer that is always either too early or too late.
 *
 * Patching a platform API is not free and is worth justifying: the alternative is calling
 * `startViewTransition` ourselves and driving the navigation inside it, which means
 * reimplementing what `router-core` already does correctly -- its feature detection, its
 * `types` support probe, its fallback when types are unsupported. Wrapping is the smaller
 * lie. It is installed once, is idempotent, calls through unconditionally, and never decides
 * anything: it observes, and releases a name we put on.
 */
export function installTransitionTracking(): void {
  if (!viewTransitionsSupported()) return;
  const doc = document as Document & { __finderrVtPatched?: boolean };
  if (doc.__finderrVtPatched) return;
  doc.__finderrVtPatched = true;

  const original = document.startViewTransition.bind(document);
  document.startViewTransition = ((arg?: unknown) => {
    const t = original(arg as never);
    void t.finished.finally(() => {
      window.clearTimeout(claimTimer);
      releaseClaims();
    });
    return t;
  }) as typeof document.startViewTransition;
}
