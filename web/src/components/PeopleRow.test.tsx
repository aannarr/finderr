/**
 * The people half of a search answer, as markup.
 *
 * Through a memory router, like `TermChip.test.tsx`: every tile is a `<Link>`, which reads
 * the router out of context and throws without one, and `await router.load()` is not
 * optional -- an unloaded router renders nothing, so a test that skipped it would pass on
 * empty output.
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
import type { PersonHit } from "../lib/api";
import { PeopleRow } from "./PeopleRow";

const person = (over: Partial<PersonHit> = {}): PersonHit => ({
  nconst: "nm0634240",
  name: "Christopher Nolan",
  birthYear: 1970,
  deathYear: null,
  credits: 24,
  ...over,
});

/** Just enough router for a `<Link to="/person/$nconst">` to resolve an href. */
async function renderInRouter(node: ReactNode): Promise<string> {
  const rootRoute = createRootRoute({ component: () => node });
  const personRoute = createRoute({ getParentRoute: () => rootRoute, path: "/person/$nconst" });
  const router = createRouter({
    routeTree: rootRoute.addChildren([personRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  // biome-ignore lint/suspicious/noExplicitAny: this tree is not the app's registered router
  return renderToStaticMarkup(<RouterProvider router={router as any} />);
}

describe("PeopleRow", () => {
  test("a person is a name, a credit count and a link to their filmography", async () => {
    const html = await renderInRouter(<PeopleRow people={[person()]} />);
    expect(html).toContain("Christopher Nolan");
    expect(html).toContain("24 titles");
    expect(html).toContain('href="/person/nm0634240"');
  });

  test("one title is not '1 titles'", async () => {
    const html = await renderInRouter(<PeopleRow people={[person({ credits: 1 })]} />);
    expect(html).toContain("1 title<");
  });

  /**
   * A pane is not an obligation to fill. `SearchResponse.people` is absent rather than
   * empty on an index that cannot search people, and the route passes `[]` for both -- so
   * the heading has to be conditional or a missing capability draws an empty "People".
   */
  test("nobody to draw means no heading and no row", async () => {
    expect(await renderInRouter(<PeopleRow people={[]} />)).not.toContain("People");
  });

  /**
   * The one rule no person tile may ever break. We hold no headshot keyed by `nconst`, so
   * this draws initials today -- but the guard is what stops a provider's CDN URL reaching
   * a browser the day a source arrives, and initials are the honest fallback either way.
   */
  test("no upstream image URL, initials instead", async () => {
    const html = await renderInRouter(<PeopleRow people={[person()]} />);
    expect(html).not.toContain("image.tmdb.org");
    expect(html).not.toContain("<img");
    expect(html).toContain("CN");
  });

  test("order is the server's, never re-sorted here", async () => {
    // The rank is a fact about the index -- votes on the best-known title, then credits --
    // and a client that re-sorted on `credits` would put the wrong Nolan first.
    const html = await renderInRouter(
      <PeopleRow people={[person(), person({ nconst: "nm0634300", name: "Jonathan Nolan", credits: 99 })]} />,
    );
    expect(html.indexOf("Christopher Nolan")).toBeLessThan(html.indexOf("Jonathan Nolan"));
  });
});
