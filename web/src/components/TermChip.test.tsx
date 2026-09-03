/**
 * The dead-end rule, where it is actually spent.
 *
 * `renderToStaticMarkup` like the other component tests here, but through a memory router:
 * the linkable branch renders a `<Link>`, which reads the router out of context and throws
 * without one. `await router.load()` before rendering is not optional either -- an unloaded
 * router renders nothing at all, so a test that skipped it would pass on empty output.
 */

import { describe, expect, test } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Term } from "../lib/api";
import { findTerm, TermChip } from "./TermChip";

const term = (over: Partial<Term> = {}): Term => ({
  dimension: "keyword",
  key: "heist",
  label: "Heist",
  titles: 4,
  ...over,
});

/** Just enough router for a `<Link to="/term/$dimension/$value">` to resolve an href. */
async function renderInRouter(node: ReactNode): Promise<string> {
  const rootRoute = createRootRoute({ component: () => node });
  const termRoute = createRoute({ getParentRoute: () => rootRoute, path: "/term/$dimension/$value" });
  const router = createRouter({
    routeTree: rootRoute.addChildren([termRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  // biome-ignore lint/suspicious/noExplicitAny: this tree is not the app's registered router
  return renderToStaticMarkup(<RouterProvider router={router as any} />);
}

describe("findTerm", () => {
  const terms = [term(), term({ dimension: "studio", key: "a24", label: "A24" })];

  /**
   * Matched on the FOLDED key, never the label: the label is the corpus's commonest
   * spelling and the value in hand is whichever spelling this title's provider used.
   */
  test("finds by dimension and key", () => {
    expect(findTerm(terms, "keyword", "heist")?.label).toBe("Heist");
    expect(findTerm(terms, "studio", "a24")?.label).toBe("A24");
  });

  test("a key in another dimension is not a match", () => {
    expect(findTerm(terms, "studio", "heist")).toBeUndefined();
    expect(findTerm(terms, "keyword", "submarine")).toBeUndefined();
    expect(findTerm(undefined, "keyword", "heist")).toBeUndefined();
  });
});

describe("TermChip", () => {
  /**
   * A term cached for one title is a page containing the title you are already looking at.
   * Navigable, honest and useless -- so it is a word, not a link.
   */
  test("a term with one title is plain text", async () => {
    const html = await renderInRouter(<TermChip term={term({ titles: 1 })} label="Heist" />);
    expect(html).toContain("Heist");
    expect(html).not.toContain("<a ");
  });

  /** Before the count arrives -- and for a title nothing else shares -- text is the answer. */
  test("no term at all is plain text", async () => {
    const html = await renderInRouter(<TermChip term={undefined} label="Heist" />);
    expect(html).toContain("Heist");
    expect(html).not.toContain("<a ");
  });

  test("a term with somewhere to go is a link, and says how many titles are behind it", async () => {
    const html = await renderInRouter(<TermChip term={term()} label="Heist" />);
    expect(html).toContain('href="/term/keyword/heist"');
    expect(html).toContain("4 titles we hold");
  });

  /** The LABEL is what this title's provider called it; the KEY is where it goes. */
  test("the chip shows the spelling in hand and links on the folded key", async () => {
    const html = await renderInRouter(<TermChip term={term()} label="HEIST" />);
    expect(html).toContain(">HEIST</a>");
    expect(html).toContain('href="/term/keyword/heist"');
  });
});
