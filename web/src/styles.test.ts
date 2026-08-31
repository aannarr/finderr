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

/** The body of the first at-rule whose prelude matches, with balanced braces. */
function atRuleBody(css: string, prelude: RegExp): string | null {
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

describe("iOS input focus-zoom guard", () => {
  const body = atRuleBody(CSS, /@media\s*\(pointer:\s*coarse\)/);

  test("a touch-pointer media block exists", () => {
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
    expect(body).toContain("select");
    expect(body).toContain("textarea");
  });

  test("it exempts checkboxes and radios", () => {
    // They carry no text to zoom toward, and sizing them by font-size is a surprise.
    expect(body).toContain('input:not([type="checkbox"]):not([type="radio"])');
  });

  test("it is unlayered, so a Tailwind utility cannot override it", () => {
    // Tailwind v4 emits utilities into `@layer utilities`, and ANY unlayered rule beats
    // EVERY layered one regardless of specificity. Moving this block inside a `@layer`
    // would let a `text-sm` on a control silently restore the zoom -- which is exactly
    // the bug, back, with the fix still visible in the file.
    const index = CSS.search(/@media\s*\(pointer:\s*coarse\)/);
    const before = CSS.slice(0, index);
    const opened = (before.match(/@layer[^;{]*\{/g) ?? []).length;
    const closedTop = before.split("").reduce((depth, ch) => {
      if (ch === "{") return depth + 1;
      if (ch === "}") return depth - 1;
      return depth;
    }, 0);
    expect(opened === 0 || closedTop === 0).toBe(true);
  });
});
