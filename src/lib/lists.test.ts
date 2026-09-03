/**
 * The list catalogue.
 *
 * Every assertion here is about the CATALOGUE being well-formed rather than about how it
 * renders, which is the whole reason `lists.ts` is pure data: the page cannot show a list
 * that resolves to a browse nobody can run, and finding that out needs no DOM.
 *
 * The half that needs the ROUTER -- does a list's filters survive `validateSearch`, does a
 * curated row point at a registered route -- lives in `web/src/lib/lists.test.ts`, because
 * that is where the router is. Same catalogue, two suites, split on what each one needs.
 */

import { describe, expect, test } from "bun:test";
import {
  CURATED,
  completionNoun,
  computedLists,
  kindNoun,
  LIST_GENRES,
  LIST_SIZE,
  listDecades,
  listForFilters,
  listGroups,
  RANK_EXPLAINER,
} from "./lists";

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

  test("every list pins a kind, so no list mixes films and series", () => {
    // Films and series are rated by different crowds at different volumes, so a mixed list
    // has no honest title -- the series take the head and "the best films of the 2010s"
    // stops being about films. The TYPE says so; this says it out loud for a reader.
    for (const list of lists) expect(list.filters.kind).toBeTruthy();
  });

  test("no list pins a single year -- a year is a browse, not a list", () => {
    // `LIST_SIZE` is 250 and a single year has nowhere near that many ranked titles, so a
    // per-year list would print a denominator that is really "however many there were".
    for (const list of lists) expect(list.filters.year).toBeUndefined();
  });

  test("ids are unique, because they are React keys and completion keys", () => {
    const ids = lists.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("the genre lists are the closed editorial set, not every IMDb genre", () => {
    const genres = lists.map((l) => l.filters.genre).filter(Boolean);
    expect(genres).toEqual([...LIST_GENRES]);
    // The ones deliberately left out. "The best talk-shows of all time" is a list nobody
    // is looking for, and deriving the set from the corpus would eventually add it.
    for (const unwanted of ["Short", "News", "Talk-Show", "Adult", "Reality-TV"]) {
      expect(genres).not.toContain(unwanted);
    }
  });
});

describe("listForFilters", () => {
  test("it finds the list a set of browse filters IS", () => {
    // The reverse of `computedLists`, and what lets a ranked `/browse` know it is looking at
    // "Best Horror" rather than at an anonymous grid.
    expect(listForFilters(YEAR, { kind: "movie", genre: "Horror" })?.id).toBe("genre-horror");
    expect(listForFilters(YEAR, { kind: "movie", decade: 2020 })?.id).toBe("decade-2020");
    expect(listForFilters(YEAR, { kind: "movie" })?.id).toBe("top-250");
  });

  test("a filter the catalogue does not carry is NOT that list", () => {
    // `?genre=Horror&year=1987` is a narrower page than "Best Horror" and must not claim its
    // completion count -- the denominator would be a set the page is not showing.
    expect(listForFilters(YEAR, { kind: "movie", genre: "Horror", year: 1987 })).toBeUndefined();
    // And a filter the catalogue carries but the URL omits is a different page too.
    expect(listForFilters(YEAR, { genre: "Horror" })).toBeUndefined();
  });

  test("every list round-trips through its own filters", () => {
    for (const list of computedLists(YEAR)) {
      expect(listForFilters(YEAR, list.filters)?.id).toBe(list.id);
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
  test("a row is same-origin and absolute, never a link out", () => {
    // `/lists` is chrome inside this app. A curated row is not the place an upstream URL
    // gets in -- that rule has one owner per surface, and here it is the shape of `to`.
    for (const list of CURATED) {
      expect(list.to.startsWith("/")).toBe(true);
      expect(list.to.startsWith("//")).toBe(false);
    }
  });

  test("ids are unique, so a row cannot silently replace another", () => {
    expect(new Set(CURATED.map((l) => l.id)).size).toBe(CURATED.length);
  });
});

describe("kindNoun", () => {
  test("it names what is in a list, and never guesses", () => {
    expect(kindNoun("movie")).toBe("films");
    expect(kindNoun("tvSeries")).toBe("series");
    // An unknown kind prints ITSELF rather than being mapped to a wrong noun, and no kind
    // at all is "titles" -- the only word true of a mixed set.
    expect(kindNoun("videoGame")).toBe("videoGame");
    expect(kindNoun(undefined)).toBe("titles");
  });
});

describe("completionNoun", () => {
  test("it says the denominator is the HEAD of the list, not the whole slice", () => {
    // A ranked `/browse` prints its own "60 of 43,912" beside this sentence. Without the
    // qualifier, "you own 178 of 250 films" on that screen invites the reader to wonder
    // which 250 -- so the phrase carries the answer.
    expect(completionNoun("movie")).toBe("top-ranked films");
    expect(completionNoun("tvSeries")).toBe("top-ranked series");
  });
});

describe("LIST_SIZE", () => {
  test("it is the length in the headline list's own name", () => {
    // The constant and the words "finderr Top 250" are one fact, and this is what stops
    // them being two: changing the number without renaming the list fails here.
    expect(LIST_SIZE).toBe(250);
    expect(computedLists(YEAR)[0]?.title).toContain(String(LIST_SIZE));
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
