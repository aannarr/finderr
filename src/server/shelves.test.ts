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
    lang: null,
  };
}

/** One row per source, so a shelf's contents say which source produced them. */
const UPCOMING: Record<string, string[]> = {
  radarr: ["up-radarr"],
  sonarr: ["up-sonarr"],
  "tmdb-movie": ["up-tmdb-movie"],
  "tmdb-series": ["up-tmdb-series"],
};

/** What one test wants to differ from the default world; everything omitted keeps its default. */
interface DepsOptions {
  /** Engine methods overridden for the case under examination. */
  engine?: Partial<ShelfDeps["engine"]>;
  /** Ids in the library mirror, which the recommendation shelves must exclude. */
  owned?: string[];
  /** Ids the library mirror reports as recently acquired, in its own order. */
  added?: string[];
  /** Ids the request log reports as recently asked for, in its own order. */
  requested?: string[];
  /** Ids the upcoming mirror reports, per source. */
  upcoming?: Record<string, string[]>;
  /** Ids the trending mirror reports, in its order. Empty is the keyless case. */
  trending?: string[];
}

/**
 * Every source answers with something identifiable, so a shelf's contents say which query
 * produced them.
 *
 * An OPTIONS OBJECT rather than positionals: there are six sources now, and
 * `depsWith({}, [], ["owned-1"], UPCOMING, ["tr-1"])` said nothing about which list was
 * which. A seventh source is a named key here and no change at any call site.
 *
 * `byTconst` resolves any id a mirror reports and nothing else, which is what makes "the
 * index does not carry this id" testable as well as the happy path.
 */
function depsWith({
  engine: over = {},
  owned = [],
  added = [],
  requested = [],
  upcoming = UPCOMING,
  trending = [],
}: DepsOptions = {}): ShelfDeps {
  const mirrored = new Set([...Object.values(upcoming).flat(), ...trending, ...added, ...requested]);
  return {
    engine: {
      topRated: (opts = {}) => [row(`top-${opts.kind}`, `top ${opts.kind}`, opts.kind ?? "movie")],
      newThisDecade: () => [row("decade")],
      topGenres: () => ["Horror"],
      topRatedInGenre: (genre) => [row(`genre-${genre}`)],
      byTconst: (id) => (mirrored.has(id) ? row(id) : null),
      // The Top 250 shelf. It goes through `browse` rather than a bespoke engine method
      // precisely so the shelf and the "see all" link behind it cannot order differently,
      // which is why the fake answers in the same shape a real browse does.
      browse: (opts) => ({ rows: [row(`ranked-${opts.kind}`, `ranked ${opts.kind}`, opts.kind)], total: 1 }),
      hasRank: true,
      // "Big at home, unknown here". The engine applies every threshold itself and hands
      // back finished rows, so the fake is one row -- there is no shelf-side rule to fake.
      breakoutTitles: () => [row("breakout")],
      ...over,
    } as ShelfDeps["engine"],
    store: {
      libraryMap: () => new Map(owned.map((id) => [id, {}])),
      recentlyAddedIds: () => added,
      recentlyRequestedIds: () => requested,
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
    const ids = discoveryShelves(depsWith({ added: ["owned-1"], requested: ["asked-1"] })).map((s) => s.id);
    expect(ids).toEqual([
      "recently-added",
      "recently-requested",
      "top-250",
      "top-movies",
      "top-series",
      "local-breakouts",
      "airing-soon-series",
      "airing-soon-movies",
      "coming-soon-movies",
      "coming-soon-series",
      "new-decade",
      "genre-horror",
    ]);
  });

  /**
   * "What is new to ME, then what is new to everyone" is the pairing the placement exists
   * for, and an all-time canonical list between the two halves breaks it. The two personal
   * rows are the first half; trending is the second, and the Top 250 comes after both.
   *
   * The order test above runs KEYLESS -- the trending mirror is empty, so the one shelf
   * whose position was an editorial decision is the one it cannot see. That blind spot is
   * how "Popular right now" shipped third under a comment claiming second.
   */
  test("a populated trending shelf sits under the personal rows and above the Top 250", () => {
    const ids = discoveryShelves(
      depsWith({ added: ["owned-1"], requested: ["asked-1"], trending: ["tr-1"] }),
    ).map((s) => s.id);
    expect(ids.slice(0, 4)).toEqual(["recently-added", "recently-requested", "trending", "top-250"]);
  });

  test("an index with no rank column drops the Top 250 rather than mislabelling a votes list", () => {
    // A redeploy keeps its data directory, so the live index has no rank column until the
    // next nightly refresh. `engine.browse` degrades a ranked sort to votes, which is right
    // for a generic grid and WRONG under a heading that names a ranked list -- it would put
    // the most popular films on screen as "finderr Top 250".
    const shelves = discoveryShelves(depsWith({ engine: { hasRank: false }, added: ["owned-1"] }));
    expect(shelves.map((s) => s.id)).not.toContain("top-250");
    // Everything else on the front page is unaffected.
    expect(shelves.map((s) => s.id)).toContain("top-movies");
  });

  /** A blank row is worse than no row, and the warm loop must not count titles nobody sees. */
  test("a shelf that came back empty is dropped rather than rendered", () => {
    const shelves = discoveryShelves(depsWith({ upcoming: {} }));
    for (const id of ["airing-soon-series", "airing-soon-movies", "coming-soon-movies"]) {
      expect(shelves.map((s) => s.id)).not.toContain(id);
    }
    // With no library mirror there is nothing recently added either.
    expect(shelves.map((s) => s.id)).not.toContain("recently-added");
    // Same for an empty request log: nobody has asked for anything yet.
    expect(shelves.map((s) => s.id)).not.toContain("recently-requested");
  });

  /**
   * The two discovery rows are for things you have NOT asked for. The two "yours" rows
   * above them deliberately do not filter -- a film in your Radarr IS in your library, and
   * excluding owned titles there would empty the shelf it is named for.
   */
  test("owned titles leave the TMDB rows and stay on the arr rows", () => {
    const owned = ["up-tmdb-movie", "up-tmdb-series", "up-radarr", "up-sonarr"];
    const ids = discoveryShelves(depsWith({ owned })).map((s) => s.id);
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
      depsWith({
        engine: {
          // Two candidates, one of them owned, so the filter has something to do and
          // something to leave behind.
          topRated: (opts = {}) => [row("owned-1"), row(`top-${opts.kind}`)],
          topRatedInGenre: () => [row("owned-1"), row("genre-Horror")],
          newThisDecade: () => [row("owned-1"), row("decade")],
        },
        owned: ["owned-1"],
      }),
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
      depsWith({
        engine: { browse: () => ({ rows: [row("owned-1")], total: 1 }) },
        owned: ["owned-1"],
        trending: ["owned-1"],
      }),
    );
    expect(shelves.find((s) => s.id === "top-250")?.rows.map((r) => r.tconst)).toEqual(["owned-1"]);
    expect(shelves.find((s) => s.id === "trending")?.rows.map((r) => r.tconst)).toEqual(["owned-1"]);
  });

  test("recently-added is read out of the mirror, in the mirror's order", () => {
    const shelves = discoveryShelves(depsWith({ added: ["tt2", "tt1"] }));
    const recent = shelves.find((s) => s.id === "recently-added");
    expect(recent?.rows.map((r) => r.tconst)).toEqual(["tt2", "tt1"]);
  });

  test("recently-requested is read out of the request log, in the log's order", () => {
    const shelves = discoveryShelves(depsWith({ requested: ["tt9", "tt8"] }));
    const requested = shelves.find((s) => s.id === "recently-requested");
    expect(requested?.rows.map((r) => r.tconst)).toEqual(["tt9", "tt8"]);
  });

  /**
   * A request the reader has since received is still something they asked for, so it stays
   * on this shelf -- the two rows answer different questions and are allowed to overlap.
   */
  test("a requested title that has arrived stays on recently-requested", () => {
    const shelves = discoveryShelves(depsWith({ owned: ["tt7"], added: ["tt7"], requested: ["tt7"] }));
    const requested = shelves.find((s) => s.id === "recently-requested");
    expect(requested?.rows.map((r) => r.tconst)).toEqual(["tt7"]);
  });

  /** The index is rebuilt independently of the request log, so an id can go missing from it. */
  test("a requested id the index cannot resolve is skipped rather than rendered blank", () => {
    const shelves = discoveryShelves(
      depsWith({
        requested: ["tt-dropped", "tt-known"],
        engine: { byTconst: (id) => (id === "tt-known" ? row(id) : null) },
      }),
    );
    const requested = shelves.find((s) => s.id === "recently-requested");
    expect(requested?.rows.map((r) => r.tconst)).toEqual(["tt-known"]);
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
    const shelves = discoveryShelves(depsWith({ trending: ["tr-3", "tr-1", "tr-2"] }));
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
    const shelves = discoveryShelves(depsWith({ owned: ["tr-owned"], trending: ["tr-owned", "tr-new"] }));
    expect(shelves.find((s) => s.id === "trending")?.rows.map((r) => r.tconst)).toEqual([
      "tr-owned",
      "tr-new",
    ]);
  });

  /** The mirror and the index refresh on different timers, so a swap can retire a row. */
  test("a trending row the index cannot draw is skipped, not rendered blank", () => {
    const shelves = discoveryShelves(
      depsWith({
        engine: { byTconst: (id) => (id === "tr-gone" ? null : row(id)) },
        trending: ["tr-here", "tr-gone"],
      }),
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
