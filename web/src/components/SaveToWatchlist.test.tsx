/**
 * The save toggle, in both tones and both states.
 *
 * What is worth pinning is that the TONE changes the size and nothing else -- the moment one
 * of them stops announcing its state or stops naming the film, the two surfaces are telling a
 * reader different things about the same title, which is what sharing the component was for.
 *
 * `aria-pressed` is the other one, and it is the reason this is a toggle rather than two
 * buttons that swap places: without it a screen reader is handed a control whose name changes
 * under it with no indication that the change WAS the outcome.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Title } from "../lib/api";
import { ToastProvider } from "../lib/toasts";
import { type SaveTone, SaveToWatchlist } from "./SaveToWatchlist";

const TITLE = { tconst: "tt0083658", title: "Blade Runner" } as Title;

const TONES: SaveTone[] = ["icon", "block"];

/** The provider is what the failure path pushes into; the toggle refuses to render without it. */
function html(tone: SaveTone): string {
  return renderToStaticMarkup(
    <ToastProvider>
      <SaveToWatchlist title={TITLE} tone={tone} />
    </ToastProvider>,
  );
}

describe("the save toggle", () => {
  test("every tone declares itself a toggle, and starts unpressed", () => {
    for (const tone of TONES) {
      // `false` is the server snapshot in `useIsSaved`: a render that ran no fetch has not
      // seen anybody's list, and "not saved" is the only honest answer to draw.
      expect(html(tone)).toContain('aria-pressed="false"');
    }
  });

  test("every tone names the action, and the icon names the film too", () => {
    // The glyph is all there is in `icon`, so the accessible name carries both.
    expect(html("icon")).toContain('aria-label="Add to watchlist: Blade Runner"');
    // The label is visible in `block`, so a duplicate accessible name would be read twice.
    expect(html("block")).toContain("Add to watchlist");
    expect(html("block")).not.toContain("aria-label");
  });

  test("it is a button and never a link -- saving goes nowhere", () => {
    for (const tone of TONES) {
      expect(html(tone)).toContain('type="button"');
      expect(html(tone)).not.toContain("<a ");
    }
  });
});
