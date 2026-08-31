import { describe, expect, test } from "bun:test";
import type { TitleRow } from "../lib/search";
import { discoveryShelves, facetCoverage, frontPageTitles, type ShelfDeps } from "./shelves";

function row(tconst: string, title = tconst, kind = "movie"): TitleRow {
  return {
    tconst,
    title,
    orig: null,
    year: 2010,
    kind,
    votes: 1000,
    rating: 8,
    genres: "Drama",
    runtime: 100,
  };
}

/**
 * Every source answers with something identifiable, so a shelf's contents say which
 * query produced them. Overridden per test for the case under examination.
 */
function depsWith(
  over: Partial<ShelfDeps["engine"]> = {},
  owned: string[] = [],
  added: string[] = [],
): ShelfDeps {
  return {
    engine: {
      topRated: (opts = {}) => [row(`top-${opts.kind}`, `top ${opts.kind}`, opts.kind ?? "movie")],
      anticipated: () => [row("soon")],
      newThisDecade: () => [row("decade")],
      topGenres: () => ["Horror"],
      topRatedInGenre: (genre) => [row(`genre-${genre}`)],
      byTconst: (id) => (added.includes(id) ? row(id) : null),
      ...over,
    } as ShelfDeps["engine"],
    store: {
      libraryMap: () => new Map(owned.map((id) => [id, {}])),
      recentlyAddedIds: () => added,
    } as unknown as ShelfDeps["store"],
    now: () => Date.parse("2026-06-15T00:00:00Z"),
  };
}

describe("discoveryShelves", () => {
  test("the front page is every shelf the client renders, in order", () => {
    const ids = discoveryShelves(depsWith({}, [], ["owned-1"])).map((s) => s.id);
    expect(ids).toEqual([
      "recently-added",
      "top-movies",
      "top-series",
      "coming-soon",
      "new-decade",
      "genre-horror",
    ]);
  });

  /** A blank row is worse than no row, and the warm loop must not count titles nobody sees. */
  test("a shelf that came back empty is dropped rather than rendered", () => {
    const shelves = discoveryShelves(depsWith({ anticipated: () => [] }));
    expect(shelves.map((s) => s.id)).not.toContain("coming-soon");
    // With no library mirror there is nothing recently added either.
    expect(shelves.map((s) => s.id)).not.toContain("recently-added");
  });

  /**
   * Exclusion is the ENGINE's job on every discovery shelf, so what this file owes is the
   * wiring: the library mirror's keys reach the query as `excludeTconsts`. Asserting on the
   * returned rows instead would only prove the fake engine ignored the option it was handed.
   */
  test("what the library already holds is handed to the engine as an exclusion", () => {
    const seen: (Set<string> | undefined)[] = [];
    discoveryShelves(
      depsWith(
        {
          topRated: (opts = {}) => {
            seen.push(opts.excludeTconsts);
            return [row(`top-${opts.kind}`)];
          },
        },
        ["owned-1"],
      ),
    );
    expect(seen.length).toBeGreaterThan(0);
    for (const excluded of seen) expect([...(excluded ?? [])]).toEqual(["owned-1"]);
  });

  test("recently-added is read out of the mirror, in the mirror's order", () => {
    const shelves = discoveryShelves(depsWith({}, [], ["tt2", "tt1"]));
    const recent = shelves.find((s) => s.id === "recently-added");
    expect(recent?.rows.map((r) => r.tconst)).toEqual(["tt2", "tt1"]);
  });

  /** The decade chip must point at the decade we are in, not at whenever this shipped. */
  test("the new-decade shelf browses to the current decade", () => {
    const shelves = discoveryShelves(depsWith());
    expect(shelves.find((s) => s.id === "new-decade")?.browse).toEqual({ decade: "2020" });
  });
});

describe("frontPageTitles", () => {
  /**
   * The whole point of deduplicating: a well-reviewed horror film sits on two shelves,
   * and warming it twice pays for the same upstream document twice.
   */
  test("a title on several shelves is warmed once", () => {
    const shared = row("tt-shared");
    const titles = frontPageTitles([
      { id: "a", title: "A", rows: [shared, row("tt-a")] },
      { id: "b", title: "B", rows: [shared] },
    ]);
    expect(titles.map((t) => t.tconst)).toEqual(["tt-shared", "tt-a"]);
  });
});

describe("facetCoverage", () => {
  test("it counts warm titles per shelf, by the caller's definition of warm", () => {
    const warm = new Set(["tt-warm"]);
    const coverage = facetCoverage(
      [
        { id: "a", title: "A", rows: [row("tt-warm"), row("tt-cold")] },
        { id: "b", title: "B", rows: [row("tt-warm")] },
      ],
      (r) => warm.has(r.tconst),
    );
    expect(coverage).toEqual([
      { shelf: "a", titles: 2, warm: 1 },
      { shelf: "b", titles: 1, warm: 1 },
    ]);
  });
});
