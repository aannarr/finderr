/**
 * Render a component that contains a `<Link>` to static markup.
 *
 * A `<Link>` with no router in context THROWS, so every component test that touches one has
 * to stand a router up first. Four files had their own copy of the same twelve lines,
 * differing only in which paths the throwaway tree declared -- so the paths are the
 * parameter and the ceremony has one owner. `await router.load()` before rendering is the
 * part every copy had to rediscover: an unloaded router renders NOTHING, so a test that
 * skips it passes on empty output.
 *
 * A MEMORY history and a tree with no components: nothing here navigates, and what is being
 * asserted is the markup a component produces from props. The routes exist only so the
 * links inside it resolve to an `href`.
 *
 * Test-only, and in `web/src/test/` rather than `web/src/lib/` to say so -- nothing the app
 * ships imports it.
 *
 * THIS IS THE DEFAULT IDIOM, and it is the right one for what a component DRAWS. When the
 * assertion is about what it DOES -- a click, a keystroke, a state transition, an async
 * settle -- the answer is `./interact.ts`, whose docstring owns the rule that picks between
 * the two.
 */

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/** `paths` are the route patterns the node links to, e.g. `["/title/$tconst"]`. */
export async function renderInRouter(node: ReactNode, paths: readonly string[]): Promise<string> {
  const rootRoute = createRootRoute({ component: () => node });
  const router = createRouter({
    routeTree: rootRoute.addChildren(
      paths.map((path) => createRoute({ getParentRoute: () => rootRoute, path })),
    ),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  // biome-ignore lint/suspicious/noExplicitAny: this tree is not the app's registered router
  return renderToStaticMarkup(<RouterProvider router={router as any} />);
}
