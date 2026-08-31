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
/** One row per source, so a shelf's contents say which source produced them. */
const UPCOMING: Record<string, string[]> = {
  radarr: ["up-radarr"],
  sonarr: ["up-sonarr"],
  "tmdb-movie": ["up-tmdb-movie"],
  "tmdb-series": ["up-tmdb-series"],
};

function depsWith(
  over: Partial<ShelfDeps["engine"]> = {},
  owned: string[] = [],
  added: string[] = [],
  upcoming: Record<string, string[]> = UPCOMING,
): ShelfDeps {
  const upcomingIds = new Set(Object.values(upcoming).flat());
  return {
    engine: {
      topRated: (opts = {}) => [row(`top-${opts.kind}`, `top ${opts.kind}`, opts.kind ?? "movie")],
      newThisDecade: () => [row("decade")],
      topGenres: () => ["Horror"],
      topRatedInGenre: (genre) => [row(`genre-${genre}`)],
      byTconst: (id) => (added.includes(id) || upcomingIds.has(id) ? row(id) : null),
      // The Top 250 shelf. It goes through `browse` rather than a bespoke engine method
      // precisely so the shelf and the "see all" link behind it cannot order differently,
      // which is why the fake answers in the same shape a real browse does.
      browse: (opts) => ({ rows: [row(`ranked-${opts.kind}`, `ranked ${opts.kind}`, opts.kind)], total: 1 }),
      ...over,
    } as ShelfDeps["engine"],
    store: {
      libraryMap: () => new Map(owned.map((id) => [id, {}])),
      recentlyAddedIds: () => added,
      upcomingBySource: (source: string) =>
        (upcoming[source] ?? []).map((tconst) => ({
          tconst,
          kind: "movie",
          source,
          date: "2026-09-01",
          date_kind: "cinemas",
          detail: null,
        })),
    } as unknown as ShelfDeps["store"],
    now: () => Date.parse("2026-06-15T00:00:00Z"),
  };
}

describe("discoveryShelves", () => {
  test("the front page is every shelf the client renders, in order", () => {
    const ids = discoveryShelves(depsWith({}, [], ["owned-1"])).map((s) => s.id);
    expect(ids).toEqual([
      "recently-added",
      "top-250",
      "top-movies",
      "top-series",
      "airing-soon-series",
      "airing-soon-movies",
      "coming-soon-movies",
      "coming-soon-series",
      "new-decade",
      "genre-horror",
    ]);
  });

  /** A blank row is worse than no row, and the warm loop must not count titles nobody sees. */
  test("a shelf that came back empty is dropped rather than rendered", () => {
    const shelves = discoveryShelves(depsWith({}, [], [], {}));
    for (const id of ["airing-soon-series", "airing-soon-movies", "coming-soon-movies"]) {
      expect(shelves.map((s) => s.id)).not.toContain(id);
    }
    // With no library mirror there is nothing recently added either.
    expect(shelves.map((s) => s.id)).not.toContain("recently-added");
  });

  /**
   * The two discovery rows are for things you have NOT asked for. The two "yours" rows
   * above them deliberately do not filter -- a film in your Radarr IS in your library, and
   * excluding owned titles there would empty the shelf it is named for.
   */
  test("owned titles leave the TMDB rows and stay on the arr rows", () => {
    const owned = ["up-tmdb-movie", "up-tmdb-series", "up-radarr", "up-sonarr"];
    const ids = discoveryShelves(depsWith({}, owned)).map((s) => s.id);
    expect(ids).not.toContain("coming-soon-movies");
    expect(ids).not.toContain("coming-soon-series");
    expect(ids).toContain("airing-soon-movies");
    expect(ids).toContain("airing-soon-series");
  });

  /** Each row reads its OWN source, so a Sonarr outage cannot fill the films shelf. */
  test("each upcoming shelf is fed by exactly one source", () => {
    const shelves = discoveryShelves(depsWith());
    const rowsOf = (id: string) => shelves.find((s) => s.id === id)?.rows.map((r) => r.tconst);
    expect(rowsOf("airing-soon-series")).toEqual(["up-sonarr"]);
    expect(rowsOf("airing-soon-movies")).toEqual(["up-radarr"]);
    expect(rowsOf("coming-soon-movies")).toEqual(["up-tmdb-movie"]);
    expect(rowsOf("coming-soon-series")).toEqual(["up-tmdb-series"]);
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
