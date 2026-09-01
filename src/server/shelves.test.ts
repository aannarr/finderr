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
  trending: string[] = [],
): ShelfDeps {
  const upcomingIds = new Set([...Object.values(upcoming).flat(), ...trending]);
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
      hasRank: true,
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
      // Empty by default, which is the keyless case: the shelf drops out entirely and
      // every existing assertion about shelf order stays true without naming it.
      trending: (limit: number) =>
        trending.slice(0, limit).map((tconst, position) => ({ tconst, kind: "movie", position })),
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

  test("an index with no rank column drops the Top 250 rather than mislabelling a votes list", () => {
    // A redeploy keeps its data directory, so the live index has no rank column until the
    // next nightly refresh. `engine.browse` degrades a ranked sort to votes, which is right
    // for a generic grid and WRONG under a heading that names a ranked list -- it would put
    // the most popular films on screen as "finderr Top 250".
    const shelves = discoveryShelves(depsWith({ hasRank: false }, [], ["owned-1"]));
    expect(shelves.map((s) => s.id)).not.toContain("top-250");
    // Everything else on the front page is unaffected.
    expect(shelves.map((s) => s.id)).toContain("top-movies");
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
   * What you already have is dropped from a recommendation shelf, and kept on a list.
   *
   * > [!NOTE] This asserts the OUTCOME, and it used to assert the mechanism -- on purpose
   * > It was "the library's keys reach the query as `excludeTconsts`", justified in its own
   * > docstring on the grounds that checking the returned rows "would only prove the fake
   * > engine ignored the option it was handed". That was exactly right while the ENGINE did
   * > the excluding. `assembleShelves` does it now -- moved out of the query so a held shelf
   * > cannot go on offering a film you downloaded an hour ago -- so the rows are produced by
   * > code in this file and asserting on them is no longer vacuous. The old test defended a
   * > mechanism that no longer exists; this one defends the rule that always mattered.
   */
  test("what the library already holds is dropped from the recommendation shelves", () => {
    const shelves = discoveryShelves(
      depsWith(
        {
          // Two candidates, one of them owned, so the filter has something to do and
          // something to leave behind.
          topRated: (opts = {}) => [row("owned-1"), row(`top-${opts.kind}`)],
          topRatedInGenre: () => [row("owned-1"), row("genre-Horror")],
          newThisDecade: () => [row("owned-1"), row("decade")],
        },
        ["owned-1"],
      ),
    );
    const rowsOf = (id: string) => shelves.find((s) => s.id === id)?.rows.map((r) => r.tconst);
    expect(rowsOf("top-movies")).toEqual(["top-movie"]);
    expect(rowsOf("top-series")).toEqual(["top-tvSeries"]);
    expect(rowsOf("new-decade")).toEqual(["decade"]);
    expect(rowsOf("genre-horror")).toEqual(["genre-Horror"]);
  });

  /**
   * The Top 250 and "Popular right now" are LISTS, and a list with the good ones quietly
   * removed is not that list -- it is a list with holes and no way to tell from the
   * numbering. Pinned here because it is an editorial decision that reads like an oversight.
   */
  test("a canonical list keeps what you own", () => {
    const shelves = discoveryShelves(
      depsWith({ browse: () => ({ rows: [row("owned-1")], total: 1 }) }, ["owned-1"], [], UPCOMING, [
        "owned-1",
      ]),
    );
    expect(shelves.find((s) => s.id === "top-250")?.rows.map((r) => r.tconst)).toEqual(["owned-1"]);
    expect(shelves.find((s) => s.id === "trending")?.rows.map((r) => r.tconst)).toEqual(["owned-1"]);
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

  /**
   * The mirror's order IS the ranking, and nothing local reproduces it. Re-sorting these
   * rows by votes would put the same great films on a shelf about this week, which is the
   * exact shelf this one exists instead of.
   */
  test("trending is drawn in the mirror's order, not re-sorted", () => {
    const shelves = discoveryShelves(depsWith({}, [], [], UPCOMING, ["tr-3", "tr-1", "tr-2"]));
    expect(shelves.find((s) => s.id === "trending")?.rows.map((r) => r.tconst)).toEqual([
      "tr-3",
      "tr-1",
      "tr-2",
    ]);
  });

  /**
   * The ordinary state without a TMDB key: the sync never runs, the table stays empty, and
   * the shelf is dropped rather than drawn as a blank row. Same shape `hasRank` gives the
   * Top 250 before a rebuild.
   */
  test("an empty trending mirror drops the shelf rather than drawing an empty row", () => {
    expect(discoveryShelves(depsWith()).find((s) => s.id === "trending")).toBeUndefined();
  });

  /**
   * Unlike every recommendation shelf here. "What is everyone watching" is a fact about
   * the world, and a trending list with the ones you own quietly removed disagrees with
   * every other trending list there is -- the Top 250 shelf keeps its owned titles for the
   * same reason. The grid already marks an owned title.
   */
  test("trending keeps titles you already own", () => {
    const shelves = discoveryShelves(depsWith({}, ["tr-owned"], [], UPCOMING, ["tr-owned", "tr-new"]));
    expect(shelves.find((s) => s.id === "trending")?.rows.map((r) => r.tconst)).toEqual([
      "tr-owned",
      "tr-new",
    ]);
  });

  /** The mirror and the index refresh on different timers, so a swap can retire a row. */
  test("a trending row the index cannot draw is skipped, not rendered blank", () => {
    const shelves = discoveryShelves(
      depsWith({ byTconst: (id) => (id === "tr-gone" ? null : row(id)) }, [], [], UPCOMING, [
        "tr-here",
        "tr-gone",
      ]),
    );
    expect(shelves.find((s) => s.id === "trending")?.rows.map((r) => r.tconst)).toEqual(["tr-here"]);
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
