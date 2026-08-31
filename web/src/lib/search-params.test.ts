import { describe, expect, test } from "bun:test";
import { collectionTokenOf, decadeOf, filtersOf, toggleFilter, validateSearch } from "./search-params";

describe("collectionTokenOf", () => {
  test("reads a franchise name, quoted or bare", () => {
    expect(collectionTokenOf('collection:"lord of the rings"')?.name).toBe("lord of the rings");
    expect(collectionTokenOf("collection:the matrix")?.name).toBe("the matrix");
    expect(collectionTokenOf("COLLECTION: The Matrix ")?.name).toBe("The Matrix");
  });

  /**
   * The regression behind `closed`. Every keystroke reaches the URL, so an unquoted token
   * is read while it is still being typed -- and `collection:star`, one keystroke into
   * "star trek", matches exactly one collection. Auto-navigating on uniqueness alone
   * discarded the rest of the typing with `replace`, so nothing came Back.
   */
  test("only a closed pair of quotes says the name is finished", () => {
    expect(collectionTokenOf('collection:"star wars"')?.closed).toBe(true);
    expect(collectionTokenOf("collection:star")?.closed).toBe(false);
    expect(collectionTokenOf("collection:star trek")?.closed).toBe(false);
    // Still being typed: the opening quote is there and the closing one is not, so the
    // bare branch catches it and the name keeps its stray quote rather than the token
    // pretending to be finished.
    expect(collectionTokenOf('collection:"star')?.closed).toBe(false);
  });

  /**
   * The token must claim as little as possible: it changes the whole meaning of the box,
   * so anything short of the literal prefix is an ordinary query.
   */
  test("an ordinary query is left alone", () => {
    expect(collectionTokenOf("the criterion collection")).toBeNull();
    expect(collectionTokenOf("collection")).toBeNull();
    expect(collectionTokenOf(undefined)).toBeNull();
  });

  /** Half-typed: `collection:` with nothing after it is not yet an address. */
  test("a token with no name is not a token", () => {
    expect(collectionTokenOf("collection:")).toBeNull();
    expect(collectionTokenOf('collection:""')).toBeNull();
  });
});

describe("validateSearch", () => {
  test("keeps the query and every facet", () => {
    expect(validateSearch({ q: "fargo", genre: "Drama", kind: "movie", decade: 1990, year: 1996 })).toEqual({
      q: "fargo",
      genre: "Drama",
      kind: "movie",
      decade: 1990,
      year: 1996,
    });
  });

  test("coerces numeric params arriving as strings from the URL", () => {
    // Everything in a real query string is a string; nothing else in the app should
    // have to remember that.
    expect(validateSearch({ decade: "1980", year: "1984" })).toEqual({ decade: 1980, year: 1984 });
  });

  /**
   * Hand-typed and stale URLs are expected input, not an error case -- a junk param
   * must drop out rather than produce an error page or a NaN that reaches the API.
   */
  test("drops junk instead of throwing", () => {
    expect(validateSearch({ decade: "banana", year: "-5" })).toEqual({});
    expect(validateSearch({ q: "   " })).toEqual({});
    expect(validateSearch({})).toEqual({});
    expect(validateSearch({ genre: "", kind: "" })).toEqual({});
  });

  /**
   * THE SPACE BUG. The search box is CONTROLLED by `search.q`, so whatever this returns
   * is what the box redraws with on the very next keystroke. Trimming `q` here meant the
   * space in "blade runner" was deleted the instant it was typed, and the box was
   * untypeable for any query of more than one word.
   */
  test("keeps a trailing space in q -- the box is controlled by it", () => {
    expect(validateSearch({ q: "blade " })).toEqual({ q: "blade " });
    expect(validateSearch({ q: " blade" })).toEqual({ q: " blade" });
    expect(validateSearch({ q: "blade  runner" })).toEqual({ q: "blade  runner" });
  });

  test("omits empty keys so the URL does not accumulate ?q=&genre=", () => {
    const out = validateSearch({ q: "fargo", genre: "" });
    expect(Object.keys(out)).toEqual(["q"]);
  });

  test("ignores params it does not know about", () => {
    expect(validateSearch({ q: "fargo", utm_source: "somewhere" })).toEqual({ q: "fargo" });
  });
});

describe("decadeOf", () => {
  test("floors a year to its decade", () => {
    expect(decadeOf(1994)).toBe(1990);
    expect(decadeOf(1990)).toBe(1990);
    expect(decadeOf(1999)).toBe(1990);
    expect(decadeOf(2000)).toBe(2000);
  });

  /**
   * The index runs 1894-2032, so the chip has to be right at both ends -- the
   * decade label on a 1901 short and on a 2029 announcement are both real pages.
   */
  test("holds at the ends of the index", () => {
    expect(decadeOf(1894)).toBe(1890);
    expect(decadeOf(2029)).toBe(2020);
    expect(decadeOf(2032)).toBe(2030);
  });

  /** It produces a `decade` filter value, so a round trip through the URL must survive. */
  test("produces a value validateSearch keeps", () => {
    expect(validateSearch({ decade: String(decadeOf(1994)) })).toEqual({ decade: 1990 });
  });
});

describe("filtersOf", () => {
  test("strips the query, leaving what the search API takes", () => {
    expect(filtersOf({ q: "fargo", genre: "Drama", decade: 1990 })).toEqual({
      genre: "Drama",
      decade: 1990,
    });
  });

  test("a query-only params object has no filters", () => {
    expect(filtersOf({ q: "fargo" })).toEqual({});
  });

  test("a non-filter param does not ride into a browse query", () => {
    // `role` is a person page's credit-category selection. This used to omit `q` and pass
    // everything else through, so `role` would have reached `/api/browse?role=...` AND
    // the browse cache key -- making two identical grids reached from different pages two
    // separate cache entries. Picking known keys is what stops the next one doing it too.
    expect(filtersOf({ q: "fargo", genre: "Drama", role: "actor,actress" })).toEqual({
      genre: "Drama",
    });
  });
});

describe("toggleFilter", () => {
  test("adds a facet, keeping the query", () => {
    expect(toggleFilter({ q: "fargo" }, { genre: "Drama" })).toEqual({ q: "fargo", genre: "Drama" });
  });

  /** The chip is a toggle, not a radio -- clicking the active one clears it. */
  test("clicking the active facet clears it", () => {
    expect(toggleFilter({ q: "fargo", genre: "Drama" }, { genre: "Drama" })).toEqual({ q: "fargo" });
  });

  test("switching to a different value of the same facet replaces it", () => {
    expect(toggleFilter({ q: "fargo", genre: "Drama" }, { genre: "Crime" })).toEqual({
      q: "fargo",
      genre: "Crime",
    });
  });

  test("facets of different kinds stack", () => {
    const a = toggleFilter({ q: "fargo" }, { genre: "Drama" });
    const b = toggleFilter(a, { decade: 1990 });
    expect(b).toEqual({ q: "fargo", genre: "Drama", decade: 1990 });
  });

  test("does not mutate the params it was given", () => {
    const before = { q: "fargo", genre: "Drama" };
    toggleFilter(before, { genre: "Drama" });
    expect(before).toEqual({ q: "fargo", genre: "Drama" });
  });
});
