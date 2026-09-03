import { describe, expect, test } from "bun:test";
import {
  type ClickRow,
  decodeFilters,
  encodeFilters,
  NO_SEARCH_LOG,
  parseClickBody,
  QUERY_MAX,
  SearchLog,
  type SearchLogSink,
  type SearchRow,
  settledSearches,
  TYPING_WINDOW_MS,
} from "./search-log";

/** A sink that keeps what it was given, so a test can assert on writes rather than on SQL. */
class Recorder implements SearchLogSink {
  searches: SearchRow[] = [];
  clicks: ClickRow[] = [];
  writeSearches(rows: readonly SearchRow[]): void {
    this.searches.push(...rows);
  }
  writeClicks(rows: readonly ClickRow[]): void {
    this.clicks.push(...rows);
  }
}

const row = (query: string, at: number, results = 5): SearchRow => ({ query, at, results });

describe("filters on a row", () => {
  test("keeps the four declared scalars and drops everything else", () => {
    // The pick is the privacy rule in code: a param nobody ruled on cannot ride in on a
    // spread, which is how `role` once reached the browse cache key.
    const encoded = encodeFilters({
      genre: "Horror",
      decade: 1990,
      year: 1994,
      kind: "movie",
      session: "abc",
    } as never);

    expect(JSON.parse(encoded ?? "null")).toEqual({
      genre: "Horror",
      decade: 1990,
      year: 1994,
      kind: "movie",
    });
  });

  test("an unfiltered search stores null rather than an empty object", () => {
    // Null is what an old row reads back as, and it means "we do not know". An empty object
    // would claim the searcher applied no chip, which is a different statement.
    expect(encodeFilters(undefined)).toBeNull();
    expect(encodeFilters({})).toBeNull();
  });

  test("round-trips what it wrote", () => {
    expect(decodeFilters(encodeFilters({ genre: "Horror", year: 1994 }))).toEqual({
      genre: "Horror",
      year: 1994,
    });
  });

  test.each([
    ["a row written before the column existed", null],
    ["junk somebody typed into the table", "{not json"],
    ["a scalar where an object belongs", '"Horror"'],
    ["a filter of the wrong type", '{"decade":"nineties"}'],
  ])("reads %s as no filters rather than throwing", (_label, stored) => {
    expect(decodeFilters(stored)).toBeUndefined();
  });
});

describe("settledSearches", () => {
  test("drops the prefixes somebody typed on the way to the query they meant", () => {
    const settled = settledSearches([
      row("the matr", 1_000),
      row("the matri", 1_200),
      row("the matrix", 1_400),
    ]);

    expect(settled.map((r) => r.query)).toEqual(["the matrix"]);
  });

  test("keeps a prefix that was never extended", () => {
    // Somebody searched "dune", read the results, and searched something else five seconds
    // later. "dune" is what they meant, not a fragment of "dune 1984".
    const settled = settledSearches([row("dune", 1_000), row("dune 1984", 1_000 + TYPING_WINDOW_MS + 1)]);

    expect(settled.map((r) => r.query)).toEqual(["dune", "dune 1984"]);
  });

  test("collapses a repeat of the same query, because a string starts with itself", () => {
    const settled = settledSearches([row("silo", 1_000, 25), row("silo", 1_500, 25)]);

    expect(settled).toHaveLength(1);
    expect(settled[0].at).toBe(1_500);
  });

  test("compares case-insensitively -- the typist's shift key is not a different query", () => {
    const settled = settledSearches([row("The Mat", 1_000), row("the matrix", 1_100)]);

    expect(settled.map((r) => r.query)).toEqual(["the matrix"]);
  });

  test("keeps a repeat that a chip narrowed, because that is the chip evidence", () => {
    // Without this the whole `filters` column is pointless: a chip click re-runs the same
    // text, so settling on the text alone would collapse the before and after into one row.
    const settled = settledSearches([
      row("dune", 1_000),
      { ...row("dune", 1_500), filters: { genre: "Sci-Fi" } },
    ]);

    expect(settled.map((r) => r.filters)).toEqual([undefined, { genre: "Sci-Fi" }]);
  });

  test("still collapses a repeat carrying the same chip", () => {
    const filters = { genre: "Sci-Fi" };
    const settled = settledSearches([
      { ...row("dun", 1_000), filters },
      { ...row("dune", 1_500), filters },
    ]);

    expect(settled.map((r) => r.query)).toEqual(["dune"]);
  });

  test("keeps two unrelated queries in the same window", () => {
    const settled = settledSearches([row("dune", 1_000), row("silo", 1_100)]);

    expect(settled.map((r) => r.query)).toEqual(["dune", "silo"]);
  });
});

describe("SearchLog", () => {
  test("records nothing until it is flushed", () => {
    const sink = new Recorder();
    const log = new SearchLog(sink);
    log.searched("interstellar", 25, undefined, 1_000);

    expect(sink.searches).toEqual([]);
    expect(log.report().pending).toBe(1);
  });

  test("holds a row younger than the typing window so a prefix cannot escape settling", () => {
    const sink = new Recorder();
    const log = new SearchLog(sink);
    log.searched("the matr", 2, undefined, 10_000);

    // The flush lands 500ms later: the typist may still be mid-word, so writing now would
    // record a fragment as if it were a query.
    log.flush(10_500);
    expect(sink.searches).toEqual([]);

    log.searched("the matrix", 25, undefined, 10_600);
    log.flush(10_600 + TYPING_WINDOW_MS + 1);
    expect(sink.searches.map((r) => r.query)).toEqual(["the matrix"]);
  });

  test("writes a settled row once and does not write it again", () => {
    const sink = new Recorder();
    const log = new SearchLog(sink);
    log.searched("bridgerton", 3, undefined, 1_000);

    log.flush(1_000 + TYPING_WINDOW_MS + 1);
    log.flush(1_000 + TYPING_WINDOW_MS + 2);

    expect(sink.searches).toHaveLength(1);
    expect(log.report().searches).toBe(1);
  });

  test("keeps a zero-result query, which is the failure the log exists to find", () => {
    const sink = new Recorder();
    const log = new SearchLog(sink);
    log.searched("solstollarna 1999", 0, undefined, 1_000);
    log.flush(1_000 + TYPING_WINDOW_MS + 1);

    expect(sink.searches[0]).toMatchObject({ query: "solstollarna 1999", results: 0 });
  });

  test("carries the chips that were applied, and no key at all when none were", () => {
    const sink = new Recorder();
    const log = new SearchLog(sink);
    log.searched("dune", 12, { genre: "Sci-Fi", decade: undefined }, 1_000);
    log.searched("silo", 7, undefined, 1_000);
    log.flush(1_000 + TYPING_WINDOW_MS + 1);

    expect(sink.searches.map((r) => r.filters)).toEqual([{ genre: "Sci-Fi" }, undefined]);
  });

  test("clicks flush immediately -- there is no prefix to wait for", () => {
    const sink = new Recorder();
    const log = new SearchLog(sink);
    log.clicked({ query: "dune", tconst: "tt1160419", rank: 3, tier: "fts", at: 1_000 });
    log.flush(1_000);

    expect(sink.clicks).toHaveLength(1);
    expect(sink.clicks[0].rank).toBe(3);
  });

  test("ignores a blank query and bounds a huge one", () => {
    const sink = new Recorder();
    const log = new SearchLog(sink);
    log.searched("   ", 0, undefined, 1_000);
    log.searched("x".repeat(QUERY_MAX + 500), 0, undefined, 1_000);
    log.flush(1_000 + TYPING_WINDOW_MS + 1);

    expect(sink.searches).toHaveLength(1);
    expect(sink.searches[0].query).toHaveLength(QUERY_MAX);
  });

  test("a full buffer drops and counts rather than growing", () => {
    const sink = new Recorder();
    const log = new SearchLog(sink, TYPING_WINDOW_MS, 2);
    for (const q of ["a", "b", "c", "d"]) log.searched(q, 1, undefined, 1_000);

    expect(log.report().dropped).toBe(2);
    expect(log.report().pending).toBe(2);
  });
});

describe("parseClickBody", () => {
  const good = { query: "dune", tconst: "tt1160419", rank: 0, tier: "fts" };

  test("accepts a well-formed report and stamps it", () => {
    expect(parseClickBody(good, 42)).toEqual({
      query: "dune",
      tconst: "tt1160419",
      rank: 0,
      tier: "fts",
      at: 42,
    });
  });

  test("refuses a tier that is not one of ours", () => {
    // The vocabulary lives with the engine (`TIERS` in ./search), so this cannot drift.
    expect(parseClickBody({ ...good, tier: "magic" }, 1)).toBeNull();
  });

  test.each([
    ["not an object", "nope"],
    ["a missing query", { ...good, query: undefined }],
    ["a blank query", { ...good, query: "  " }],
    ["a title id from nowhere", { ...good, tconst: "../../etc/passwd" }],
    ["a negative rank", { ...good, rank: -1 }],
    ["a fractional rank", { ...good, rank: 1.5 }],
  ])("refuses %s", (_label, body) => {
    expect(parseClickBody(body, 1)).toBeNull();
  });
});

describe("NO_SEARCH_LOG", () => {
  test("accepts everything and remembers nothing", () => {
    NO_SEARCH_LOG.searched("dune", 25, undefined, 1_000);
    NO_SEARCH_LOG.clicked({ query: "dune", tconst: "tt1160419", rank: 0, tier: "fts", at: 1 });
    NO_SEARCH_LOG.flush(9_999);

    expect(NO_SEARCH_LOG.report()).toEqual({ pending: 0, searches: 0, clicks: 0, dropped: 0 });
  });
});
