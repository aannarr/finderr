/**
 * The route tree, defined in CODE.
 *
 * Deliberately not the file-based convention and not the route-tree Vite plugin.
 * The views here are not a directory shape: `/`, `/title/$tconst`, `/browse`,
 * `/person/$nconst` and `/collection/$id` are variations on ONE filtered-grid component
 * with different loaders. Expressing that as constructed route objects sharing a
 * component matches the design; expressing it as sibling files fights it.
 *
 * The router owns the URL. It does NOT own the data -- see SearchRoute for why the
 * search path stays on its synchronous client cache instead of a loader.
 */

import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import {
  markWipeShown,
  noteOrdinaryNavigation,
  pickWipeVariant,
  prefersReducedMotion,
  shouldWipe,
  tconstOfPath,
  WIPE_CLASS,
  WIPE_VARIANTS,
} from "./lib/easter-eggs";
import { validateSearch } from "./lib/search-params";
import { AccountRoute } from "./routes/AccountRoute";
import { AdminRoute } from "./routes/AdminRoute";
import { AwardsRoute } from "./routes/AwardsRoute";
import { BrowseRoute } from "./routes/BrowseRoute";
import { CeremonyRoute } from "./routes/CeremonyRoute";
import { CollectionRoute } from "./routes/CollectionRoute";
import { ListsRoute } from "./routes/ListsRoute";
import { PersonRoute } from "./routes/PersonRoute";
import { RequestsRoute } from "./routes/RequestsRoute";
import { RootLayout } from "./routes/RootLayout";
import { SearchRoute } from "./routes/SearchRoute";
import { TitleRoute } from "./routes/TitleRoute";

const rootRoute = createRootRoute({ component: RootLayout });

/**
 * `/` -- search, or the discover shelf when the box is empty.
 *
 * The query and every facet live in the search params, so a refresh keeps your
 * place, Back steps through refinements, and a result set is a shareable link.
 */
const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch,
  component: SearchRoute,
});

/** `/title/tt0111161` -- one title. A real route, so Back returns to the grid. */
const titleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/title/$tconst",
  component: TitleRoute,
});

/**
 * `/browse?genre=Horror&decade=1980` -- the filtered grid.
 *
 * One route with typed search params rather than a family of paths, because the
 * filters COMBINE. `/genre/horror/1980s` would need a new path for every pair;
 * search params express the same thing and stay shareable.
 */
const browseRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/browse",
  validateSearch,
  component: BrowseRoute,
});

/**
 * `/person/nm0000138` -- one person and their filmography.
 *
 * The third view built on the shared filtered grid, which is exactly the shape this
 * route tree was designed around: a header describing a selection, `TitleGrid` under it,
 * and a loader that differs. `role` lives in the search params so a filtered filmography
 * is a shareable link like every other view.
 */
const personRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/person/$nconst",
  validateSearch,
  component: PersonRoute,
});

/**
 * `/collection/tmdb:2344` -- one franchise and the films of it we hold.
 *
 * The id is the FACET's id, namespace and all, rather than a bare TMDB number: the
 * collection facet declares `id: string` precisely so a second provider's id space can
 * arrive, and stripping the prefix here would bake "collections are always TMDB" into
 * the URL contract.
 */
const collectionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/collection/$id",
  component: CollectionRoute,
});

/**
 * `/lists` -- the index of every list finderr can show.
 *
 * A route of its own rather than a query string, because "what lists exist" is a question
 * with a stable answer and a name in the nav. It takes NO search params: every list it
 * points at is a `/browse` URL, so this page has no state to share.
 */
const listsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/lists",
  component: ListsRoute,
});

/**
 * `/requests` -- your own requests, and which of them have arrived.
 *
 * Scoped to the caller by the SERVER (`?mine=1`), not by this route: `requested_by` is
 * stripped from the response for anybody who is not an admin, so a client-side filter would
 * have nothing to filter on. It is also where the header's ready badge goes, which is why
 * the route has to exist at all -- a badge with no destination is the dead end this product
 * refuses to draw.
 */
const requestsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/requests",
  component: RequestsRoute,
});

/**
 * `/account` -- your own devices and sessions.
 *
 * In THIS bundle rather than the sign-in one, because managing a passkey is something a
 * signed-in person does. The pre-auth bundle only ever creates the first one.
 */
const accountRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/account",
  component: AccountRoute,
});

/**
 * `/admin` -- people, invitations and the attributed request log.
 *
 * The route exists for everybody; the DATA does not. Every endpoint behind it answers 404
 * to a non-admin, so this is a convenience rather than the boundary -- putting the check
 * in the router would be a second owner of a rule the server already enforces, and the
 * weaker of the two.
 */
const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  component: AdminRoute,
});

/**
 * `/awards/oscars` -- ninety-eight ceremonies, newest first.
 *
 * The award is IN THE PATH rather than a parameter, deliberately. `/awards/$award` would
 * promise a vocabulary we do not have: the Oscars are the only source anybody has found
 * that carries both `tconst` and `nconst`, and a general shape designed against one
 * example is a shape designed against nothing. A second award becomes a second literal
 * route, and the generalisation happens when there is something to generalise FROM.
 */
const awardsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/awards/oscars",
  component: AwardsRoute,
});

/**
 * `/awards/oscars/96` -- one ceremony.
 *
 * The parameter is the CEREMONY NUMBER, never the year. The first six ceremonies carry
 * `1927/28` as their year, so the year is a label; the number is the only stable key the
 * source has, and routing on it is what keeps `/awards/oscars/1` meaningful.
 */
const ceremonyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/awards/oscars/$ceremony",
  component: CeremonyRoute,
});

const routeTree = rootRoute.addChildren([
  searchRoute,
  browseRoute,
  titleRoute,
  personRoute,
  collectionRoute,
  awardsRoute,
  ceremonyRoute,
  listsRoute,
  requestsRoute,
  accountRoute,
  adminRoute,
]);

export const router = createRouter({
  routeTree,
  // The grid can be long; returning to it should land where you left, and arriving
  // at a new view should start at the top.
  scrollRestoration: true,
  /**
   * NAVIGATION DOES NOT ANIMATE. The one exception is the easter egg.
   *
   * A full transition set was built here first -- a directional page slide keyed on route
   * depth, a header pinned out of the animation so the chrome stayed still, and a poster
   * that morphed from the grid card to the title page. It worked. aannarr cut all of it on
   * 2026-09-01 in favour of an instant swap, and the reason is worth keeping because it is
   * not "it was buggy": **motion everywhere is what would make the one deliberate piece of
   * motion unremarkable.** A 600ms wipe is a surprise in an app that never moves. In an app
   * that already slides and morphs on every click it is just a longer version of the usual
   * thing.
   *
   * `false` here is stronger than a zero-duration animation: `router-core` skips
   * `document.startViewTransition` altogether, so there is no snapshot, no pseudo-element
   * tree, and no frame where the old page is painted over the new one.
   *
   * **So a "subtle transition" added back later would not be a change beside the easter egg
   * -- it would spend it.** `web/src/lib/easter-eggs.ts` is the only thing that may return
   * a type from this function.
   */
  defaultViewTransition: {
    /*
      `types` is used as a per-navigation HOOK, not as the mechanism.

      The return value is deliberately not relied on: `router-core` only reads it inside a
      `CSS.supports("selector(:active-view-transition-type(a))")` branch, so on a browser
      with view transitions but not types -- Safari, at the time of writing -- both the
      `false` and the `["wipe"]` answers are discarded and `startViewTransition(fn)` runs
      bare. What IS reliable is that this function is called exactly once per navigation,
      before the transition starts, which is all the joke needs.

      So the class on `<html>` carries the decision and the stylesheet neutralises the root
      animation whenever it is absent. That makes an ordinary navigation instant on every
      browser, including the ones that ignore the `false` below.
    */
    types: ({ toLocation }) => {
      const root = document.documentElement;
      root.classList.remove(WIPE_CLASS, ...WIPE_VARIANTS);

      /*
        Reduced motion is back and was never the problem.

        It was the last suspect standing in a long hunt and it was innocent: the device
        reported `prefers-reduced-motion: false` the whole time. The real cause was paint
        ORDER -- `::view-transition-new` sits above `::view-transition-old` by default, so
        every mask and clip on the outgoing page was working perfectly underneath a fully
        opaque incoming page. The `z-index` pair in `styles.css` is the fix.

        Honouring the setting is not optional for the largest motion in the product, so it
        gates first, as it always did.
      */
      const reducedMotion = prefersReducedMotion();
      if (reducedMotion) return false;

      if (shouldWipe(tconstOfPath(toLocation.pathname), { reducedMotion })) {
        markWipeShown();
        // Base class carries the shared timing and paint order; the variant carries only
        // its own geometry. Rolled per firing, so the joke stays a small surprise the
        // second and third time rather than becoming a thing you have seen.
        root.classList.add(WIPE_CLASS, pickWipeVariant());
        return [WIPE_CLASS];
      }

      noteOrdinaryNavigation();
      return false;
    },
  },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
