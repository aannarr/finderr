/**
 * The list catalogue, as the ROUTER sees it.
 *
 * The catalogue itself lives in `src/lib/lists.ts` and its own invariants are tested beside
 * it. What is left here is the half that needs this side of the tree: a list's filters have
 * to survive the router's validator, and a curated row has to name a route this app
 * actually registers. Both are about the browser, so both are tested in the browser's
 * suite.
 */

import { describe, expect, test } from "bun:test";
import { CURATED, computedLists, type ListFilters } from "../../../src/lib/lists";
import { validateSearch } from "./search-params";

const YEAR = 2026;

describe("computedLists in the URL", () => {
  test("every list survives the router's own validator unchanged", () => {
    // The catalogue stores typed filters and the router hands back typed params, but the URL
    // between them is strings. A list whose `decade` came back undefined would render a link
    // to the unfiltered grid while still being labelled "Best of the 1990s" -- a wrong answer
    // that looks like a right one.
    for (const list of computedLists(YEAR)) {
      const parsed = validateSearch({ ...list.filters, sort: "rank" });
      expect(parsed.sort).toBe("rank");
      expect(parsed.kind).toBe(list.filters.kind);
      expect(parsed.genre).toBe(list.filters.genre);
      expect(parsed.decade).toBe(list.filters.decade);
    }
  });

  test("a list survives being written to a URL and read back", () => {
    // The real round trip: object -> query string -> validator. `decade` is a number on both
    // ends and a string in the middle, which is exactly where a list quietly loses its
    // filter.
    for (const list of computedLists(YEAR)) {
      const query = new URLSearchParams({ ...toStrings(list.filters), sort: "rank" });
      const parsed = validateSearch(Object.fromEntries(query));
      expect(parsed.decade).toBe(list.filters.decade);
      expect(parsed.genre).toBe(list.filters.genre);
      expect(parsed.kind).toBe(list.filters.kind);
    }
  });
});

/** The filters as the URL carries them: strings, with the absent keys simply absent. */
function toStrings(filters: ListFilters): Record<string, string> {
  return Object.fromEntries(
    Object.entries(filters).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]])),
  );
}

describe("CURATED", () => {
  test("every curated row points at a real route, not a 404", () => {
    // The routes registered in `router.tsx`. Named here rather than imported, deliberately:
    // importing the router pulls every route COMPONENT into a test about a data table, and
    // a curated list is meant to be checkable without rendering anything.
    //
    // `CuratedPath` makes this unwriteable at the type level too. The test survives because
    // the type is a hand-kept union: it stops a row naming a path nobody serves, and THIS
    // stops the union itself drifting from the router.
    const routes = ["/awards/oscars", "/lists"];
    for (const list of CURATED) {
      expect(routes).toContain(list.to);
    }
  });
});
