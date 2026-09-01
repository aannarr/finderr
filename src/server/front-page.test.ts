/**
 * The held front page.
 *
 * ## The invariant everything else rests on
 *
 * `FINDERR_KEEP_SHELVES_FRESH` is a PERFORMANCE switch. It must change WHEN rows are
 * computed and never WHICH rows come back -- because the moment those two can disagree, the
 * flag stops being a switch you can flip during an incident and becomes a second definition
 * of the front page. `shelves.ts` exists to stop there being a second definition.
 *
 * So the central test here is a differential one: build the page both ways from identical
 * inputs and compare row for row.
 *
 * ## And the invariant that is deliberately NOT true
 *
 * A held tier is allowed to be STALE with respect to its own source -- that is the entire
 * point, and it is bounded by the timer that owns it. What is not allowed is staleness in
 * `owned`, which changes every 60 seconds and would otherwise leave a genre shelf offering a
 * film you downloaded an hour ago until the next daily index swap. That is the one thing
 * `FrontPage` holds candidates for rather than finished rows, and it has its own test below.
 */

import { describe, expect, test } from "bun:test";
import type { TitleRow } from "../lib/search";
import { FrontPage } from "./front-page";
import { discoveryShelves, type ShelfDeps } from "./shelves";

function row(tconst: string, kind = "movie"): TitleRow {
  return {
    tconst,
    title: tconst,
    orig: null,
    year: 2024,
    kind,
    votes: 1000,
    rating: 8,
    genres: "Drama",
    runtime: 100,
  };
}

/**
 * A world whose every source can be changed after the fact, so a test can move ONE tier and
 * watch which shelves follow.
 */
function world() {
  const state = {
    owned: [] as string[],
    added: ["added-1"],
    genres: ["Horror"],
    topRated: ["top-1", "top-2"],
    upcoming: {
      radarr: ["up-radarr"],
      sonarr: ["up-sonarr"],
      "tmdb-movie": ["up-tmdb-movie"],
      "tmdb-series": ["up-tmdb-series"],
    } as Record<string, string[]>,
    trending: ["trend-1"],
    /** Bumped by every engine call, so "did this tier re-run?" is answerable. */
    engineCalls: 0,
  };

  const deps: ShelfDeps = {
    engine: {
      topRated: (opts = {}) => {
        state.engineCalls++;
        return state.topRated.map((t) => row(t, opts.kind ?? "movie"));
      },
      newThisDecade: () => {
        state.engineCalls++;
        return [row("decade-1")];
      },
      topGenres: () => {
        state.engineCalls++;
        return state.genres;
      },
      topRatedInGenre: (genre) => {
        state.engineCalls++;
        return [row(`genre-${genre}`)];
      },
      byTconst: (id) => row(id),
      browse: (opts) => {
        state.engineCalls++;
        return { rows: [row(`ranked-${opts.kind}`, opts.kind)], total: 1 };
      },
      hasRank: true,
    } as ShelfDeps["engine"],
    store: {
      libraryMap: () => new Map(state.owned.map((id) => [id, {}])),
      recentlyAddedIds: () => state.added,
      upcomingBySource: (source: string) =>
        (state.upcoming[source] ?? []).map((tconst) => ({
          tconst,
          kind: "movie",
          source,
          date: "2026-09-01",
          date_kind: "cinemas",
          detail: null,
        })),
      trending: (limit: number) =>
        state.trending.slice(0, limit).map((tconst, position) => ({ tconst, kind: "movie", position })),
    } as unknown as ShelfDeps["store"],
    now: () => Date.parse("2026-06-15T00:00:00Z"),
  };

  return { state, deps };
}

/** A fully primed holder over `deps`. */
function primed(deps: ShelfDeps): FrontPage {
  const page = new FrontPage(() => deps);
  page.refresh("index");
  page.refresh("tmdb");
  page.refresh("arr");
  return page;
}

const ownedSet = (deps: ShelfDeps) => new Set(deps.store.libraryMap().keys());

describe("held and computed are the same page", () => {
  test("row for row, with nothing owned", () => {
    const { deps } = world();
    expect(primed(deps).current(ownedSet(deps))).toEqual(discoveryShelves(deps));
  });

  test("row for row, with part of the library owned", () => {
    const { state, deps } = world();
    state.owned = ["top-1", "up-tmdb-movie"];
    expect(primed(deps).current(ownedSet(deps))).toEqual(discoveryShelves(deps));
  });

  test("row for row, when a shelf's source is empty and the shelf drops out", () => {
    const { state, deps } = world();
    state.trending = [];
    state.upcoming = { radarr: [], sonarr: [], "tmdb-movie": [], "tmdb-series": [] };
    const held = primed(deps).current(ownedSet(deps));
    expect(held).toEqual(discoveryShelves(deps));
    expect(held?.map((s) => s.id)).not.toContain("trending");
  });
});

describe("a tier is rebuilt by its own writer and nobody else's", () => {
  test("refreshing the arr tier re-runs no index query", () => {
    const { state, deps } = world();
    const page = primed(deps);
    const before = state.engineCalls;
    page.refresh("arr");
    // `byTconst` is not counted -- it is the mirror lookup the arr shelves are made of.
    // What must not happen is topGenres / topRatedInGenre / topRated running again.
    expect(state.engineCalls).toBe(before);
  });

  test("the arr tier picks up a new library addition; the index shelves do not move", () => {
    const { state, deps } = world();
    const page = primed(deps);
    const genreBefore = page.current(ownedSet(deps))?.find((s) => s.id === "genre-horror");

    state.added = ["added-2", "added-1"];
    state.topRated = ["something-completely-different"];
    page.refresh("arr");

    const after = page.current(ownedSet(deps));
    expect(after?.find((s) => s.id === "recently-added")?.rows.map((r) => r.tconst)).toEqual([
      "added-2",
      "added-1",
    ]);
    // The index tier was NOT refreshed, so it must still be serving what it built.
    expect(after?.find((s) => s.id === "top-movies")?.rows.map((r) => r.tconst)).toEqual(["top-1", "top-2"]);
    expect(after?.find((s) => s.id === "genre-horror")).toEqual(genreBefore);
  });

  test("the index tier picks up a new genre list only when it is refreshed", () => {
    const { state, deps } = world();
    const page = primed(deps);
    state.genres = ["Comedy"];

    page.refresh("arr");
    expect(page.current(ownedSet(deps))?.map((s) => s.id)).toContain("genre-horror");

    page.refresh("index");
    const ids = page.current(ownedSet(deps))?.map((s) => s.id);
    expect(ids).toContain("genre-comedy");
    expect(ids).not.toContain("genre-horror");
  });
});

describe("what is held is candidates, so ownership is never stale", () => {
  /*
    The whole reason `assembleShelves` applies `owned` instead of the query doing it. Without
    this the index tier's shelves would go on recommending a title for up to a day after it
    landed in the library.
  */
  test("a title downloaded after the tier was built disappears on the very next read", () => {
    const { state, deps } = world();
    const page = primed(deps);
    expect(page.current(ownedSet(deps))?.find((s) => s.id === "top-movies")?.rows).toHaveLength(2);

    state.owned = ["top-1"];
    // NO refresh of any kind -- this is the point.
    const rows = page.current(ownedSet(deps))?.find((s) => s.id === "top-movies")?.rows;
    expect(rows?.map((r) => r.tconst)).toEqual(["top-2"]);
  });
});

describe("a partial page is never served", () => {
  test("current() is null until every tier has built once", () => {
    const { deps } = world();
    const page = new FrontPage(() => deps);
    expect(page.ready).toBe(false);
    expect(page.current(new Set())).toBeNull();

    page.refresh("index");
    page.refresh("tmdb");
    expect(page.ready).toBe(false);
    expect(page.current(new Set())).toBeNull();

    page.refresh("arr");
    expect(page.ready).toBe(true);
    expect(page.current(new Set())).not.toBeNull();
  });

  test("a non-index tier arriving first still builds, rather than no-opping forever", () => {
    // The specs (and the genre list on them) ride with the index tier, so a holder whose
    // first call is `arr` has no specs yet. It must derive them rather than skip its work.
    const { deps } = world();
    const page = new FrontPage(() => deps);
    page.refresh("arr");
    page.refresh("index");
    page.refresh("tmdb");
    expect(page.current(ownedSet(deps))).toEqual(discoveryShelves(deps));
  });

  test("status reports each tier's own build time", () => {
    const { deps } = world();
    const page = new FrontPage(() => deps);
    page.refresh("arr");
    const s = page.status(true);
    expect(s.enabled).toBe(true);
    expect(s.ready).toBe(false);
    expect(s.tiers.arr).not.toBeNull();
    expect(s.tiers.index).toBeNull();
    expect(s.tiers.tmdb).toBeNull();
    expect(s.rows).toBeGreaterThan(0);
  });
});
