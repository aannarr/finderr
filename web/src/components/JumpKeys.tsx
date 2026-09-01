/**
 * The DOM half of Alt-to-jump: which cards are on screen, and clicking one.
 *
 * `lib/jump-keys.ts` owns which key means which POSITION. This owns which card is at a
 * position right now, which is a question only the browser can answer -- and the answer
 * changes on every scroll, which is why positions are assigned live rather than baked in
 * when a grid renders.
 *
 * > [!IMPORTANT] VISIBLE, AND IN DOCUMENT ORDER. Both halves matter.
 * > Visible, because a label on a card below the fold addresses something the reader
 * > cannot see and did not mean. Document order, because registration order is MOUNT
 * > order: React does not mount a list top-to-bottom in any guaranteed way, a `memo`'d
 * > card that never re-rendered never re-registers, and "load more" appends a page whose
 * > cards mount after cards that are visually above them. Sorting by
 * > `compareDocumentPosition` at assignment time is what keeps `Alt+1` on the top-left
 * > card instead of on whichever one React happened to touch first.
 *
 * The labels are drawn ONLY WHILE ALT IS HELD. A permanent badge on every card is thirty
 * five pieces of chrome over the artwork for a feature most readers never use; holding the
 * modifier is also exactly when the answer is wanted, so the reveal teaches the shortcut
 * to anybody who presses Alt for any reason at all.
 */

import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { jumpIndexFor, jumpLabelAt } from "../lib/jump-keys";

interface JumpRegistry {
  /** Register a card's element; returns the unsubscribe. */
  register: (el: HTMLElement) => () => void;
  /** The label for this element right now, or null: not visible, or past the alphabet. */
  labelOf: (el: HTMLElement | null) => string | null;
  /**
   * Bumped whenever the assignment changes.
   *
   * Its only job is to make the CONTEXT VALUE change when nothing else in it did, so
   * every card re-renders and re-reads `labelOf`. The labels live in a ref rather than in
   * state because they are keyed on elements and read imperatively; without this counter
   * a reassignment would be invisible to React.
   */
  version: number;
  /** Is Alt held right now? The badges follow this and nothing else. */
  armed: boolean;
}

/**
 * No provider means no jump keys, silently.
 *
 * That is the guard that keeps this off the pages the feature is not for: `TitleCard` asks
 * unconditionally, and on a page with no provider it is told there is no label. Nothing
 * has to maintain a list of routes to skip.
 */
const JumpContext = createContext<JumpRegistry | null>(null);

/**
 * Scope for a set of jumpable cards. Mounted ONCE, in `RootLayout`.
 *
 * > [!IMPORTANT] One scope for the app, not one per route, and not one per shelf
 * > Per-shelf would be the obvious reading of "number the visible cards" and it is wrong:
 * > the front page draws a dozen shelves, so `Alt+1` would address a different card in
 * > each of them and none of them in particular.
 * >
 * > At the root it needs no list of routes to skip either, because the scope boundary
 * > already exists in the component tree: `TitleCard` is reachable only through
 * > `TitleGrid` and `Shelf`, which only the four grid routes render. The title page, the
 * > account page and the admin page contribute no elements, so they are numbered zero
 * > cards without anybody maintaining a rule saying so. Sign-in is a separate bundle that
 * > never mounts the router at all.
 */
export function JumpKeysProvider({ children }: { children: ReactNode }) {
  const elements = useRef(new Set<HTMLElement>());
  const visible = useRef(new Set<HTMLElement>());
  const labels = useRef(new Map<HTMLElement, string>());
  const observer = useRef<IntersectionObserver | null>(null);
  const [version, setVersion] = useState(0);
  const [armed, setArmed] = useState(false);

  /**
   * Recompute the assignment from what is visible, in document order.
   *
   * Coalesced through a frame because the observer fires in bursts -- one scroll delivers
   * every card that crossed the edge as separate entries -- and re-sorting per entry would
   * do the same work a dozen times for one result.
   */
  const pending = useRef(0);
  const reassign = useCallback(() => {
    if (pending.current) return;
    pending.current = requestAnimationFrame(() => {
      pending.current = 0;
      const ordered = [...visible.current].sort((a, b) =>
        // 4 is DOCUMENT_POSITION_FOLLOWING: `a` comes before `b` in the document.
        a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
      );
      const next = new Map<HTMLElement, string>();
      ordered.forEach((el, i) => {
        const label = jumpLabelAt(i);
        if (label) next.set(el, label);
      });
      labels.current = next;
      setVersion((v) => v + 1);
    });
  }, []);

  useEffect(() => {
    /*
      A card counts as visible once ANY of it is on screen.

      Threshold 0 rather than "mostly visible": a shelf is a horizontal scroller whose
      last card is always half cut off at the right edge, and that card is very much one
      a reader can see and mean. The rootMargin trims the very edges so a card one pixel
      into view -- which a reader has not really registered -- does not take a low number
      away from one they are looking at.
    */
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const el = entry.target as HTMLElement;
          if (entry.isIntersecting) visible.current.add(el);
          else visible.current.delete(el);
        }
        reassign();
      },
      { threshold: 0, rootMargin: "-8px" },
    );
    observer.current = io;
    for (const el of elements.current) io.observe(el);
    return () => {
      io.disconnect();
      observer.current = null;
      if (pending.current) cancelAnimationFrame(pending.current);
    };
  }, [reassign]);

  const register = useCallback(
    (el: HTMLElement) => {
      elements.current.add(el);
      observer.current?.observe(el);
      return () => {
        elements.current.delete(el);
        visible.current.delete(el);
        observer.current?.unobserve(el);
        reassign();
      };
    },
    [reassign],
  );

  useEffect(() => {
    /*
      THE LISTENER IS ON `window` AND DOES NOT CHECK THE CARET, unlike `useKeyAction`.

      That is the one deliberate difference from every other shortcut in this app, and it
      is safe for the reason the search box makes it necessary: the box is autofocused and
      holds the caret almost permanently, so a caret check would mean the feature never
      works. An Alt chord produces no character in a text field on any platform this runs
      on -- on macOS Option composes one, which is exactly why the match reads `code` and
      not `key` -- so nothing is being stolen from the typist.
    */
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey && !event.metaKey && !event.ctrlKey) setArmed(true);
      const index = jumpIndexFor(event);
      if (index === null) return;
      const label = jumpLabelAt(index);
      const target = label ? [...labels.current.entries()].find(([, l]) => l === label)?.[0] : undefined;
      if (!target) return;
      // The card's own primary link, which owns where it goes and the prefetch on the way.
      // Clicking it rather than navigating here means this file holds no route knowledge.
      const link = target.querySelector<HTMLElement>("a[href]");
      if (!link) return;
      event.preventDefault();
      link.click();
    };
    // Alt released, or focus left the window while it was held -- a badge that outlives
    // the modifier is chrome nobody asked for and cannot dismiss.
    const disarm = () => setArmed(false);
    const onKeyUp = (event: KeyboardEvent) => {
      if (!event.altKey) disarm();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", disarm);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", disarm);
    };
  }, []);

  const labelOf = useCallback((el: HTMLElement | null) => (el ? (labels.current.get(el) ?? null) : null), []);

  return (
    <JumpContext.Provider value={{ register, labelOf, version, armed }}>{children}</JumpContext.Provider>
  );
}

/**
 * A card's jump key: the ref to attach, and the label it currently answers to.
 *
 * `label` is `null` on every page with no provider, on every card below the fold, and on
 * everything past the thirty-fifth visible card -- three different reasons for the same
 * "nothing to draw", which is the point of returning one value rather than three flags.
 */
export function useJumpKey(): {
  ref: (el: HTMLElement | null) => void;
  label: string | null;
  armed: boolean;
} {
  const ctx = useContext(JumpContext);
  const node = useRef<HTMLElement | null>(null);
  const cleanup = useRef<(() => void) | null>(null);

  /*
    NO SUBSCRIPTION AND NO FORCED RE-RENDER: the context IS the subscription.

    `JumpKeysProvider` publishes a fresh value whenever `version` or `armed` moves, and a
    context update re-renders every consumer -- `memo` does not stop it, which is the one
    thing worth knowing here, because `TitleCard` is memoised and its props do not change
    when its number does. So reading `labelOf` during render is enough, and the `version`
    field's whole job is to make the value change when only the label map did.
  */
  const ref = useCallback(
    (el: HTMLElement | null) => {
      // A callback ref is called with null before the next element, and on unmount.
      cleanup.current?.();
      cleanup.current = null;
      node.current = el;
      if (ctx && el) cleanup.current = ctx.register(el);
    },
    [ctx],
  );
  useEffect(() => () => cleanup.current?.(), []);

  return { ref, label: ctx?.labelOf(node.current) ?? null, armed: ctx?.armed ?? false };
}

/**
 * The badge, drawn over the poster's top-left corner while Alt is held.
 *
 * `aria-hidden`, like every other `<kbd>` in this app: it would otherwise land inside the
 * card's accessible name and a reader would hear "3 Details for Inception". The shortcut
 * reaches them through `aria-keyshortcuts` on the link instead, which is the attribute
 * that exists for it.
 */
export function JumpBadge({ label }: { label: string }) {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-black/45"
    >
      <kbd className="rounded border border-line bg-surface px-2 py-1 font-sans text-base leading-none font-medium text-ink uppercase">
        {label}
      </kbd>
    </span>
  );
}
