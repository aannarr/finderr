/**
 * The award tables, against a real SQLite file.
 *
 * Separate from `awards.test.ts` because that file tests the PARSE and the assembly with
 * no database at all. This one exists for the things only storage can get wrong: the
 * parallel id lists surviving a round trip, the swap actually swapping, and the ownership
 * count joining the library mirror rather than counting nominations.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AwardDef, awardById, OSCARS, oscarsDef } from "./award-registry";
import { ceremonyTimeline, type Nomination, personAwards, titleAwards } from "./awards";
import { loadConfig } from "./config";
import { Store } from "./store";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "finderr-awards-"));
  process.env.FINDERR_DATA_DIR = dir;
  store = new Store(loadConfig(true));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  process.env.FINDERR_DATA_DIR = undefined;
});

function nom(over: Partial<Nomination>): Nomination {
  return {
    award: "oscars",
    ceremony: 98,
    seq: 0,
    year: "2025",
    className: "Title",
    category: "BEST PICTURE",
    rawCategory: "BEST PICTURE",
    films: [],
    filmIds: [],
    nominees: [],
    nconsts: [],
    won: false,
    detail: null,
    note: null,
    ...over,
  };
}

describe("replaceAwards", () => {
  test("a parallel id list survives the round trip with its holes in place", () => {
    // The studio has no person id and the person does. Storing the ids as a joined string
    // and dropping the empty entry would slide `nm2` onto the studio's name on the way
    // back out -- a wrong link that looks entirely plausible.
    store.replaceAwards("oscars", [
      nom({
        nominees: ["Metro-Goldwyn-Mayer", "Douglas Shearer"],
        nconsts: [null, "nm2"],
        films: ["A", "B"],
        filmIds: [null, "tt2"],
      }),
    ]);
    const back = store.awardCeremonyRows("oscars", 98)[0];
    expect(back?.nominees).toEqual(["Metro-Goldwyn-Mayer", "Douglas Shearer"]);
    expect(back?.nconsts).toEqual([null, "nm2"]);
    expect(back?.films).toEqual(["A", "B"]);
    expect(back?.filmIds).toEqual([null, "tt2"]);
  });

  test("an empty id list round-trips as empty rather than as one null", () => {
    store.replaceAwards("oscars", [nom({ films: [], filmIds: [], nominees: [], nconsts: [] })]);
    const back = store.awardCeremonyRows("oscars", 98)[0];
    expect(back?.films).toEqual([]);
    expect(back?.filmIds).toEqual([]);
    expect(back?.nominees).toEqual([]);
  });

  test("the swap REMOVES rows upstream no longer has", () => {
    // oscar_data corrects old ceremonies as well as adding new ones, so an upsert would
    // leave a withdrawn nomination on the page forever.
    store.replaceAwards("oscars", [nom({ seq: 0, films: ["Gone"] }), nom({ seq: 1, films: ["Kept"] })]);
    store.replaceAwards("oscars", [nom({ seq: 0, films: ["Kept"] })]);
    const rows = store.awardCeremonyRows("oscars", 98);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.films).toEqual(["Kept"]);
  });

  test("the swap clears the edge tables too, so no orphan link survives", () => {
    store.replaceAwards("oscars", [
      nom({ filmIds: ["tt1"], films: ["A"], nconsts: ["nm1"], nominees: ["N"] }),
    ]);
    store.replaceAwards("oscars", [nom({ filmIds: ["tt2"], films: ["B"] })]);
    expect(store.awardRowsForTitle("oscars", "tt1")).toHaveLength(0);
    expect(store.awardRowsForPerson("oscars", "nm1")).toHaveLength(0);
    expect(store.awardRowsForTitle("oscars", "tt2")).toHaveLength(1);
  });

  test("one nomination naming a film twice writes one edge, not a refusal", () => {
    store.replaceAwards("oscars", [nom({ films: ["A", "A"], filmIds: ["tt1", "tt1"] })]);
    expect(store.awardRowsForTitle("oscars", "tt1")).toHaveLength(1);
  });

  test("a nomination naming three films is reachable from each of them", () => {
    store.replaceAwards("oscars", [
      nom({ films: ["A", "B", "C"], filmIds: ["tt1", "tt2", "tt3"], won: true }),
    ]);
    for (const t of ["tt1", "tt2", "tt3"]) {
      expect(store.awardRowsForTitle("oscars", t)).toHaveLength(1);
    }
  });

  test("re-importing the same rows is idempotent", () => {
    const rows = [nom({ seq: 0, filmIds: ["tt1"], films: ["A"], nconsts: ["nm1"], nominees: ["N"] })];
    store.replaceAwards("oscars", rows);
    store.replaceAwards("oscars", rows);
    expect(store.awardCount("oscars")).toBe(1);
    expect(store.awardRowsForTitle("oscars", "tt1")).toHaveLength(1);
  });
});

describe("counts against the library mirror", () => {
  test("filmsOwned counts distinct films we hold, not nominations", () => {
    store.replaceAwards("oscars", [
      nom({ seq: 0, category: "BEST PICTURE", films: ["Owned"], filmIds: ["tt1"], won: true }),
      // Same film, second category. A count over nominations would say we own two.
      nom({ seq: 1, category: "DIRECTING", className: "Directing", films: ["Owned"], filmIds: ["tt1"] }),
      nom({ seq: 2, category: "ACTOR IN A LEADING ROLE", films: ["Missing"], filmIds: ["tt2"] }),
    ]);
    store.replaceLibrary("radarr", [
      { imdb_id: "tt1", arr_id: 1, has_file: 1, monitored: 1, progress: null },
    ]);

    const [c] = store.awardCeremonyCounts("oscars");
    expect(c?.films).toBe(2);
    expect(c?.filmsOwned).toBe(1);
    expect(c?.nominations).toBe(3);
    expect(c?.wins).toBe(1);
    expect(c?.categories).toBe(3);
  });

  test("a ceremony with no wins yet reports zero rather than null", () => {
    // SQLite's sum() over an all-zero group is fine, but the shape matters for a ceremony
    // whose winners have not been announced -- which is a real state every January.
    store.replaceAwards("oscars", [nom({ won: false })]);
    expect(store.awardCeremonyCounts("oscars")[0]?.wins).toBe(0);
  });

  test("ownedCount survives more ids than a single statement may bind", () => {
    const ids = Array.from({ length: 1200 }, (_, i) => `tt${i}`);
    store.replaceLibrary(
      "radarr",
      ids
        .slice(0, 700)
        .map((id, i) => ({ imdb_id: id, arr_id: i, has_file: 1, monitored: 1, progress: null })),
    );
    expect(store.ownedCount(ids)).toBe(700);
  });

  test("ownedCount of nothing is zero and costs no query", () => {
    expect(store.ownedCount([])).toBe(0);
  });
});

describe("the timeline over a real store", () => {
  test("assembles ceremonies newest first with their anchor", () => {
    store.replaceAwards("oscars", [
      nom({ ceremony: 98, seq: 0, films: ["Anora"], filmIds: ["tt1"], won: true }),
      nom({
        ceremony: 98,
        seq: 1,
        category: "DIRECTING",
        className: "Directing",
        films: ["Anora"],
        filmIds: ["tt1"],
        won: true,
      }),
      nom({ ceremony: 97, seq: 0, year: "2024", films: ["Older"], filmIds: ["tt2"], won: true }),
    ]);
    const t = ceremonyTimeline(store, oscarsDef());
    expect(t.map((c) => c.ceremony)).toEqual([98, 97]);
    expect(t[0]).toMatchObject({
      anchorTconst: "tt1",
      anchorTitle: "Anora",
      anchorNominations: 2,
      anchorWins: 2,
      anchorAlsoWon: ["DIRECTING"],
    });
  });

  /**
   * The case that made `awardWinners` take a nullable category rather than a string.
   *
   * A winner-only award writes one row per edition under its own single category, so there
   * is nothing to filter by -- and the anchor has to come out of the store WITHOUT the query
   * naming a category, or a second award means a second hardcoded string.
   */
  test("an award with no anchor category anchors on the edition's own winner", () => {
    const palme = awardById("palme-dor") as AwardDef;
    store.replaceAwards(palme.id, [
      nom({
        award: palme.id,
        ceremony: 1994,
        year: "1994",
        className: "",
        category: "PALME D'OR",
        rawCategory: "PALME D'OR",
        films: ["Pulp Fiction"],
        filmIds: ["tt0110912"],
        won: true,
      }),
    ]);

    const t = ceremonyTimeline(store, palme);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({
      ceremony: 1994,
      anchorTconst: "tt0110912",
      anchorTitle: "Pulp Fiction",
      anchorNominations: 1,
      anchorWins: 1,
      // Nothing else to list: the one win IS the headline, so repeating it would be the same
      // fact twice on one row.
      anchorAlsoWon: [],
    });
    // And the awards do not see each other's rows, which is what the `award` column is for.
    expect(ceremonyTimeline(store, oscarsDef())).toEqual([]);
  });

  test("titleAwards and personAwards read the same rows from both directions", () => {
    store.replaceAwards("oscars", [
      nom({ films: ["Anora"], filmIds: ["tt1"], nominees: ["Sean Baker"], nconsts: ["nm1"], won: true }),
    ]);
    expect(titleAwards(store, "tt1", OSCARS)).toMatchObject({ nominations: 1, wins: 1 });
    expect(personAwards(store, "nm1", OSCARS)).toMatchObject({ nominations: 1, wins: 1 });
    expect(titleAwards(store, "tt404", OSCARS)).toBeNull();
  });
});

/**
 * Reading the SAME rows down the nconst column instead of across it.
 *
 * Only a real database can get these wrong: the name is recovered from the stored parallel
 * strings by position, and the aggregate leans on SQLite's `max()` bare-column rule to pick
 * WHICH row's strings to read. Both are properties of the query rather than of any policy,
 * which is why they are tested here and the board policy is tested with no database at all.
 */
describe("the people tallies", () => {
  test("counts a person's nominations and wins across ceremonies", () => {
    store.replaceAwards("oscars", [
      nom({ ceremony: 97, seq: 0, nominees: ["Nina"], nconsts: ["nm1"], won: true }),
      nom({ ceremony: 98, seq: 0, nominees: ["Nina"], nconsts: ["nm1"] }),
      nom({ ceremony: 98, seq: 1, nominees: ["Otto"], nconsts: ["nm2"] }),
    ]);
    expect(store.awardPersonTallies("oscars", null)).toEqual([
      { nconst: "nm1", name: "Nina", nominations: 2, wins: 1 },
      { nconst: "nm2", name: "Otto", nominations: 1, wins: 0 },
    ]);
  });

  /**
   * The card's first rule: a studio is not a person. The import already dropped `co...` ids
   * to null, so the edge table never held one -- this is the assertion that a leaderboard
   * built on it cannot rank Metro-Goldwyn-Mayer alongside an actor.
   */
  test("a company named in the same column is not a person on the board", () => {
    store.replaceAwards("oscars", [
      nom({ nominees: ["Metro-Goldwyn-Mayer", "Douglas Shearer"], nconsts: [null, "nm2"], won: true }),
    ]);
    expect(store.awardPersonTallies("oscars", null)).toEqual([
      { nconst: "nm2", name: "Douglas Shearer", nominations: 1, wins: 1 },
    ]);
  });

  /**
   * The name is read at the ID's own position, never by taking the first one.
   *
   * A row naming three people is the ordinary case, and a query that took `nominees` whole --
   * or its head -- would print the wrong human beside a correct count.
   */
  test("the name comes from the id's position in the row, not from the head of the list", () => {
    store.replaceAwards("oscars", [
      nom({ nominees: ["First", "Second", "Third"], nconsts: ["nm1", "nm2", "nm3"] }),
    ]);
    const byId = new Map(store.awardPersonTallies("oscars", null).map((t) => [t.nconst, t.name]));
    expect(byId.get("nm3")).toBe("Third");
  });

  /**
   * LATEST rather than earliest, and it is a decision rather than an accident: a person's
   * name can genuinely change, and printing the first one the source ever carried would
   * deadname anybody who has transitioned.
   */
  test("the printed name is the one from their most recent nomination", () => {
    store.replaceAwards("oscars", [
      nom({ ceremony: 60, seq: 0, nominees: ["Old Name"], nconsts: ["nm1"] }),
      nom({ ceremony: 95, seq: 0, nominees: ["New Name"], nconsts: ["nm1"] }),
    ]);
    expect(store.awardPersonTallies("oscars", null)[0]?.name).toBe("New Name");
  });

  test("a class narrows the counts to that class's rows alone", () => {
    store.replaceAwards("oscars", [
      nom({ seq: 0, className: "Acting", nominees: ["Both"], nconsts: ["nm1"], won: true }),
      nom({ seq: 1, className: "Directing", nominees: ["Both"], nconsts: ["nm1"] }),
      nom({ seq: 2, className: "Directing", nominees: ["Only"], nconsts: ["nm2"] }),
    ]);
    expect(store.awardPersonTallies("oscars", "Acting")).toEqual([
      { nconst: "nm1", name: "Both", nominations: 1, wins: 1 },
    ]);
    expect(store.awardPersonTallies("oscars", "Directing").map((t) => t.nconst)).toEqual(["nm1", "nm2"]);
  });

  test("the classes on offer are the ones this award names people in, counted by person", () => {
    store.replaceAwards("oscars", [
      nom({ seq: 0, className: "Acting", nominees: ["A", "B"], nconsts: ["nm1", "nm2"] }),
      nom({ seq: 1, className: "Acting", nominees: ["A"], nconsts: ["nm1"] }),
      // Names a film and nobody, so `Title` must not appear as a class with zero people.
      nom({ seq: 2, className: "Title", films: ["Solo"], filmIds: ["tt1"] }),
    ]);
    expect(store.awardPersonClasses("oscars")).toEqual([{ className: "Acting", people: 2 }]);
  });

  test("a winner-only award names no people, which is what stops it offering a board", () => {
    const palme = awardById("palme-dor") as AwardDef;
    store.replaceAwards(palme.id, [
      nom({ award: palme.id, ceremony: 1994, films: ["Pulp Fiction"], filmIds: ["tt1"], won: true }),
    ]);
    expect(store.awardHasPeople(palme.id)).toBe(false);
    expect(store.awardPersonClasses(palme.id)).toEqual([]);
    expect(store.awardPersonTallies(palme.id, null)).toEqual([]);
  });

  test("an award that names one person has people, and does not see another award's", () => {
    const palme = awardById("palme-dor") as AwardDef;
    store.replaceAwards("oscars", [nom({ nominees: ["Nina"], nconsts: ["nm1"] })]);
    store.replaceAwards(palme.id, [
      nom({ award: palme.id, ceremony: 1994, films: ["Pulp Fiction"], filmIds: ["tt1"], won: true }),
    ]);
    expect(store.awardHasPeople("oscars")).toBe(true);
    expect(store.awardHasPeople(palme.id)).toBe(false);
  });
});
