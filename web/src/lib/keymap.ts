/**
 * Every keyboard action this product has, and the key that fires it.
 *
 * ONE OWNER, and that is the whole point. The handler and the `<kbd>` glyph drawn on the
 * button both read the same binding out of `KEYMAP`, so a control cannot advertise a key
 * it no longer answers to. A `⏎` typed into a button label is a second copy of the keymap
 * and it drifts the first time a binding moves -- the UI then confidently teaches a
 * shortcut that does nothing, which is worse than teaching nothing at all.
 *
 * Everything here is PURE and DOM-free, the same split `facet-panes.ts` uses: this module
 * decides what a key means, `components/Kbd.tsx` decides what it looks like and hangs the
 * listener. That is what makes the rules below testable without a browser.
 */

/**
 * The actions a key can fire. Adding one is an entry here and an entry in `KEYMAP`;
 * the record type makes a forgotten binding a compile error rather than a dead glyph.
 */
export type ActionId =
  | "request"
  | "loadMore"
  | "back"
  | "clearFilters"
  | "focusSearch"
  | "prevSeason"
  | "nextSeason"
  | "jumpMode"
  | "assistant";

/** Which key the machine calls "the command modifier": ⌘ on a Mac, Ctrl everywhere else. */
export type Platform = "mac" | "other";

export interface KeyBinding {
  /** The `KeyboardEvent.key` value that fires it, verbatim. */
  key: string;
  /**
   * `"command"` means ⌘ on a Mac and Ctrl elsewhere -- the platform's own "this is an
   * application command, not a character" modifier. The fold from one to the other is
   * `MOD_GLYPH`/`MOD_ARIA` below and is never re-decided at a call site.
   */
  mod?: "command";
  /** How the key itself draws. Modifiers are added by `glyphsFor`, never spelled here. */
  glyph: string;
}

/**
 * The keymap.
 *
 * `back` and `clearFilters` deliberately share Escape. They are the same gesture -- step
 * back out of where you narrowed to -- and they are never live on the same screen: the
 * title page has a back affordance and no filters, the search and browse views have
 * filters and no back affordance. Two actions rather than one because the control that
 * wears the glyph, and the thing the handler does, differ per screen.
 *
 * `⌘K` and a command palette are NOT here on purpose (deferred). When they land, this
 * table is what they should drive.
 */
export const KEYMAP: Record<ActionId, KeyBinding> = {
  // The one action that spends bandwidth and disk asks for the command modifier. Plain
  // Enter is the most-pressed key in a search-first app, and a stray one landing on a
  // page that happens to show a title must never start a download.
  request: { key: "Enter", mod: "command", glyph: "⏎" },
  loadMore: { key: "Enter", glyph: "⏎" },
  back: { key: "Escape", glyph: "esc" },
  clearFilters: { key: "Escape", glyph: "esc" },
  focusSearch: { key: "/", glyph: "/" },
  // Arrows rather than brackets because a reader recognises them without being told.
  // They are only ever bound on the title page, which has no horizontally scrollable
  // element a keyboard can reach, so nothing native loses them.
  prevSeason: { key: "ArrowLeft", glyph: "←" },
  nextSeason: { key: "ArrowRight", glyph: "→" },
  /*
    Enter navigation mode: label every card on screen, then a single key opens one.

    THE SLASH IS DELIBERATE AND IT IS THE SAME SLASH. `/` already means "go to the
    keyboard's entry point" here (it focuses the search box), so the modified form reading
    "go to the keyboard's OTHER entry point" is one idea with two doors rather than two
    unrelated keys to remember. It is also what vim readers reach for first.

    IT CARRIES `mod`, AND THAT IS WHAT MAKES IT WORK AT ALL. The search box is autofocused
    and holds the caret almost permanently; `firesWhileTyping` lets a command-modified
    chord through a caret and nothing else, so an unmodified entry key could never fire
    where a reader actually is. ⌘/ on a Mac, Ctrl+/ elsewhere -- neither is claimed by
    Chrome, Firefox or Safari.

    Only the ENTRY is a named action. The hint keys are not, and cannot be: they address an
    ordinal position that means something different on every scroll, not a named thing. See
    `lib/jump-keys.ts`.
  */
  jumpMode: { key: "/", mod: "command", glyph: "/" },
  /*
    Open and close the assistant panel.

    IT CARRIES `mod` FOR THE SAME REASON `jumpMode` DOES: the search box is autofocused and
    holds the caret nearly always, so `firesWhileTyping` is the only way a key reaches this
    from where a reader actually is.

    ⌘K IS NOT TAKEN, DELIBERATELY. It is the obvious chord and this table has reserved it
    for a command palette since before the assistant existed -- see the note above. Spending
    it on the first feature that wanted a shortcut would mean the palette either arrives
    without its convention or takes the key back from somebody who has learnt it.

    `.` is what is left that is worth having: unclaimed by Chrome, Firefox and Safari on
    both platforms, present on every keyboard layout without a modifier, and adjacent to
    nothing destructive. ⌘J is the browser's downloads, ⌘I is Safari's mail-this-page.
  */
  assistant: { key: ".", mod: "command", glyph: "." },
};

const MOD_GLYPH: Record<Platform, string> = { mac: "⌘", other: "Ctrl" };

/** ARIA names modifiers after the DOM's own `KeyboardEvent` flags, not after the glyph. */
const MOD_ARIA: Record<Platform, string> = { mac: "Meta", other: "Control" };

/**
 * The pieces a chord draws as, one `<kbd>` each.
 *
 * A list rather than a joined string: `⌘⏎` runs together on a Mac and `Ctrl+Enter` wants
 * a gap, and deciding that with string concatenation means deciding it again in CSS.
 */
export function glyphsFor(binding: KeyBinding, platform: Platform): string[] {
  return binding.mod ? [MOD_GLYPH[platform], binding.glyph] : [binding.glyph];
}

/**
 * The same binding as an `aria-keyshortcuts` value.
 *
 * This is how the shortcut reaches a screen reader. The visible `<kbd>` is hidden from
 * the accessibility tree (see `Kbd`) so that `[Request from Radarr ⌘⏎]` is named
 * "Request from Radarr" rather than "Request from Radarr command return" -- and this
 * attribute is what gives the information back, from the same single source.
 */
export function ariaKeyShortcuts(binding: KeyBinding, platform: Platform): string {
  return binding.mod ? `${MOD_ARIA[platform]}+${binding.key}` : binding.key;
}

/** A `KeyboardEvent`, reduced to what the match rule reads, so a test needs no DOM. */
export interface KeyChord {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

/**
 * Did this keystroke fire this binding?
 *
 * Shift is deliberately not checked: `/` is a shifted key on plenty of layouts, so
 * requiring it unpressed would make the search shortcut unreachable for half of Europe.
 * Alt is checked, because Alt+key is a distinct chord the user meant for something else.
 */
export function matchesBinding(chord: KeyChord, binding: KeyBinding, platform: Platform): boolean {
  if (chord.key !== binding.key) return false;
  if (chord.altKey) return false;
  const commandHeld = platform === "mac" ? chord.metaKey : chord.ctrlKey;
  if (binding.mod === "command") return commandHeld;
  return !chord.metaKey && !chord.ctrlKey;
}

/** The bits of an event target the guards below read. Structural, so a test can fake it. */
export interface KeyTarget {
  tagName?: string;
  isContentEditable?: boolean;
}

const TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/** Is the caret somewhere that turns keystrokes into text? */
export function isTypingTarget(target: KeyTarget | null | undefined): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  return TYPING_TAGS.has(target.tagName?.toUpperCase() ?? "");
}

/** Enter and Space already activate these natively -- nothing global may fire twice on them. */
const ACTIVATION_TAGS = new Set(["BUTTON", "A", "SUMMARY"]);

function isActivationTarget(target: KeyTarget | null | undefined): boolean {
  return ACTIVATION_TAGS.has(target?.tagName?.toUpperCase() ?? "");
}

/**
 * Does this binding survive a caret?
 *
 * THE RULE THE WHOLE FEATURE DEPENDS ON. The search box is autofocused and holds focus
 * almost permanently in this app, so a global listener that ignored the caret would make
 * the product untypeable -- "blade runner" would fire six shortcuts. Only two kinds of
 * binding get through: a command-modified chord, which produces no character anywhere,
 * and Escape, which means the same thing whether or not there is a caret.
 *
 * Asked separately from `firesFrom` because the GLYPH asks it too: a key that cannot fire
 * from where the caret is must not be advertised as if it could. That is the card's "a
 * key shown must be live in the current context", and one predicate is what keeps the
 * drawing and the firing from disagreeing.
 */
export function firesWhileTyping(binding: KeyBinding): boolean {
  return binding.mod !== undefined || binding.key === "Escape";
}

/**
 * May this binding fire, given where the keystroke landed?
 *
 * The second clause is the mirror image of the first: an unmodified Enter must yield to
 * whatever has focus, because the browser is already going to activate that button or
 * link. Without it a reader who tabs to a title and presses Enter would navigate AND page
 * the grid. It deliberately does NOT feed the glyph -- Enter on a focused "Show more"
 * still shows it, because the button answers to Enter either way.
 */
export function firesFrom(target: KeyTarget | null | undefined, binding: KeyBinding): boolean {
  if (isTypingTarget(target)) return firesWhileTyping(binding);
  if (binding.key === "Enter" && binding.mod === undefined) return !isActivationTarget(target);
  return true;
}

/**
 * The two halves a bound action wears, and the rule that they are gated DIFFERENTLY.
 *
 * `announce` is `aria-keyshortcuts`: a standing declaration of the key this control
 * answers to, read by a screen reader when the control is FOCUSED. It follows `enabled`
 * alone. Gating it on the caret is the bug this predicate exists to prevent -- the search
 * box is a text field, so it advertised its own key only while the caret was somewhere
 * else, and focusing it (the one moment the attribute is read) is precisely what removed
 * it. A reader tabbing to the box was never told the key and could never recover it.
 *
 * `draw` is the visible glyph, and it is a claim about RIGHT NOW, so it does follow the
 * caret: a `/` printed beside a box you are already typing into teaches a key that does
 * nothing.
 *
 * Pure and separate from the hook because there is no DOM in these tests -- the rule is
 * worth pinning on its own, and `useKeyAction` supplies the live `caretInField` reading.
 */
export function keyActionParts(
  binding: KeyBinding,
  enabled: boolean,
  caretInField: boolean,
): { announce: boolean; draw: boolean } {
  if (!enabled) return { announce: false, draw: false };
  return { announce: true, draw: !caretInField || firesWhileTyping(binding) };
}

/** The `navigator` fields the platform fold reads. Passed in so the fold stays pure. */
export interface PlatformSource {
  platform?: string;
  userAgent?: string;
}

/**
 * Which modifier this machine calls "command".
 *
 * `navigator.platform` is deprecated but still the most direct answer, and the user agent
 * is the fallback that covers iPadOS, which reports itself as a Mac in one and not the
 * other. Read once into `HOST_PLATFORM`; everything else takes a `Platform` argument, so
 * no other module ever asks the UA anything.
 */
export function detectPlatform(source: PlatformSource | undefined): Platform {
  const haystack = `${source?.platform ?? ""} ${source?.userAgent ?? ""}`;
  return /mac|iphone|ipad|ipod/i.test(haystack) ? "mac" : "other";
}

export const HOST_PLATFORM: Platform = detectPlatform(
  typeof navigator === "undefined" ? undefined : navigator,
);
