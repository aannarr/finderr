/**
 * A collection assembled from the facet cache, read from the other end.
 *
 * The pure rules are asserted against hand-built rows; the last block wires the REAL
 * store query to the REAL index lookup, because the seam between "which titles name this
 * collection?" and "do we hold that title?" is where a change would actually break.
 */

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CollectionPage, collectionPage, collectionsMatchingName } from "./collections";
import { loadConfig } from "./config";
import type { FacetShapes } from "./facets";
import { SCHEMA as INDEX_SCHEMA } from "./index-builder";
import { SearchEngine, type TitleRow } from "./search";
import { type FacetContributionRow, Store } from "./store";

/** A cached `collection` row as the resolver would have written it. */
function row(
  subject: string,
  facet: FacetShapes["collection"],
  overrides: Partial<FacetContributionRow> = {},
): FacetContributionRow {
  return {
    entity_id: subject,
    facet: "collection",
    plugin_id: "servarr-metadata",
    config_version: "1",
    outcome: "ok",
    data: JSON.stringify(facet),
    freshness: "immutable",
    resolved_at: "2026-08-31T00:00:00.000Z",
    expires_at: null,
    reason: null,
    ...overrides,
  };
}

const MATRIX = {
  tt0133093: { tconst: "tt0133093", title: "The Matrix", year: 1999 },
  tt0234215: { tconst: "tt0234215", title: "The Matrix Reloaded", year: 2003 },
  tt0242653: { tconst: "tt0242653", title: "The Matrix Revolutions", year: 2003 },
  tt10838180: { tconst: "tt10838180", title: "The Matrix Resurrections", year: 2021 },
} as const;

/** An index that holds the first three Matrix films and nothing else. */
function heldIndex(held: readonly string[]): (tconst: string) => TitleRow | null {
  return (tconst) => {
    const known = MATRIX[tconst as keyof typeof MATRIX];
    if (!known || !held.includes(tconst)) return null;
    return {
      ...known,
      orig: null,
      kind: "movie",
      votes: 1_000_000,
      rating: 8,
      genres: "Action",
      runtime: 136,
    };
  };
}

/** The row The Matrix's own page caches: self is dropped, the siblings are named. */
const matrixRow = row("tt0133093", {
  id: "tmdb:2344",
  name: "The Matrix Collection",
  parts: [
    { tconst: "tt0234215", title: "The Matrix Reloaded" },
    { tconst: "tt0242653", title: "The Matrix Revolutions" },
    { tconst: "tt10838180", title: "The Matrix Resurrections" },
  ],
});

function pageOf(rows: FacetContributionRow[], held: readonly string[]): CollectionPage {
  const page = collectionPage(rows, heldIndex(held));
  if (!page) throw new Error("expected a collection page");
  return page;
}

describe("collectionPage", () => {
  /**
   * The property the whole reverse read turns on.
   *
   * A cached row lists the OTHER members -- `collectionWithParts` drops self so the title
   * page's pane can say "other movies in this collection". So the subject of the row has
   * to be added back, or every collection page would be missing exactly the film you
   * arrived from.
   */
  test("one cached film yields the whole collection, itself included", () => {
    const page = pageOf([matrixRow], Object.keys(MATRIX));
    expect(page.collection).toEqual({ id: "tmdb:2344", name: "The Matrix Collection" });
    expect(page.titles.map((t) => t.tconst)).toEqual(["tt0133093", "tt0234215", "tt0242653", "tt10838180"]);
    expect(page.missing).toBe(0);
  });

  test("release order, whichever order the rows arrived in", () => {
    const reloaded = row("tt0234215", {
      id: "tmdb:2344",
      name: "The Matrix Collection",
      parts: [{ tconst: "tt0133093", title: "The Matrix" }],
    });
    const page = pageOf([reloaded, matrixRow], Object.keys(MATRIX));
    expect(page.titles.map((t) => t.year)).toEqual([1999, 2003, 2003, 2021]);
  });

  test("a member we do not index is counted, never drawn as a stub", () => {
    const page = pageOf([matrixRow], ["tt0133093", "tt0234215", "tt0242653"]);
    expect(page.titles.map((t) => t.tconst)).toEqual(["tt0133093", "tt0234215", "tt0242653"]);
    expect(page.missing).toBe(1);
  });

  test("a part with no IMDb id is missing, because nothing could ever look it up", () => {
    const withUnlinkable = row("tt0133093", {
      id: "tmdb:2344",
      name: "The Matrix Collection",
      parts: [{ tconst: null, title: "The Matrix Recalibrated" }],
    });
    const page = pageOf([withUnlinkable], ["tt0133093"]);
    expect(page.titles.map((t) => t.tconst)).toEqual(["tt0133093"]);
    expect(page.missing).toBe(1);
  });

  /**
   * The same film can arrive twice: named with an id by one row, and with no id at all by
   * another. Counting both would report a gap that is on screen.
   */
  test("an unlinkable part already rendered by id is not double-counted", () => {
    const idless = row("tt0234215", {
      id: "tmdb:2344",
      name: "The Matrix Collection",
      parts: [{ tconst: null, title: "The Matrix" }],
    });
    const page = pageOf([idless, matrixRow], Object.keys(MATRIX));
    expect(page.missing).toBe(0);
  });

  test("an id nothing names has no page", () => {
    expect(collectionPage([], heldIndex([]))).toBeNull();
  });

  test("a row whose payload is not JSON is skipped rather than fatal", () => {
    const broken = row("tt0234215", { id: "x", name: "x", parts: [] }, { data: "{not json" });
    const page = pageOf([broken, matrixRow], Object.keys(MATRIX));
    expect(page.titles).toHaveLength(4);
  });

  /**
   * Rows are written per film and never rewritten together, so an upstream rename leaves
   * the old and new names side by side. Newest wins, deterministically.
   */
  test("the most recently resolved row names the collection", () => {
    const renamed = row(
      "tt0234215",
      { id: "tmdb:2344", name: "The Matrix Anthology", parts: [] },
      { resolved_at: "2026-09-01T00:00:00.000Z" },
    );
    expect(pageOf([matrixRow, renamed], ["tt0133093"]).collection.name).toBe("The Matrix Anthology");
  });
});

describe("collectionsMatchingName", () => {
  const lotr = row("tt0120737", {
    id: "tmdb:119",
    name: "The Lord of the Rings Collection",
    parts: [],
  });
  const rows = [matrixRow, lotr];

  test("nobody types the word Collection, so a substring finds the franchise", () => {
    expect(collectionsMatchingName(rows, "LORD OF THE RINGS")).toEqual([
      { id: "tmdb:119", name: "The Lord of the Rings Collection" },
    ]);
  });

  test("an exact fold beats a substring", () => {
    const matrixReloadedCollection = row("tt0234215", {
      id: "tmdb:9999",
      name: "The Matrix Collection Extras",
      parts: [],
    });
    const matches = collectionsMatchingName([...rows, matrixReloadedCollection], "the matrix collection");
    expect(matches.map((m) => m.id)).toEqual(["tmdb:2344", "tmdb:9999"]);
  });

  test("a name nothing carries matches nothing, rather than guessing", () => {
    expect(collectionsMatchingName(rows, "star wars")).toEqual([]);
  });

  test("an empty query is not a match-everything", () => {
    expect(collectionsMatchingName(rows, "   ")).toEqual([]);
  });
});

/**
 * The two halves the handler bolts together: a JSON-filtered read of the app DB and a
 * lookup in the index. They are separate SQLite files, so nothing but a test that opens
 * both proves the id written by the provider is the id the query finds.
 */
describe("the store query and the index lookup, wired together", () => {
  const dir = mkdtempSync(join(tmpdir(), "finderr-collections-"));
  const previousDataDir = process.env.FINDERR_DATA_DIR;
  process.env.FINDERR_DATA_DIR = dir;

  const store = new Store(loadConfig(true));

  // The real index schema with two of the four Matrix films in it.
  const indexPath = join(dir, "titles.db");
  const index = new Database(indexPath, { create: true });
  index.run(INDEX_SCHEMA);
  const insert = index.query(
    "insert into title (tconst, kind, title, year, votes, rating, genres) values (?, 'movie', ?, ?, 5000, 8, 'Action')",
  );
  insert.run("tt0133093", "The Matrix", 1999);
  insert.run("tt0234215", "The Matrix Reloaded", 2003);
  index.close();
  const engine = new SearchEngine(indexPath, loadConfig(true));

  afterAll(() => {
    engine.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
    process.env.FINDERR_DATA_DIR = previousDataDir;
  });

  test("a cached contribution becomes a page of the films we hold", () => {
    store.putFacetContribution(matrixRow);

    const page = collectionPage(store.facetContributionsByContentId("collection", "tmdb:2344"), (t) =>
      engine.byTconst(t),
    );

    expect(page?.collection.name).toBe("The Matrix Collection");
    expect(page?.titles.map((t) => t.title)).toEqual(["The Matrix", "The Matrix Reloaded"]);
    // Revolutions and Resurrections are named by the facet and absent from this index.
    expect(page?.missing).toBe(2);
  });

  test("an id no contribution names has no page at all", () => {
    expect(
      collectionPage(store.facetContributionsByContentId("collection", "tmdb:0"), (t) => engine.byTconst(t)),
    ).toBeNull();
  });

  test("the name lookup finds it without knowing the id", () => {
    expect(collectionsMatchingName(store.facetContributionsByContentId("collection"), "matrix")).toEqual([
      { id: "tmdb:2344", name: "The Matrix Collection" },
    ]);
  });
});
