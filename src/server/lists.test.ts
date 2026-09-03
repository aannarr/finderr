/**
 * The list-completion payload.
 *
 * Both collaborators are injected, so every case here is exercised with no index, no
 * library and no server -- which is the point of the split: the payload's rules are about
 * WHICH lists get a count and what the denominator means, and none of that needs SQLite to
 * be true.
 */

import { describe, expect, test } from "bun:test";
import { computedLists } from "../lib/lists";
import { completionPayload } from "./lists";

const YEAR = 2026;

/** A fake index: `size` ids for every list, or none for the ones named as unranked. */
function members(size: number, unranked: string[] = []) {
  return (list: { id: string }) =>
    unranked.includes(list.id) ? [] : Array.from({ length: size }, (_, i) => `tt${list.id}-${i}`);
}

describe("completionPayload", () => {
  test("one entry per computed list, counted against the library", () => {
    const payload = completionPayload({
      year: YEAR,
      members: members(250),
      // Every third id owned, so the count is a real function of the ids rather than a
      // constant a broken implementation could also return.
      ownedCount: (ids) => ids.filter((_, i) => i % 3 === 0).length,
    });

    expect(payload.completions).toHaveLength(computedLists(YEAR).length);
    for (const c of payload.completions) {
      expect(c.size).toBe(250);
      expect(c.owned).toBe(84);
    }
  });

  test("a list with no members is OMITTED, never sent as zero", () => {
    // An index built before the rank column, or a genre nothing is ranked in, has no list to
    // be complete of. "You own 0 of 0" reads as an empty library rather than as an absent
    // list, so the id simply is not there and every surface draws nothing for it.
    const payload = completionPayload({
      year: YEAR,
      members: members(250, ["genre-horror", "top-250-series"]),
      ownedCount: () => 1,
    });

    const ids = payload.completions.map((c) => c.id);
    expect(ids).not.toContain("genre-horror");
    expect(ids).not.toContain("top-250-series");
    expect(ids).toContain("top-250");
  });

  test("an index with nothing ranked yields an empty payload rather than a wall of zeroes", () => {
    expect(completionPayload({ year: YEAR, members: () => [], ownedCount: () => 0 })).toEqual({
      completions: [],
    });
  });

  test("`size` is what the index RETURNED, not what was asked for", () => {
    // A thin slice is genuinely a shorter list. Printing "of 250" for a list holding 31
    // would be a denominator nobody could ever reach.
    const payload = completionPayload({
      year: YEAR,
      members: members(31),
      ownedCount: (ids) => ids.length,
    });

    for (const c of payload.completions) {
      expect(c.size).toBe(31);
      expect(c.owned).toBe(31);
    }
  });

  test("the year decides which decade lists get a count", () => {
    // The catalogue is generated from a year and the server passes its own clock, so this is
    // the one input that changes the SET of ids in the payload rather than their values.
    const ids = (year: number) =>
      completionPayload({ year, members: members(10), ownedCount: () => 0 }).completions.map((c) => c.id);

    expect(ids(2026)).toContain("decade-2020");
    expect(ids(2026)).not.toContain("decade-2030");
    expect(ids(2031)).toContain("decade-2030");
  });
});
