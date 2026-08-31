/**
 * The list catalogue.
 *
 * Every assertion here is about the CATALOGUE being well-formed rather than about how it
 * renders, which is the whole reason `lists.ts` is pure data: the page cannot show a list
 * that resolves to a browse nobody can run, and finding that out needs no DOM.
 */

import { describe, expect, test } from "bun:test";
import { CURATED, computedLists, LIST_GENRES, listDecades, listGroups, RANK_EXPLAINER } from "./lists";
import { validateSearch } from "./search-params";

const YEAR = 2026;

describe("listDecades", () => {
  test("newest first, starting with the decade the year is in", () => {
    expect(listDecades(YEAR, 3)).toEqual([2020, 2010, 2000]);
    // A year at the boundary belongs to the decade it starts, same rule as `decadeOf`.
    expect(listDecades(2030, 2)).toEqual([2030, 2020]);
    expect(listDecades(2029, 2)).toEqual([2020, 2010]);
  });

  test("it takes the year rather than reading the clock", () => {
    // Pinnable on purpose: a catalogue that asked `new Date()` for itself would make this
    // suite go red on 1 January, which is the least useful morning to be debugging it.
    expect(listDecades(2026, 1)).toEqual([2020]);
    expect(listDecades(2036, 1)).toEqual([2030]);
  });
});

describe("computedLists", () => {
  const lists = computedLists(YEAR);

  test("every list is ranked -- that is what makes it a list rather than a grid", () => {
    for (const list of lists) expect(list.search.sort).toBe("rank");
  });

  test("every list pins a kind, so no list mixes films and series", () => {
    // Films and series are rated by different crowds at different volumes, so a mixed list
    // has no honest title -- the series take the head and "the best films of the 2010s"
    // stops being about films.
    for (const list of lists) expect(list.search.kind).toBeTruthy();
  });

  test("ids are unique, because they are React keys and URL fragments", () => {
    const ids = lists.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every list survives the router's own validator unchanged", () => {
    // The catalogue stores URL strings and the router hands back typed params. A list whose
    // `decade` came back undefined would render a link to the unfiltered grid while still
    // being labelled "Best of the 1990s" -- a wrong answer that looks like a right one.
    for (const list of lists) {
      const parsed = validateSearch(list.search);
      expect(parsed.sort).toBe("rank");
      expect(parsed.kind).toBe(list.search.kind);
      if (list.search.genre) expect(parsed.genre).toBe(list.search.genre);
      if (list.search.decade) expect(parsed.decade).toBe(Number(list.search.decade));
    }
  });

  test("the genre lists are the closed editorial set, not every IMDb genre", () => {
    const genres = lists.map((l) => l.search.genre).filter(Boolean);
    expect(genres).toEqual([...LIST_GENRES]);
    // The ones deliberately left out. "The best talk-shows of all time" is a list nobody
    // is looking for, and deriving the set from the corpus would eventually add it.
    for (const unwanted of ["Short", "News", "Talk-Show", "Adult", "Reality-TV"]) {
      expect(genres).not.toContain(unwanted);
    }
  });
});

describe("listGroups", () => {
  test("every computed list lands in exactly one group", () => {
    const grouped = listGroups(YEAR).flatMap((g) => g.lists.map((l) => l.id));
    const all = computedLists(YEAR).map((l) => l.id);
    expect(grouped.sort()).toEqual(all.sort());
  });

  test("an empty group is dropped rather than drawn as a bare heading", () => {
    for (const group of listGroups(YEAR)) expect(group.lists.length).toBeGreaterThan(0);
  });
});

describe("CURATED", () => {
  test("it is empty, and that is the dead-end rule rather than an oversight", () => {
    // A curated row points at its OWN route. Adding one before that route resolves puts a
    // link to a 404 on the page, which this product refuses to draw: navigable does not
    // outrank honest. It fills in when `/awards/oscars` is real.
    expect(CURATED).toEqual([]);
  });
});

describe("RANK_EXPLAINER", () => {
  test("it disclaims IMDb by name", () => {
    // The rank reproduces IMDb's Top 250 head almost exactly and will never match it,
    // because their vote filtering is unpublished. Every surface showing a computed list
    // says whose list it is, and this is the one sentence that does it.
    expect(RANK_EXPLAINER).toContain("IMDb");
    expect(RANK_EXPLAINER).toContain("finderr");
  });
});
