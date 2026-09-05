import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadConfig } from "../lib/config";
import type { RelatedTitle } from "../lib/facets";
import { Store } from "../lib/store";
import { relatedTconsts } from "./related-crosswalk";

/**
 * THE COLLISION THIS FILE EXISTS FOR, and it is a real number rather than a contrived one:
 * TMDB 1399 is *Game of Thrones* in the TV id space and a different title entirely in the
 * movie id space. Both spaces are written into ONE `externalIds` key, so a crosswalk that
 * matches on the bare number can hand a film's "more like this" row a television series.
 */
const COLLIDING_ID = 1399;
const FILM = "tt0111161";
const SERIES = "tt0944947";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(`${tmpdir()}/finderr-test-`);
  process.env.FINDERR_DATA_DIR = dir;
  store = new Store(loadConfig(true));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  process.env.FINDERR_DATA_DIR = undefined;
});

/** One title's `externalIds`, as a provider contributes it: a bare number, no id space. */
function putExternalIds(tconst: string, tmdb: number): void {
  store.putFacetContribution({
    entity_id: tconst,
    facet: "externalIds",
    plugin_id: "test",
    config_version: "1",
    outcome: "ok",
    data: JSON.stringify({ tmdb }),
    freshness: "immutable",
    resolved_at: new Date().toISOString(),
    expires_at: null,
    reason: null,
  });
}

/** One recommendation naming a TMDB id and nothing of ours, as both providers write it. */
function recommendation(tmdbId: number): RelatedTitle {
  return { tconst: null, title: "whatever upstream calls it", reason: "recommended", tmdbId };
}

/** The store, plus an index standing in for `live.current` -- IMDb `titleType` per tconst. */
function crosswalkOver(titleTypes: Record<string, string>) {
  return {
    candidatesFor: (ids: readonly number[]) => store.tconstCandidatesByTmdbId(ids),
    titleTypeOf: (tconst: string): string | null => titleTypes[tconst] ?? null,
  };
}

const BOTH_KINDS = { [FILM]: "movie", [SERIES]: "tvSeries" };

describe("relatedTconsts", () => {
  test("a film's recommendation resolves in the MOVIE id space", () => {
    putExternalIds(FILM, COLLIDING_ID);
    putExternalIds(SERIES, COLLIDING_ID);
    expect(relatedTconsts([recommendation(COLLIDING_ID)], "movie", crosswalkOver(BOTH_KINDS))).toEqual([
      FILM,
    ]);
  });

  test("a series' recommendation resolves in the TV id space", () => {
    putExternalIds(FILM, COLLIDING_ID);
    putExternalIds(SERIES, COLLIDING_ID);
    expect(relatedTconsts([recommendation(COLLIDING_ID)], "series", crosswalkOver(BOTH_KINDS))).toEqual([
      SERIES,
    ]);
  });

  test("an id we hold in the OTHER space only is a dead end, never a wrong link", () => {
    putExternalIds(SERIES, COLLIDING_ID);
    expect(relatedTconsts([recommendation(COLLIDING_ID)], "movie", crosswalkOver(BOTH_KINDS))).toEqual([
      null,
    ]);
  });

  test("a recommendation that already carries our id is never crosswalked", () => {
    putExternalIds(SERIES, COLLIDING_ID);
    const resolved: RelatedTitle = { tconst: FILM, title: "x", reason: null, tmdbId: COLLIDING_ID };
    expect(relatedTconsts([resolved], "series", crosswalkOver(BOTH_KINDS))).toEqual([FILM]);
  });

  test("an id nobody has ever opened yields nothing rather than a guess", () => {
    putExternalIds(FILM, COLLIDING_ID);
    expect(relatedTconsts([recommendation(424242)], "movie", crosswalkOver(BOTH_KINDS))).toEqual([null]);
  });

  test("a candidate our index does not hold is dropped, not counted as a match", () => {
    putExternalIds(FILM, COLLIDING_ID);
    putExternalIds("tt9999999", COLLIDING_ID);
    expect(relatedTconsts([recommendation(COLLIDING_ID)], "movie", crosswalkOver(BOTH_KINDS))).toEqual([
      FILM,
    ]);
  });

  test("two of our titles claiming one id in ONE space is ambiguity, and ambiguity is dropped", () => {
    putExternalIds(SERIES, COLLIDING_ID);
    putExternalIds("tt1234567", COLLIDING_ID);
    const types = { ...BOTH_KINDS, tt1234567: "tvMiniSeries" };
    expect(relatedTconsts([recommendation(COLLIDING_ID)], "series", crosswalkOver(types))).toEqual([null]);
  });

  test("a row with nothing left to crosswalk costs no read at all", () => {
    let asked = 0;
    const counting = {
      candidatesFor: (ids: readonly number[]) => {
        asked++;
        return store.tconstCandidatesByTmdbId(ids);
      },
      titleTypeOf: () => "movie",
    };
    const resolved: RelatedTitle = { tconst: FILM, title: "x", reason: null, tmdbId: COLLIDING_ID };
    expect(relatedTconsts([resolved], "movie", counting)).toEqual([FILM]);
    expect(asked).toBe(0);
  });
});

describe("Store.tconstCandidatesByTmdbId", () => {
  test("keeps EVERY title carrying the id, because the number alone cannot choose", () => {
    putExternalIds(FILM, COLLIDING_ID);
    putExternalIds(SERIES, COLLIDING_ID);
    expect(store.tconstCandidatesByTmdbId([COLLIDING_ID]).get(COLLIDING_ID)?.slice().sort()).toEqual([
      FILM,
      SERIES,
    ]);
  });

  test("asking for nothing reads nothing", () => {
    expect(store.tconstCandidatesByTmdbId([]).size).toBe(0);
  });
});
