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

import { createRootRoute, createRoute, createRouter, lazyRouteComponent } from "@tanstack/react-router";
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
import { validatePeopleSearch, validateSearch } from "./lib/search-params";
import { AdminAddonsRoute } from "./routes/AdminAddonsRoute";
import { AdminInvitesRoute } from "./routes/AdminInvitesRoute";
import { AdminLayout } from "./routes/AdminLayout";
import { AdminOverviewRoute } from "./routes/AdminOverviewRoute";
import { AdminUserRoute } from "./routes/AdminUserRoute";
import { AdminUsersRoute } from "./routes/AdminUsersRoute";
import { AwardPeopleRoute } from "./routes/AwardPeopleRoute";
import { AwardsRoute } from "./routes/AwardsRoute";
import { BrowseRoute } from "./routes/BrowseRoute";
import { CeremonyRoute } from "./routes/CeremonyRoute";
import { CollectionRoute } from "./routes/CollectionRoute";
import { ListsRoute } from "./routes/ListsRoute";
import { LogRoute } from "./routes/LogRoute";
import { PersonRoute } from "./routes/PersonRoute";
import { RequestsRoute } from "./routes/RequestsRoute";
import { RootLayout } from "./routes/RootLayout";
import { SearchRoute } from "./routes/SearchRoute";
import { TermRoute } from "./routes/TermRoute";
import { TitleRoute } from "./routes/TitleRoute";
import { WatchlistRoute } from "./routes/WatchlistRoute";

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
 * `/term/keyword/heist` -- one keyword, service or studio, and the titles we hold for it.
 *
 * A PATH rather than `/browse?keyword=heist`, and that is forced rather than chosen: the
 * terms live in the app database while the title index is a separate SQLite file, so a
 * keyword could not become a WHERE clause on the grid even if the params carried it. Same
 * split `/collection/$id` already lives on.
 *
 * The dimension is a parameter because there are genuinely three cases sharing one mechanism,
 * so the general shape is designed against three examples rather than one. `/awards/$award`
 * reached the same shape by the same route, one award later.
 *
 * `country` rides in the search params for `service` only: availability differs by country,
 * so it is part of what the page means and therefore part of the URL.
 */
const termRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/term/$dimension/$value",
  validateSearch,
  component: TermRoute,
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
 * `/watchlist` -- the titles you kept, newest first.
 *
 * Beside `/lists` rather than under it, and the difference is who owns the membership: every
 * row on `/lists` is a query anybody would get the same answer to, and this one is a set of
 * rows one reader wrote. It takes no search params -- a private list is not a shareable link,
 * and giving it one would be the only URL in this product that renders differently depending
 * on who opens it.
 */
const watchlistRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/watchlist",
  component: WatchlistRoute,
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
 * `/log` -- everything anybody has asked for, newest first.
 *
 * The house's log, where `/requests` is yours. It takes NO search params and no route param
 * for the person it is filtered to: the filter is a chip, not a URL, because the WHO column
 * only exists for an admin and a shareable `?who=` would be a link that renders differently
 * depending on who opens it -- or worse, one that reads as a leak when it lands nowhere.
 */
const logRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/log",
  component: LogRoute,
});

/**
 * `/account` -- your own devices and sessions.
 *
 * In THIS bundle rather than the sign-in one, because managing a passkey is something a
 * signed-in person does. The pre-auth bundle only ever creates the first one.
 */
/*
  THE SECOND LAZY ROUTE, and it earned the boundary by MEASUREMENT rather than by being big.

  `/account` is the one view that carries a library nothing else needs:
  `@atlaskit/pragmatic-drag-and-drop` + its hitbox, for reordering the shelves. Built on the
  M1 Max, 2026-09-07, `bun run build`, the `main` chunk:

    | | main, raw | main, gzip |
    |---|---|---|
    | before the drag existed | 387.60 kB | 118.96 kB |
    | drag, eagerly imported | 412.00 kB | 126.07 kB |
    | **drag, behind this boundary** | **352.55 kB** | **108.47 kB** |

  Eager, the library cost +24.4 kB raw and +7.1 kB gzipped on the chunk EVERY reader downloads
  before they see a poster, for a control on a settings page most of them open once. Under
  this repo's fourth rule that is not a trade to take, and the shape that costs nothing was
  one line.

  IT CAME OUT AHEAD OF WHERE IT STARTED, which is the part worth knowing: `/account` had
  always been in the main chunk and never needed to be, so moving it out paid for the drag
  library and returned **-35.05 kB raw / -10.49 kB gzipped** against the tree before any of
  this. The 42.63 kB `AccountRoute` chunk is fetched when somebody opens their settings.

  It differs from `/sources` above only in why: that one is a document nobody passes through,
  this one is a route whose WEIGHT is not shared. Both are the same test -- is this on the way
  to a film? -- and neither is licence to split a route that is.
*/
const accountRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/account",
  component: lazyRouteComponent(() => import("./routes/AccountRoute"), "AccountRoute"),
});

/**
 * `/admin` and everything under it -- a LAYOUT route with five children.
 *
 * The route exists for everybody; the DATA does not. Every endpoint behind it answers 404
 * to a non-admin, so this is a convenience rather than the boundary -- putting the check
 * in the router would be a second owner of a rule the server already enforces, and the
 * weaker of the two.
 *
 * Nested rather than siblings, because they SHARE chrome: `AdminLayout` draws the heading and
 * the tabs once and renders whichever child the URL names. Sibling routes would each have had
 * to import that nav, which is how the next one ships without it.
 */
const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  component: AdminLayout,
});

/** `/admin` itself -- the overview. An index route, so the parent's tabs are already drawn. */
const adminOverviewRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/",
  component: AdminOverviewRoute,
});

/** `/admin/users` -- everybody with an account. Rows link; nothing on one is an action. */
const adminUsersRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "users",
  component: AdminUsersRoute,
});

/**
 * `/admin/users/nnn` -- one person: identity, access and activity.
 *
 * The id is a real route param rather than a selection held in the list's state, so the page
 * is linkable, survives a refresh, and Back returns to the list.
 */
const adminUserRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "users/$id",
  component: AdminUserRoute,
});

/** `/admin/invites` -- mint a way in, and see who has not used theirs. */
const adminInvitesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "invites",
  component: AdminInvitesRoute,
});

/** `/admin/addons` -- what is installed, and the settings each one declared it needs. */
const adminAddonsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "addons",
  component: AdminAddonsRoute,
});

/**
 * `/awards/oscars`, `/awards/palme-dor` -- every edition of one award, newest first.
 *
 * The award is a PARAMETER now, and the comment that stood here argued against exactly that:
 * a general shape designed against one example is a shape designed against nothing. That was
 * right when there was one award. There are three, `/awards/oscars` is still one of the
 * values this route takes, and every link that already pointed at it still resolves.
 */
const awardsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/awards/$award",
  component: AwardsRoute,
});

/**
 * `/awards/oscars/people` -- who the nomination table describes, ranked three ways.
 *
 * A STATIC segment declared BEFORE `/awards/$award/$ceremony` and matched ahead of it whatever
 * the declaration order -- TanStack scores a literal segment above a param. `people` is not a
 * number, so the edition route would 404 on it either way; the ordering matters because the
 * next static sibling might not be so lucky, and `router.test.tsx` asserts the resolution
 * rather than trusting this paragraph.
 */
const awardPeopleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/awards/$award/people",
  validateSearch: validatePeopleSearch,
  component: AwardPeopleRoute,
});

/**
 * `/awards/oscars/96`, `/awards/palme-dor/1994` -- one edition.
 *
 * The parameter is the EDITION KEY and never a display label. The Academy numbers its
 * ceremonies -- the first six carry `1927/28` as their YEAR, so the year is a label and the
 * number is the only stable key that source has. Wikidata has no ordinal at all and dates
 * each award, so there the year IS the key. Both are integers, which is why one route serves
 * both; which one a given award uses is `AwardEdition.key` in the registry.
 */
const ceremonyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/awards/$award/$ceremony",
  component: CeremonyRoute,
});

/**
 * `/sources` -- who every fact on screen belongs to.
 *
 * THE ONE LAZY ROUTE, and the only one that should be. Every other view here is somewhere a
 * reader goes on the way to a film, so a chunk boundary in front of it buys a spinner and
 * saves nothing. This one is a credits page carrying its whole document inline (`?raw`), read
 * once by anybody and never on the path to anything -- exactly the shape a separate chunk is
 * for. It takes no params: there is no state to share, only a document.
 */
const sourcesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sources",
  component: lazyRouteComponent(() => import("./routes/SourcesRoute"), "SourcesRoute"),
});

const routeTree = rootRoute.addChildren([
  searchRoute,
  browseRoute,
  titleRoute,
  personRoute,
  collectionRoute,
  termRoute,
  awardsRoute,
  awardPeopleRoute,
  ceremonyRoute,
  listsRoute,
  watchlistRoute,
  requestsRoute,
  logRoute,
  accountRoute,
  adminRoute.addChildren([
    adminOverviewRoute,
    adminUsersRoute,
    adminUserRoute,
    adminInvitesRoute,
    adminAddonsRoute,
  ]),
  sourcesRoute,
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
