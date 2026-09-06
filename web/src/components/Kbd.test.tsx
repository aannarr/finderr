/**
 * What a key looks like on the page, and whether pressing it does anything.
 *
 * Both idioms, in one file, because they are two halves of one claim -- see
 * `web/src/test/interact.ts` for the rule that picks between them.
 *
 * `Kbd` DRAWS, so it is `react-dom/server`: the assertions are about which markup a binding
 * produces, and `platform` is passed explicitly so they do not depend on whichever machine
 * runs them. The rules behind the drawing are pure and live in `keymap.test.ts`.
 *
 * `useKeyAction` DOES: it hangs a `window` listener in an effect, and an effect that never
 * runs is exactly what static markup cannot see. This repo shipped `⌘/` bound to nothing,
 * twice in one day, with every test green. Those tests are at the bottom and they drive a
 * real DOM.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HOST_PLATFORM } from "../lib/keymap";
import { act, fireEvent, render, screen } from "../test/interact";
import { Kbd, useKeyAction } from "./Kbd";

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

/**
 * The chord that reaches this machine's "command" modifier.
 *
 * Derived from `HOST_PLATFORM` rather than pinned to ⌘ or Ctrl, because the fold from one to
 * the other has an owner (`matchesBinding`) and is asserted both ways in `keymap.test.ts`. A
 * second copy of it here would be the one that drifts. What these tests are about is whether
 * a listener exists at all and what it yields to.
 */
const COMMAND = HOST_PLATFORM === "mac" ? { metaKey: true } : { ctrlKey: true };

/**
 * A search box and a control wearing a shortcut -- the arrangement every screen in this app
 * actually has, and the one the caret rules exist for.
 */
function Probe({
  action,
  run,
  enabled = true,
}: {
  action: Parameters<typeof useKeyAction>[0];
  run: () => void;
  enabled?: boolean;
}) {
  const key = useKeyAction(action, run, enabled);
  return (
    <div>
      <input aria-label="Search" />
      <button type="button" {...key.props} onClick={run}>
        Show more
        {key.hint}
      </button>
    </div>
  );
}

const glyphOnControl = () => screen.getByRole("button", { name: "Show more" }).querySelector("kbd");

describe("a bound key", () => {
  test("fires from anywhere on the page, without tabbing to the control first", () => {
    let fired = 0;
    render(
      <Probe
        action="loadMore"
        run={() => {
          fired += 1;
        }}
      />,
    );

    fireEvent.keyDown(window, { key: "Enter" });

    expect(fired).toBe(1);
  });

  test("a disabled action binds nothing and advertises nothing", () => {
    let fired = 0;
    render(
      <Probe
        action="loadMore"
        enabled={false}
        run={() => {
          fired += 1;
        }}
      />,
    );

    fireEvent.keyDown(window, { key: "Enter" });

    expect(fired).toBe(0);
    expect(glyphOnControl()).toBeNull();
    expect(screen.getByRole("button", { name: "Show more" }).hasAttribute("aria-keyshortcuts")).toBe(false);
  });

  test("unmounting takes the listener off the window", () => {
    let fired = 0;
    const { unmount } = render(
      <Probe
        action="loadMore"
        run={() => {
          fired += 1;
        }}
      />,
    );
    unmount();

    fireEvent.keyDown(window, { key: "Enter" });

    expect(fired).toBe(0);
  });
});

/**
 * The rule the whole feature depends on: the search box is autofocused and holds the caret
 * most of the time, so an unmodified key must become a character there while a
 * command-modified chord must still reach its action. `keymap.test.ts` proves the predicate;
 * these prove the listener and the glyph both obey it.
 */
describe("while the caret is in the search box", () => {
  const focusSearch = () => act(() => screen.getByRole("textbox", { name: "Search" }).focus());

  test("an unmodified key types instead of firing, and stops advertising itself", () => {
    let fired = 0;
    render(
      <Probe
        action="loadMore"
        run={() => {
          fired += 1;
        }}
      />,
    );
    expect(glyphOnControl()).not.toBeNull();

    focusSearch();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search" }), { key: "Enter" });

    expect(fired).toBe(0);
    // A glyph is a claim about right now, and right now that key does nothing.
    expect(glyphOnControl()).toBeNull();
  });

  test("a command-modified chord still fires -- it is the only way ⌘/ ever reaches a reader", () => {
    let fired = 0;
    render(
      <Probe
        action="jumpMode"
        run={() => {
          fired += 1;
        }}
      />,
    );

    focusSearch();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search" }), { key: "/", ...COMMAND });

    expect(fired).toBe(1);
    expect(glyphOnControl()).not.toBeNull();
  });

  /**
   * `aria-keyshortcuts` is read on FOCUS, so gating it on the caret is what once stripped the
   * search box of its own `/` at the single moment a screen reader would have said it.
   */
  test("the control still announces its shortcut, even though the glyph is gone", () => {
    render(<Probe action="loadMore" run={() => {}} />);
    focusSearch();

    expect(glyphOnControl()).toBeNull();
    expect(screen.getByRole("button", { name: "Show more" }).getAttribute("aria-keyshortcuts")).toBe("Enter");
  });
});
