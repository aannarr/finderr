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
  test("every curated row's id is a usable route segment", () => {
    // A curated row goes to `/awards/$award` with its own id as the parameter, so the route
    // is registered by construction and the old "does this literal path exist" check has
    // nothing left to catch. What CAN still go wrong is an id that does not survive a URL:
    // a slash would split the segment and land on the edition route instead.
    for (const list of CURATED) {
      expect(list.id).toBe(encodeURIComponent(list.id));
      expect(list.id).not.toContain("/");
    }
  });
});
