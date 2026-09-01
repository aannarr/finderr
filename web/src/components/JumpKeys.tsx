/**
 * The DOM half of navigation mode: which cards are on screen, and clicking one.
 *
 * `lib/jump-keys.ts` owns which key means which POSITION. This owns which card is at a
 * position right now, which is a question only the browser can answer -- and the answer
 * changes on every scroll, which is why positions are assigned live rather than baked in
 * when a grid renders.
 *
 * The shape, end to end: `⌘/` (`Ctrl+/`) labels every card on screen, one bare key opens
 * one, Escape leaves. Nothing is drawn until a reader asks for it -- a permanent badge on
 * every card is thirty-five pieces of chrome over the artwork for a feature most people
 * never use.
 *
 * > [!IMPORTANT] VISIBLE, AND IN DOCUMENT ORDER. Both halves matter.
 * > Visible, because a label on a card below the fold addresses something the reader
 * > cannot see and did not mean. Document order, because registration order is MOUNT
 * > order: React does not mount a list top-to-bottom in any guaranteed way, a `memo`'d
 * > card that never re-rendered never re-registers, and "load more" appends a page whose
 * > cards mount after cards that are visually above them. Sorting by
 * > `compareDocumentPosition` at assignment time is what keeps `1` on the top-left card
 * > instead of on whichever one React happened to touch first.
 *
 * > [!CAUTION] THE MODE LISTENS IN THE CAPTURE PHASE, and that is not a detail
 * > Every other shortcut in this app hangs a BUBBLE-phase listener on `window`
 * > (`useKeyAction`). Escape already means `back` on the title page and `clearFilters` on
 * > the grids -- so if the mode listened in the same phase, leaving the mode with Escape
 * > would ALSO clear the reader's filters, and which of the two happened would depend on
 * > which component mounted first. Capture runs before any of them, and the mode calls
 * > `stopPropagation` on everything it consumes, so while it is open it is the only thing
 * > reading the keyboard. That is what "mode" has to mean to be worth having.
 */

import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { jumpLabelAt, jumpLabelFor } from "../lib/jump-keys";
import { HOST_PLATFORM, KEYMAP, matchesBinding } from "../lib/keymap";

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
  /** Is navigation mode open? The badges follow this and nothing else. */
  active: boolean;
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
  const [active, setActive] = useState(false);
  // Read inside the listener, which is registered once. Without this the handler would
  // close over the first `false` forever, or the listener would re-subscribe per toggle.
  const isActive = useRef(false);
  isActive.current = active;

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
    const close = () => setActive(false);

    const open = () => {
      /*
        BLUR THE CARET ON THE WAY IN. The search box is autofocused and holds focus almost
        permanently, so without this the very first hint key would type a letter into the
        query instead of opening a card -- the mode would look broken and would corrupt
        what the reader had typed. Blurring is also what makes the mode honest: it is not
        a mode if the text field is still collecting characters underneath it.
      */
      (document.activeElement as HTMLElement | null)?.blur?.();
      setActive(true);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      // The one way IN, and the only part of this that is a named binding. It carries
      // `mod`, so `firesFrom` lets it through the caret in the search box -- which is
      // where a reader almost always is when they want it.
      if (matchesBinding(event, KEYMAP.jumpMode, HOST_PLATFORM)) {
        event.preventDefault();
        event.stopPropagation();
        isActive.current ? close() : open();
        return;
      }
      if (!isActive.current) return;

      /*
        FROM HERE DOWN THE MODE OWNS THE KEYBOARD, which is the whole point of it being a
        mode: `stopPropagation` in the capture phase keeps every `useKeyAction` listener
        from also seeing these. Escape in particular already means `back`/`clearFilters`,
        and leaving the mode must not also wipe the reader's filters.
      */
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }

      const label = jumpLabelFor(event);
      if (label === null) {
        // A modified chord is somebody else's -- `⌘R` is a reload and swallowing it would
        // make this a trap. Anything else unlabelled closes the mode rather than sitting
        // there eating keystrokes: a reader who typed a letter meant to search, not to
        // pick, and the fastest way out of a mode you did not want is any key at all.
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        event.stopPropagation();
        close();
        return;
      }

      const target = [...labels.current.entries()].find(([, l]) => l === label)?.[0];
      event.preventDefault();
      event.stopPropagation();
      close();
      if (!target) return;
      // The card's own primary link, which owns where it goes and the prefetch on the way.
      // Clicking it rather than navigating here means this file holds no route knowledge.
      target.querySelector<HTMLElement>("a[href]")?.click();
    };

    /*
      Capture, not bubble -- see the caution at the top of this file. Registered once and
      reading `isActive` through a ref, so toggling the mode never re-subscribes.
    */
    window.addEventListener("keydown", onKeyDown, true);
    // Anything that moves the page invalidates the labels a reader is looking at, so the
    // mode closes rather than pointing at cards that have scrolled away. A badge that
    // outlives the reader's attention is chrome they did not ask for and cannot dismiss.
    window.addEventListener("blur", close);
    window.addEventListener("scroll", close, { passive: true });
    window.addEventListener("pointerdown", close);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("scroll", close);
      window.removeEventListener("pointerdown", close);
    };
  }, []);

  const labelOf = useCallback((el: HTMLElement | null) => (el ? (labels.current.get(el) ?? null) : null), []);

  return (
    <JumpContext.Provider value={{ register, labelOf, version, active }}>{children}</JumpContext.Provider>
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
  active: boolean;
} {
  const ctx = useContext(JumpContext);
  const node = useRef<HTMLElement | null>(null);
  const cleanup = useRef<(() => void) | null>(null);

  /*
    NO SUBSCRIPTION AND NO FORCED RE-RENDER: the context IS the subscription.

    `JumpKeysProvider` publishes a fresh value whenever `version` or `active` moves, and a
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

  return { ref, label: ctx?.labelOf(node.current) ?? null, active: ctx?.active ?? false };
}

/**
 * The badge, drawn over a card's poster while navigation mode is open.
 *
 * `aria-hidden`, like every other `<kbd>` in this app: it would otherwise land inside the
 * card's accessible name and a reader would hear "3 Details for Inception". The shortcut
 * reaches them through `aria-keyshortcuts` on the link instead, which is the attribute
 * that exists for it.
 *
 * It covers the poster rather than sitting in a corner, and that is deliberate: the mode
 * is transient and modal, so every labelled card should read as "pick one of these" at a
 * glance rather than as a badge somebody has to hunt for on artwork.
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
