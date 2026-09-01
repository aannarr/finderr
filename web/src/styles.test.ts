import { describe, expect, test } from "bun:test";

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

  test("it floors text-entry controls at 16px", () => {
    const size = body?.match(/font-size:\s*(\d+(?:\.\d+)?)px/);
    expect(size).not.toBeNull();
    // 16 is the browser's threshold, not a taste. Below it Safari zooms; at or above
    // it does not.
    expect(Number(size?.[1])).toBeGreaterThanOrEqual(16);
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
