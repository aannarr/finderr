import { describe, expect, test } from "bun:test";
import {
  isTermDimension,
  isTermLinkable,
  MIN_TERM_TITLES,
  type TermPair,
  termKey,
  termPage,
  termsOf,
} from "./terms";

const pair = (tconst: string, term: string): TermPair => ({ tconst, term });

describe("termKey", () => {
  /** Two providers spell one keyword two ways; a reader asking for either wants one page. */
  test("case and whitespace fold away", () => {
    expect(termKey("keyword", "  Heist  ")).toBe("heist");
    expect(termKey("keyword", "TIME   LOOP")).toBe("time loop");
    expect(termKey("studio", "Warner Bros. Pictures")).toBe("warner bros. pictures");
  });

  /**
   * The fold is SHALLOW on purpose. Slugging further would merge terms that are genuinely
   * different, and the URL layer escapes what it needs to.
   */
  test("punctuation survives, because it distinguishes real terms", () => {
    expect(termKey("keyword", "Sci-Fi & Fantasy")).toBe("sci-fi & fantasy");
    expect(termKey("keyword", "sci-fi")).not.toBe(termKey("keyword", "scifi"));
  });

  /** A service has a mark table behind it, so its fold is the one `watchServices` uses. */
  test("a service folds through its own 42-spelling table", () => {
    expect(termKey("service", "Netflix Standard with Ads")).toBe(termKey("service", "Netflix"));
    expect(termKey("service", "HBO Max Amazon Channel")).toBe(termKey("service", "HBO Max"));
    expect(termKey("service", "Disney")).not.toBe(termKey("service", "Disney+"));
  });
});

describe("isTermDimension", () => {
  test("only the three we serve", () => {
    expect(isTermDimension("keyword")).toBe(true);
    expect(isTermDimension("service")).toBe(true);
    expect(isTermDimension("studio")).toBe(true);
    expect(isTermDimension("genre")).toBe(false);
    expect(isTermDimension(undefined)).toBe(false);
  });
});

describe("termsOf", () => {
  test("every spelling of one term lands on one key, most-populated first", () => {
    const terms = termsOf("keyword", [
      pair("tt1", "Heist"),
      pair("tt2", "heist"),
      pair("tt3", "HEIST"),
      pair("tt1", "Dream"),
    ]);

    expect(terms.map((t) => [t.key, t.titles])).toEqual([
      ["heist", 3],
      ["dream", 1],
    ]);
  });

  /**
   * `keywords` merges as a LIST and nothing deduplicates it, so a series answered by both
   * `servarr-metadata` and `tmdb` contributes two rows naming the same keyword. Counting
   * rows would inflate the very number the dead-end rule is read off.
   */
  test("a title counts once however many rows named it", () => {
    const terms = termsOf("keyword", [pair("tt1", "Heist"), pair("tt1", "heist"), pair("tt2", "Heist")]);
    expect(terms[0]).toMatchObject({ key: "heist", titles: 2 });
  });

  /** The corpus decides the label, not whichever row SQLite returned first. */
  test("the commonest spelling becomes the label", () => {
    const terms = termsOf("keyword", [pair("tt1", "heist"), pair("tt2", "heist"), pair("tt3", "Heist")]);
    expect(terms[0]?.label).toBe("heist");
  });

  test("a tie on frequency breaks alphabetically, so the label is stable", () => {
    const forwards = termsOf("keyword", [pair("tt1", "Heist"), pair("tt2", "heist")]);
    const backwards = termsOf("keyword", [pair("tt2", "heist"), pair("tt1", "Heist")]);
    // Which one wins is arbitrary; that it is the SAME one whichever order the rows
    // arrived in is the whole property, because the alternative is a label that flips
    // between two renders of one page.
    expect(forwards[0]?.label).toBe(backwards[0]?.label);
    expect(forwards[0]?.label).toBe("heist");
  });

  test("a blank term is not a term", () => {
    expect(termsOf("studio", [pair("tt1", "   "), pair("tt2", "")])).toEqual([]);
  });

  test("service pairs fold through the mark table", () => {
    const terms = termsOf("service", [
      pair("tt1", "Netflix"),
      pair("tt2", "Netflix Standard with Ads"),
      pair("tt3", "Hulu"),
    ]);
    expect(terms.map((t) => [t.key, t.titles])).toEqual([
      ["netflix", 2],
      ["hulu", 1],
    ]);
  });
});

describe("termPage", () => {
  const pairs = [pair("tt1", "Heist"), pair("tt2", "heist"), pair("tt3", "Dream")];

  test("the key is folded on the way in, so any spelling reaches the page", () => {
    expect(termPage("keyword", "HEIST", pairs)?.tconsts.sort()).toEqual(["tt1", "tt2"]);
    expect(termPage("keyword", " heist ", pairs)?.term.titles).toBe(2);
  });

  /**
   * `null` and an empty page are different answers: a term nobody has cached has no page at
   * all, which is a 404 -- the same distinction `/api/collection/:id` draws.
   */
  test("a term nothing names has no page", () => {
    expect(termPage("keyword", "submarine", pairs)).toBeNull();
    expect(termPage("keyword", "", pairs)).toBeNull();
  });
});

describe("isTermLinkable", () => {
  const term = (titles: number) => ({ dimension: "keyword" as const, key: "heist", label: "Heist", titles });

  /**
   * A term cached for exactly one title is a page containing the title you are already
   * looking at -- navigable, honest and useless. That is the dead-end rule arriving one
   * step later than expected.
   */
  test("one title is still a dead end", () => {
    expect(isTermLinkable(term(0))).toBe(false);
    expect(isTermLinkable(term(1))).toBe(false);
    expect(isTermLinkable(term(MIN_TERM_TITLES))).toBe(true);
  });
});
