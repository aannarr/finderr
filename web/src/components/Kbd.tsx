/**
 * The visible key, and the handler behind it -- deliberately one file.
 *
 * The product rule: THE AFFORDANCE AND THE SHORTCUT ARE THE SAME ELEMENT. Rather than a
 * help overlay nobody opens, every actionable control wears its own key, and it learns
 * that key from `lib/keymap.ts` rather than from a character typed into its label.
 *
 * `useKeyAction` is what enforces that. It binds the handler AND hands back the glyph to
 * draw on the control that runs it, from one binding, gated by one `enabled` flag. So a
 * button cannot advertise a key it does not answer to, and an action that is not live in
 * this context advertises nothing -- a glyph on a dead key is worse than no glyph.
 */

import { type ReactNode, useEffect, useRef, useSyncExternalStore } from "react";
import {
  type ActionId,
  ariaKeyShortcuts,
  firesFrom,
  glyphsFor,
  HOST_PLATFORM,
  isTypingTarget,
  KEYMAP,
  type KeyTarget,
  keyActionParts,
  matchesBinding,
  type Platform,
} from "../lib/keymap";

const KBD_CLASS =
  "rounded border border-line bg-surface-2 px-1 font-sans text-[0.75em] leading-tight text-muted";

/**
 * One key, or one chord, drawn.
 *
 * HIDDEN FROM THE ACCESSIBILITY TREE. A `<kbd>` inside a button contributes to the
 * button's accessible name, so `[Request from Radarr ⏎]` would be announced as "Request
 * from Radarr return". The shortcut reaches a reader through `aria-keyshortcuts` on the
 * control instead, which is the attribute that exists for exactly this and which
 * `useKeyAction` supplies from the same binding.
 *
 * `platform` is an argument rather than a module read so the fold can be tested both
 * ways; the default is the host, so no call site passes it.
 */
export function Kbd({ action, platform = HOST_PLATFORM }: { action: ActionId; platform?: Platform }) {
  return (
    <span className="ml-1.5 inline-flex shrink-0 items-center gap-0.5 align-middle" aria-hidden="true">
      {glyphsFor(KEYMAP[action], platform).map((glyph) => (
        <kbd key={glyph} className={KBD_CLASS}>
          {glyph}
        </kbd>
      ))}
    </span>
  );
}

/**
 * A bound action, ready to be worn by the control that runs it.
 *
 * The two halves answer different questions and `keyActionParts` (`lib/keymap.ts`) owns
 * both: `props` says which key this control ANSWERS TO, `hint` says whether that key is
 * live from where the caret is right now. A disabled action yields neither.
 */
export interface KeyAction {
  /**
   * Spread onto the control, so a screen reader is told the shortcut.
   *
   * Present whenever the action is bound, INCLUDING while the caret sits in a text box --
   * a reader is told this on focus, so withdrawing it there is how the search box lost
   * its own `/`.
   */
  props: { "aria-keyshortcuts"?: string };
  /** Rendered INSIDE that control. `null` when the key would not fire from here. */
  hint: ReactNode;
}

/**
 * Is the caret in a text box right now?
 *
 * A store rather than per-component focus handlers: every hint on the page asks the same
 * question, and one pair of document listeners answers it for all of them. `focusout`
 * fires before the next element is focused, so the reading it triggers can be transient;
 * the `focusin` immediately after corrects it, which is why both are listened to.
 */
function subscribeCaret(onChange: () => void): () => void {
  document.addEventListener("focusin", onChange);
  document.addEventListener("focusout", onChange);
  return () => {
    document.removeEventListener("focusin", onChange);
    document.removeEventListener("focusout", onChange);
  };
}

function caretInTextField(): boolean {
  return isTypingTarget(document.activeElement as KeyTarget | null);
}

/** Server-rendered markup has no focus, so nothing is suppressed there. */
const NO_CARET = () => false;

/**
 * Bind a global key to an action, and get back the glyph for the button that runs it.
 *
 * The listener is on `window` rather than on the control, because the point is that the
 * key works without tabbing to the button first. `firesFrom` is what keeps that from
 * breaking the search box; see the rule it owns.
 *
 * THE GLYPH TRACKS THE SAME RULE, AND THE ARIA ATTRIBUTE DELIBERATELY DOES NOT. The
 * search box is autofocused and holds the caret much of the time, and while it does, an
 * unmodified key is a character rather than a shortcut -- so the hint disappears exactly
 * when its key would not fire and comes back the moment focus leaves. `aria-keyshortcuts`
 * stays put through all of that, because it is read on FOCUS and the box is itself a text
 * field: gating it the same way meant focusing the box stripped its own shortcut. See
 * `keyActionParts`.
 *
 * `run` is read through a ref so an inline arrow at the call site does not re-subscribe
 * the listener on every render.
 */
export function useKeyAction(action: ActionId, run: () => void, enabled = true): KeyAction {
  const binding = KEYMAP[action];
  const latest = useRef(run);
  const caretInField = useSyncExternalStore(subscribeCaret, caretInTextField, NO_CARET);

  useEffect(() => {
    latest.current = run;
  });

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!matchesBinding(event, binding, HOST_PLATFORM)) return;
      if (!firesFrom(event.target as KeyTarget | null, binding)) return;
      event.preventDefault();
      latest.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [binding, enabled]);

  // The two halves are gated differently, and `keyActionParts` owns why.
  const { announce, draw } = keyActionParts(binding, enabled, caretInField);
  return {
    props: announce ? { "aria-keyshortcuts": ariaKeyShortcuts(binding, HOST_PLATFORM) } : {},
    hint: draw ? <Kbd action={action} /> : null,
  };
}

/**
 * Several actions worn by ONE control -- the season selector, which ← and → both drive.
 *
 * `aria-keyshortcuts` takes a space-separated list, so two `props` objects cannot simply
 * be spread side by side: the second would silently overwrite the first.
 */
export function mergeKeyProps(...actions: KeyAction[]): KeyAction["props"] {
  const shortcuts = actions.map((a) => a.props["aria-keyshortcuts"]).filter((s) => s !== undefined);
  return shortcuts.length > 0 ? { "aria-keyshortcuts": shortcuts.join(" ") } : {};
}
