/**
 * The route tree resolves the URLs the app links to.
 *
 * The tree is declared in CODE rather than generated from a directory, so a child declared
 * under the wrong parent, or a path spelled `/users/$id` where the parent already contributes
 * the prefix, is a mistake nothing else catches: `router.tsx` compiles either way, every
 * component renders in isolation either way, and the failure only shows up as a blank page in
 * a browser nobody is running.
 *
 * Admin was the only case for a while, because it is the only NESTED part of the tree -- one
 * layout with four children, one of them an index and one carrying a parameter. The awards
 * routes joined it once a STATIC segment landed beside a parameter at the same depth, which is
 * the other shape a tree declared in code can rank wrongly with nothing else noticing.
 */

import { describe, expect, test } from "bun:test";
import { router } from "./router";

/** The ids the tree resolves a path to, outermost first. `__root__` is dropped as noise. */
function matchedRoutes(pathname: string): string[] {
  return router
    .matchRoutes({ pathname, search: {}, hash: "", href: pathname, state: {} } as never)
    .map((m) => m.routeId)
    .filter((id) => id !== "__root__");
}

describe("the admin routes", () => {
  test("/admin is the layout plus its index, not a bare page", () => {
    expect(matchedRoutes("/admin")).toEqual(["/admin", "/admin/"]);
  });

  test("/admin/users is the layout plus the people list", () => {
    expect(matchedRoutes("/admin/users")).toEqual(["/admin", "/admin/users"]);
  });

  /*
    The one that a wrong prefix would break silently: the child declares `users/$id` and the
    parent contributes `/admin`. Spelled `/admin/users/$id` on the child it would resolve to
    `/admin/admin/users/...` and every row in the people list would land on a 404.
  */
  test("/admin/users/<id> reaches the person page, and carries the id", () => {
    const matches = router.matchRoutes({
      pathname: "/admin/users/u1",
      search: {},
      hash: "",
      href: "/admin/users/u1",
      state: {},
    } as never);
    expect(matches.map((m) => m.routeId).filter((id) => id !== "__root__")).toEqual([
      "/admin",
      "/admin/users/$id",
    ]);
    expect(matches.at(-1)?.params).toEqual({ id: "u1" });
  });

  test("/admin/invites is the layout plus the invitations page", () => {
    expect(matchedRoutes("/admin/invites")).toEqual(["/admin", "/admin/invites"]);
  });
});

describe("the award routes", () => {
  /**
   * `people` sits exactly where an edition key goes, and the wrong ranking is invisible.
   *
   * `/awards/$award/$ceremony` would happily match `people`, parse it as NaN and draw "we hold
   * nothing under that number" -- a real page reported as a broken URL, with nothing in the
   * type system or the build to notice. So the resolution is asserted rather than trusted to
   * a scoring rule in somebody else's library.
   */
  test("/awards/oscars/people is the leaderboards, not an edition called 'people'", () => {
    expect(matchedRoutes("/awards/oscars/people")).toEqual(["/awards/$award/people"]);
  });

  test("and the static segment did not swallow the editions beside it", () => {
    expect(matchedRoutes("/awards/oscars/96")).toEqual(["/awards/$award/$ceremony"]);
    expect(matchedRoutes("/awards/oscars")).toEqual(["/awards/$award"]);
  });
});
