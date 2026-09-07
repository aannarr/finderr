/**
 * What the bridge DRAWS, given a query.
 *
 * Which queries produce an intent at all is `src/lib/browse-intent.test.ts`; this is the half
 * that has to stay true in markup -- that the link goes to the ranked browse, that its label
 * is the same sentence the destination heading will print, and that an ordinary title search
 * draws nothing at all.
 */

import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderInRouter as render } from "../test/render-in-router";
import { BrowseSuggestion } from "./BrowseSuggestion";

const renderInRouter = (node: ReactNode) => render(node, ["/browse"]);

describe("BrowseSuggestion", () => {
  test("a described shelf links to the ranked browse for it", async () => {
    const html = await renderInRouter(<BrowseSuggestion query="swedish crime drama" />);
    expect(html).toContain("best Crime titles in Swedish");
    expect(html).toContain("genre=Crime");
    expect(html).toContain("lang=sv");
    // "best" on the label has to be "best" in the destination, or the link disagrees with
    // its own text: without `sort=rank` the grid comes back ordered by votes.
    expect(html).toContain("sort=rank");
  });

  test("the label says what happened to a word we reinterpreted", async () => {
    // "new" becomes a decade, because `/browse` has no recency ordering. A reader has to be
    // able to SEE that before following the link.
    const html = await renderInRouter(<BrowseSuggestion query="new korean thrillers" />);
    expect(html).toContain("from the ");
    expect(html).toContain("decade=");
  });

  test("an ordinary title search draws nothing", async () => {
    expect(await renderInRouter(<BrowseSuggestion query="true romance" />)).toBe("");
    expect(await renderInRouter(<BrowseSuggestion query="the matrix" />)).toBe("");
  });
});
