import { describe, expect, test } from "bun:test";
import { FIELD_FONT_VAR, ZOOM_THRESHOLD_PX } from "./lib/field-zoom";

/**
 * The iOS focus-zoom guard is a CSS rule with no JavaScript behind it, so nothing else
 * in this suite can notice when it goes. It is the kind of rule a later "tidy the
 * stylesheet" pass deletes without malice: it looks redundant, because every control it
 * protects already reads fine on a desktop.
 *
 * These tests read `styles.css` and pin the three properties that make it work. They
 * are deliberately about the CASCADE rather than about a string -- a rule that still
 * exists but has been moved into `@layer base`, or narrowed to `input` alone, has
 * stopped doing its job while still matching a naive grep.
 */

const CSS = await Bun.file(new URL("./styles.css", import.meta.url)).text();
/** The two sources that consume `--safe-top`. See "every fixed overlay" at the bottom. */
const ROOT_LAYOUT = await Bun.file(new URL("./routes/RootLayout.tsx", import.meta.url)).text();
const TOASTS = await Bun.file(new URL("./lib/toasts.tsx", import.meta.url)).text();
const ASSISTANT_PANEL = await Bun.file(new URL("./components/AssistantPanel.tsx", import.meta.url)).text();

/** The declaration block following the first occurrence of `prelude`, braces balanced. */
function ruleBody(css: string, prelude: RegExp): string | null {
  const open = css.search(prelude);
  if (open === -1) return null;
  const start = css.indexOf("{", open);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(start + 1, i);
  }
  return null;
}

/** Everything from the start of the file to the first match, for cascade questions. */
function before(css: string, prelude: RegExp): string {
  const i = css.search(prelude);
  return i === -1 ? css : css.slice(0, i);
}

/**
 * The floor is found by its SELECTOR, never by the at-rule it happens to sit in.
 *
 * It used to be located by `@media (pointer: coarse)`, which coupled these tests to where
 * the rule lived rather than to what it does -- and when the scoping was removed (see the
 * rule's own note: coarse-pointer cannot be verified from a headless probe, so it is the
 * wrong condition to guard the worst mobile defect with) every test here failed while the
 * protection was intact and stronger. Keying on the selector survives that move and the
 * next one.
 */
const FLOOR = /input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\)/;

describe("iOS input focus-zoom guard", () => {
  const body = ruleBody(CSS, FLOOR);

  test("the floor rule exists", () => {
    expect(body).not.toBeNull();
  });

  test("it floors text-entry controls at the shared custom property", () => {
    // The value is `--field-font-size` rather than a flat 16px because Safari's threshold
    // is a RENDERED size: 16px on a page at scale 0.84 renders at 13.4 and zooms anyway.
    // `field-zoom.ts` publishes the property; this is the consumer.
    expect(body).toContain(`font-size: var(${FIELD_FONT_VAR}`);
  });

  test("the property falls back to the threshold in `var()` AND on `:root`", () => {
    // Two independent ways the property can be missing -- a browser where the module never
    // ran, and a `var()` that resolves to nothing -- and both have to land on 16px rather
    // than on an inherited size, which would be the bug with the fix still in the file.
    expect(body).toContain(`var(${FIELD_FONT_VAR}, ${ZOOM_THRESHOLD_PX}px)`);
    expect(ruleBody(CSS, /^:root \{/m)).toContain(`${FIELD_FONT_VAR}: ${ZOOM_THRESHOLD_PX}px`);
  });

  test("the focus enlargement is a RATIO of the floor, never a second flat pixel value", () => {
    // A flat 19px renders at 15.96 on a page at 0.84 -- under the threshold by a fortieth
    // of a pixel, which is the zoom back on the exact control this exists for.
    const focus = ruleBody(CSS, /input\[type="search"\]:focus\s*\{/);
    expect(focus).toContain(`calc(var(${FIELD_FONT_VAR}`);
  });

  test("it covers select and textarea, not just input", () => {
    // A select opening the iOS picker and a textarea both zoom exactly like an input.
    // Guarding only `input` is the most likely way this rule gets half-deleted.
    const selectors = CSS.slice(CSS.search(FLOOR), CSS.indexOf("{", CSS.search(FLOOR)));
    expect(selectors).toContain("select");
    expect(selectors).toContain("textarea");
  });

  test("it is unlayered, so a Tailwind utility cannot override it", () => {
    // Tailwind v4 emits utilities into `@layer utilities`, and ANY unlayered rule beats
    // EVERY layered one regardless of specificity. Moving this block inside a `@layer`
    // would let a `text-sm` on a control silently restore the zoom -- which is exactly
    // the bug, back, with the fix still visible in the file.
    const head = before(CSS, FLOOR);
    const opened = (head.match(/@layer[^;{]*\{/g) ?? []).length;
    const closedTop = head.split("").reduce((depth, ch) => {
      if (ch === "{") return depth + 1;
      if (ch === "}") return depth - 1;
      return depth;
    }, 0);
    expect(opened === 0 || closedTop === 0).toBe(true);
  });
});

/**
 * The search box is 16px and zoomed ANYWAY, which is why the floor above is necessary and
 * not sufficient.
 *
 * Measured in a browser: the field computes `font-size: 16px` and `appearance: auto`.
 * `type="search"` gets a native control appearance from Safari, and Safari sizes native
 * controls with its own control-font metrics rather than the author's -- so the zoom
 * heuristic fires on a field that is 16px by every measurement the page can make. Removing
 * the native appearance is the fix, and it is invisible on every other platform, which is
 * exactly the kind of rule a later tidying pass deletes as dead weight.
 */
describe("search fields have no native appearance", () => {
  const body = ruleBody(CSS, /input\[type="search"\]\s*\{/);

  test("appearance is reset, with the -webkit- prefix Safari still needs", () => {
    expect(body).not.toBeNull();
    expect(body).toContain("appearance: none");
    // Safari honours the unprefixed property for many controls but NOT for the search
    // field's own decorations, so dropping the prefixed line silently restores the bug.
    expect(body).toContain("-webkit-appearance: none");
  });
});

/**
 * The viewport meta, in BOTH entries, character for character.
 *
 * Every term in it is load-carrying and none of them fails loudly: drop `viewport-fit=cover`
 * and the safe-area rules below go inert, drop `minimum-scale` and the page can sit at 0.84
 * where a 16px field renders at 13.4 and zooms on every focus, and let the two files drift
 * and the defect comes back on the sign-in screen alone -- the one an invited stranger meets
 * first and nobody here ever opens on a phone.
 *
 * Pinned as one string rather than term by term precisely because the failure is a term
 * QUIETLY GOING MISSING, and a per-term assertion is a list somebody has to remember to add
 * to.
 */
describe("the viewport meta", () => {
  const EXPECTED =
    "width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, viewport-fit=cover, interactive-widget=resizes-content";

  const content = (html: string) => html.match(/<meta\s+name="viewport"\s+content="([^"]*)"/s)?.[1] ?? null;

  test("the app shell carries every term", async () => {
    const html = await Bun.file(new URL("../index.html", import.meta.url)).text();
    expect(content(html)).toBe(EXPECTED);
  });

  test("and the sign-in bundle carries the identical one", async () => {
    const html = await Bun.file(new URL("../login.html", import.meta.url)).text();
    expect(content(html)).toBe(EXPECTED);
  });
});

/**
 * `viewport-fit=cover` and `env(safe-area-inset-*)` ARE TWO HALVES OF ONE DECISION.
 *
 * The viewport meta in both HTML entries opts this app into drawing under the status bar,
 * the notch and the home indicator. That is what a full-bleed background wants and it is
 * only correct while something puts the CONTENT back inside the visible rectangle. Delete
 * the insets and nothing fails, nothing warns, and the header renders under the clock on
 * every installed iPhone -- a defect invisible to every desktop browser and to this suite
 * unless it is pinned here.
 *
 * These tests are about the STYLESHEET's half. The three consumers of `--safe-top` are
 * ordinary Tailwind classes in TSX and are checked below, in the same spirit.
 */
describe("display-cutout insets", () => {
  test("the top inset is named once, with a 0px fallback", () => {
    const root = ruleBody(CSS, /^:root \{/m);
    expect(root).not.toBeNull();
    // The fallback is what makes every consumer inert on a screen with no cutout. Without
    // it `var(--safe-top)` is still defined -- `env()` with no fallback resolves to an
    // empty value in unsupported browsers, which makes the whole `calc()` invalid and
    // silently drops the padding it was added to.
    expect(root).toContain("--safe-top: env(safe-area-inset-top, 0px)");
  });

  test("normal-flow content is inset on the other three edges by one rule on body", () => {
    const body = ruleBody(CSS, /^body \{/m);
    expect(body).not.toBeNull();
    // On `body` rather than on a shell class, because BOTH bundles import this stylesheet
    // and the sign-in screen has no shell of its own. Landscape on a notched phone is
    // where the horizontal pair earns itself.
    expect(body).toContain("padding-left: env(safe-area-inset-left, 0px)");
    expect(body).toContain("padding-right: env(safe-area-inset-right, 0px)");
    expect(body).toContain("padding-bottom: env(safe-area-inset-bottom, 0px)");
  });
});

/**
 * The consumers of `--safe-top`, checked in the markup that carries them.
 *
 * Everything positioned `fixed` sits against the VIEWPORT, so the padding on `body` never
 * reaches it -- each such element has to carry the top inset itself, and a new one added
 * next month is the way this regresses. Reading the sources here rather than rendering
 * them is the same trade `styles.test.ts` already takes for the zoom guard: the assertion
 * is about a value in a class list, and a DOM would not make it truer.
 */
describe("every fixed overlay carries the top inset", () => {
  test("the sticky header pads down by it instead of leaving the wordmark under the clock", () => {
    expect(ROOT_LAYOUT).toContain("pt-[calc(1.25rem+var(--safe-top))]");
  });

  test("the toast stack does too -- it is the one overlay that is pure text", () => {
    expect(TOASTS).toContain("top-[calc(0.75rem+var(--safe-top))]");
  });

  /**
   * The assistant drawer is `inset-y-0`, so it starts at the PHYSICAL top of the screen --
   * further up than the sticky header ever goes. Without the inset its own title row sits
   * under the clock on an installed iPhone, which is the exact defect the other two carry
   * their padding for.
   *
   * It is bare `var(--safe-top)` rather than a `calc()` because the row under it brings its
   * own padding; there is no design spacing to add the inset to.
   */
  test("the assistant drawer does too -- it is `fixed` and starts above the header", () => {
    expect(ASSISTANT_PANEL).toContain("pt-[var(--safe-top)]");
  });

  /**
   * And the BOTTOM, which only this overlay needs.
   *
   * `body` carries `padding-bottom: env(safe-area-inset-bottom)` for everything in normal
   * flow, and a `fixed` element is not in it -- so the composer, which is pinned to the
   * bottom edge, would sit under the home indicator with its send button half-unreachable.
   */
  test("and its composer clears the home indicator", () => {
    expect(ASSISTANT_PANEL).toContain("env(safe-area-inset-bottom,0px)");
  });
});
