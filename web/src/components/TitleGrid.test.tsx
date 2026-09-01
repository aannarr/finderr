/**
 * The front page's loading state, and the one distinction it turns on.
 *
 * `renderToStaticMarkup`, like the other component tests here: every question is "which
 * markup comes out", and `ShelfSkeleton` takes no props, touches no context and needs
 * neither a router nor an `AppProvider`.
 *
 * The geometry assertions are not cosmetic. This placeholder exists to occupy exactly the
 * space the real shelves will, so the content landing does not shift the page -- a
 * skeleton of the wrong size is worse than no skeleton, because the reader watches
 * everything jump. Each class pinned below is one the real `Shelf` also sets, and the two
 * live in one file so they can be compared at a glance.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ShelfSkeleton } from "./TitleGrid";

const html = renderToStaticMarkup(<ShelfSkeleton />);

describe("ShelfSkeleton", () => {
  test("draws several shelves, each with a row of cards", () => {
    // Enough to reach the fold and run off the right edge, which is the whole job: a
    // single shelf of two cards reads as a page that finished loading badly.
    expect(html.split("<section").length - 1).toBe(3);
    expect(html.split("<li").length - 1).toBe(18);
  });

  test("matches the real Shelf's geometry", () => {
    // Every one of these is copied from `Shelf` and `TitleCard`. If one changes there and
    // not here, the placeholder is the wrong size and the page shifts when data lands --
    // which is exactly the failure this component was added to prevent.
    expect(html).toContain("mb-8"); // section spacing
    expect(html).toContain("shelf-row"); // the horizontal row, hidden scrollbar and all
    expect(html).toContain("-mx-4"); // bleeds to the viewport edge like the real row
    expect(html).toContain("gap-3");
    expect(html).toContain("w-36 shrink-0 sm:w-40 lg:w-44"); // one card's width, all three breakpoints
    expect(html).toContain("aspect-2/3"); // the poster block
  });

  test("announces itself as a loading region", () => {
    // A screen reader is told something is coming rather than being handed a pile of
    // unlabelled empty boxes. `<output>` carries an implicit `status` role, so this needs
    // no explicit `role` attribute.
    expect(html).toContain("<output");
    expect(html).toContain('aria-label="Loading"');
  });

  test("every block is hidden from the accessibility tree", () => {
    // The bars themselves are decoration. `Skeleton` sets `aria-hidden` on each, so the
    // labelled region above is all that is announced -- not eighteen anonymous divs.
    expect(html.split('aria-hidden="true"').length - 1).toBeGreaterThan(18);
  });
});
