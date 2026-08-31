/**
 * What a key looks like on the page.
 *
 * Rendered with `react-dom/server`, the same as the other component tests here: the
 * assertions are about which markup a binding produces, and static markup answers that
 * with no DOM and no test-library dependency. `platform` is passed explicitly so these
 * do not depend on whichever machine runs them; whether the right key FIRES is
 * `keymap.test.ts`, and it needs no rendering at all.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Kbd } from "./Kbd";

describe("a chord", () => {
  test("draws one <kbd> per key, folded to the platform", () => {
    expect(renderToStaticMarkup(<Kbd action="request" platform="mac" />)).toContain("⌘");
    expect(renderToStaticMarkup(<Kbd action="request" platform="mac" />)).toContain("⏎");
    expect(renderToStaticMarkup(<Kbd action="request" platform="other" />)).toContain("Ctrl");
  });

  test("a single key is a single <kbd>", () => {
    const html = renderToStaticMarkup(<Kbd action="back" platform="mac" />);
    expect(html).toContain("esc");
    expect(html.match(/<kbd/g)).toHaveLength(1);
  });
});

/**
 * The rule from the card: a glyph must not become the button's accessible name.
 * `[Request from Radarr ⏎]` reads as "Request from Radarr", never "... return".
 */
describe("what a screen reader gets", () => {
  test("the glyph is hidden from the accessibility tree", () => {
    expect(renderToStaticMarkup(<Kbd action="request" platform="mac" />)).toContain('aria-hidden="true"');
  });

  test("so a button wearing one keeps the name it had", () => {
    const html = renderToStaticMarkup(
      <button type="button" aria-keyshortcuts="Meta+Enter">
        Request from Radarr
        <Kbd action="request" platform="mac" />
      </button>,
    );
    // The visible text is unchanged, and the only thing announced beside it is the
    // attribute -- not the ⌘⏎ inside the aria-hidden span.
    expect(html).toContain("Request from Radarr");
    expect(html).toContain('aria-keyshortcuts="Meta+Enter"');
    expect(html.indexOf('aria-hidden="true"')).toBeGreaterThan(html.indexOf("Request from Radarr"));
  });
});
