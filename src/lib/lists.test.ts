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
import { AWARDS, awardById } from "./award-registry";
import {
  CURATED,
  completionNoun,
  computedLists,
  describeFilters,
  isAllTimeList,
  kindNoun,
  LIST_GENRES,
  LIST_LANGUAGES,
  LIST_SIZE,
  listDecades,
  listForFilters,
  listGroups,
  listLanguageName,
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

  test("there is a language list per catalogued language, and none is English", () => {
    const langs = lists.map((l) => l.filters.lang).filter(Boolean);
    expect(langs).toEqual(LIST_LANGUAGES.map((l) => l.code));
    // Every one of these rows means "and not also in English". A list FOR English would be
    // the one row where that rule reads as a contradiction, and `top-250` is already the
    // list an English-speaking reader is looking for.
    expect(langs).not.toContain("en");
  });

  test("a language list names the language, never a nationality", () => {
    // We hold P364, the film's original LANGUAGE. Where it was made, who paid for it and
    // whether it played in a cinema are all things this index cannot answer, so a row
    // saying "Best Korean films" would claim more than the filter did.
    const korean = lists.find((l) => l.filters.lang === "ko");
    expect(korean?.title).toBe("Best films in Korean");
    expect(korean?.id).toBe("lang-ko");
  });

  test("no language list trips the all-time predicate", () => {
    // `isAllTimeList` is a `startsWith("top-250")` test whose second reader decides which
    // titles the people boards on `/lists` rank over -- so an id tripping it would quietly
    // change what "most-credited director" means. It is one naming decision, made here.
    for (const list of lists) {
      if (list.filters.lang) expect(isAllTimeList(list)).toBe(false);
    }
  });
});

describe("LIST_LANGUAGES", () => {
  test("every code is a bare ISO 639-1 code, which is all `title_lang` stores", () => {
    // `parseOriginCsv` keeps only two-letter codes, so a three-letter entry here would be a
    // list that can never match a row -- and it would still cost its query every time
    // `/lists` was drawn.
    for (const language of LIST_LANGUAGES) expect(language.code).toMatch(/^[a-z]{2}$/);
  });

  test("codes are unique, and so are the names", () => {
    expect(new Set(LIST_LANGUAGES.map((l) => l.code)).size).toBe(LIST_LANGUAGES.length);
    expect(new Set(LIST_LANGUAGES.map((l) => l.name)).size).toBe(LIST_LANGUAGES.length);
  });

  test("every name is spelled, never derived from the runtime's CLDR table", () => {
    for (const language of LIST_LANGUAGES) expect(language.name.length).toBeGreaterThan(0);
    // Pinned rather than asserted generically: these are titles on a page, and the reason
    // they are stored is that `Intl.DisplayNames` answers from whatever ICU the runtime
    // shipped -- so the server and the browser could disagree about a row's name.
    expect(listLanguageName("ko")).toBe("Korean");
    expect(listLanguageName("pt")).toBe("Portuguese");
  });

  test("a code with no list has no name, rather than an invented one", () => {
    // `/browse?lang=xx` is a legitimately empty page, and its heading prints the raw code.
    // Naming a language we offer no list of would claim knowledge we did not check.
    expect(listLanguageName("xx")).toBeUndefined();
    expect(listLanguageName(undefined)).toBeUndefined();
  });
});

describe("listForFilters", () => {
  test("it finds the list a set of browse filters IS", () => {
    // The reverse of `computedLists`, and what lets a ranked `/browse` know it is looking at
    // "Best Horror" rather than at an anonymous grid.
    expect(listForFilters(YEAR, { kind: "movie", genre: "Horror" })?.id).toBe("genre-horror");
    expect(listForFilters(YEAR, { kind: "movie", decade: 2020 })?.id).toBe("decade-2020");
    expect(listForFilters(YEAR, { kind: "movie", lang: "ko" })?.id).toBe("lang-ko");
    expect(listForFilters(YEAR, { kind: "movie" })?.id).toBe("top-250");
  });

  test("a language is compared, so a language browse is not the Top 250", () => {
    // The one that would be silent: with `lang` left out of the comparison,
    // `/browse?lang=ko&kind=movie&sort=rank` resolves to `finderr Top 250` and prints THAT
    // list's completion under a Korean heading -- a right-looking number for another set.
    expect(listForFilters(YEAR, { kind: "movie", lang: "ko" })?.id).not.toBe("top-250");
    // And a language we offer no list of is not a list at all.
    expect(listForFilters(YEAR, { kind: "movie", lang: "xx" })).toBeUndefined();
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

  test("the language group exists, because a list with no group renders nowhere", () => {
    // The silent failure this catches: `listGroups` matches ids by PREFIX and drops any
    // group that came out empty, so a family added to `computedLists` alone would pass every
    // other test here, ride the completion payload, cost its query, and draw on no page.
    const language = listGroups(YEAR).find((g) => g.lists.some((l) => l.filters.lang));
    expect(language).toBeDefined();
    expect(language?.lists).toHaveLength(LIST_LANGUAGES.length);
  });

  test("only the language group has to prove its rows", () => {
    // Genre and decade are carried by every index this product has ever built, so drawing
    // them before the completion lands is what keeps `/lists` complete on first paint.
    // Language arrived in a build stage that indexes in the field predate, so its rows have
    // to be substantiated -- see `ListGroup.requiresMembers`.
    for (const group of listGroups(YEAR)) {
      expect(group.requiresMembers ?? false).toBe(group.lists.some((l) => l.filters.lang !== undefined));
    }
  });
});

describe("CURATED", () => {
  test("every row resolves to an award, so none of them is a dead end", () => {
    // The rule this replaces was "`to` starts with one slash and not two" -- a check that a
    // hand-written path was same-origin. There is no path to write now: `/awards/$award`
    // takes the row's own id, so the destination exists whenever the award does.
    for (const list of CURATED) expect(awardById(list.id)).toBeDefined();
    expect(CURATED).toHaveLength(AWARDS.length);
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

describe("describeFilters", () => {
  test("it reads as a sentence, in the order a reader would say it", () => {
    expect(describeFilters({ genre: "Horror", kind: "movie", decade: 1980 }, true)).toBe(
      "best Horror films from the 1980s",
    );
    expect(describeFilters({ genre: "Crime", lang: "sv" }, true)).toBe("best Crime titles in Swedish");
  });

  test("only a RANKED browse says 'best'", () => {
    expect(describeFilters({ genre: "Horror", kind: "movie" }, false)).toBe("Horror films");
  });

  test("a year is more specific than a decade, so it wins", () => {
    expect(describeFilters({ kind: "movie", year: 1988, decade: 1980 }, false)).toBe("films from 1988");
  });

  test("an unknown language code prints itself rather than a guessed name", () => {
    expect(describeFilters({ lang: "zz" }, false)).toBe("titles in zz");
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
