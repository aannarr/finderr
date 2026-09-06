/**
 * The award marks, and the property the whole design exists for: a card costs NO read.
 *
 * The zero-read assertion runs against a REAL `Store` behind a counting proxy rather than
 * against a hand-written fake, because the claim is about the store and a fake can only ever
 * prove that the fake was not called. The proxy counts EVERY method on the store, not just
 * `awardWinners`: what has to be true is that a lookup touches the database in no way at all.
 *
 * A Map silently rebuilt inside the getter would pass every visual check and every timing
 * eyeball, which is exactly why the count is asserted rather than the milliseconds.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nomination as nom } from "../test/nomination";
import { AwardMarkIndex, buildAwardMarks } from "./award-marks";
import { AWARDS, type AwardDef, awardById, oscarsDef } from "./award-registry";
import { loadConfig } from "./config";
import { Store } from "./store";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "finderr-marks-"));
  process.env.FINDERR_DATA_DIR = dir;
  store = new Store(loadConfig(true));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  process.env.FINDERR_DATA_DIR = undefined;
});

const PALME: AwardDef = awardById("palme-dor") as AwardDef;

/** Every store method the marks touch, in call order. Empty is the answer a lookup owes. */
function countingStore(calls: string[]): Store {
  return new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(String(prop));
        return value.apply(target, args);
      };
    },
  });
}

describe("buildAwardMarks", () => {
  test("marks the anchor winner and nothing else in the category", () => {
    store.replaceAwards("oscars", [
      nom({ seq: 0, films: ["Oppenheimer"], filmIds: ["tt15398776"], won: true }),
      nom({ seq: 1, films: ["Barbie"], filmIds: ["tt1517268"] }),
    ]);
    const marks = buildAwardMarks(store, [oscarsDef()]);
    expect(marks.get("tt15398776")).toEqual({ award: "oscars", ceremony: 98, year: "2025" });
    expect(marks.get("tt1517268")).toBeUndefined();
  });

  test("a win OUTSIDE the anchor category is not a mark", () => {
    // The chip says "this won the top prize". A Best Sound winner carrying the same chip
    // would make the mark mean "won something", which is most of the index.
    store.replaceAwards("oscars", [
      nom({ seq: 0, category: "SOUND", films: ["Dune"], filmIds: ["tt1160419"], won: true }),
    ]);
    expect(buildAwardMarks(store, [oscarsDef()]).size).toBe(0);
  });

  test("an award with no anchor CATEGORY marks every win it holds", () => {
    // The Palme d'Or is one prize per festival, so `anchorCategory` is null and the stored
    // category is one we invented to have something to group on. Filtering on it would be
    // filtering a set of one.
    store.replaceAwards(PALME.id, [
      nom({
        award: PALME.id,
        ceremony: 2019,
        year: "2019",
        category: PALME.singleCategory?.key ?? "",
        films: ["Parasite"],
        filmIds: ["tt6751668"],
        won: true,
      }),
    ]);
    expect(buildAwardMarks(store, [PALME]).get("tt6751668")).toEqual({
      award: PALME.id,
      ceremony: 2019,
      year: "2019",
    });
  });

  test("a title that won two top prizes keeps the first award in registry order", () => {
    // Parasite, which really did take both. One card draws one chip, so something has to
    // choose, and registry order is the choice a reader can predict.
    store.replaceAwards("oscars", [
      nom({ ceremony: 92, year: "2019", films: ["Parasite"], filmIds: ["tt6751668"], won: true }),
    ]);
    store.replaceAwards(PALME.id, [
      nom({
        award: PALME.id,
        ceremony: 2019,
        year: "2019",
        category: PALME.singleCategory?.key ?? "",
        films: ["Parasite"],
        filmIds: ["tt6751668"],
        won: true,
      }),
    ]);
    expect(AWARDS[0]?.id).toBe("oscars");
    expect(buildAwardMarks(store).get("tt6751668")?.award).toBe("oscars");
  });

  test("a winner whose film we cannot identify contributes nothing", () => {
    // ~1,281 source rows carry no FilmId. The subsystem never matches on a title string,
    // and a mark is not the place to start.
    store.replaceAwards("oscars", [nom({ films: ["Wings"], filmIds: [null], won: true })]);
    expect(buildAwardMarks(store, [oscarsDef()]).size).toBe(0);
  });

  test("an award nobody has imported yields no marks and no error", () => {
    // The first-boot state, and the state of a finderr whose Wikidata import is failing.
    expect(buildAwardMarks(store).size).toBe(0);
  });
});

describe("AwardMarkIndex", () => {
  beforeEach(() => {
    store.replaceAwards("oscars", [
      nom({ seq: 0, films: ["Oppenheimer"], filmIds: ["tt15398776"], won: true }),
      nom({ seq: 1, films: ["Barbie"], filmIds: ["tt1517268"] }),
    ]);
  });

  test("building BOTH lookups costs ONE read per award and none per title", () => {
    const calls: string[] = [];
    new AwardMarkIndex(countingStore(calls), AWARDS);
    expect(calls).toEqual(AWARDS.map(() => "awardWinners"));
  });

  /** THE ACCEPTANCE: a grid of cards issues no additional query, however many cards it has. */
  test("a lookup issues no query at all, whatever the size of the grid", () => {
    const calls: string[] = [];
    const marks = new AwardMarkIndex(countingStore(calls), AWARDS);
    calls.length = 0;

    let marked = 0;
    for (let i = 0; i < 500; i++) {
      if (marks.get(i === 0 ? "tt15398776" : `tt${i}`)) marked++;
    }

    expect(marked).toBe(1);
    expect(calls).toEqual([]);
  });

  test("an unmarked title answers null rather than undefined", () => {
    // `Title.award` is `AwardMark | null` on the wire, and `undefined` would drop the key
    // out of the JSON entirely -- a different answer to the same question.
    expect(new AwardMarkIndex(store).get("tt1517268")).toBeNull();
  });

  /**
   * THE SECOND ACCEPTANCE: a poster strip per award costs no query either.
   *
   * `/lists` draws eight of them at once, on a page whose whole rule is that it makes one
   * request. A `winnersFor` that read the store would have been the same defect the marks
   * were designed against, one page over.
   */
  test("winnersFor issues no query, and answers empty for an award we hold nothing for", () => {
    const calls: string[] = [];
    const marks = new AwardMarkIndex(countingStore(calls), AWARDS);
    calls.length = 0;

    expect(marks.winnersFor("oscars").map((w) => w.tconst)).toEqual(["tt15398776"]);
    expect(marks.winnersFor(PALME.id)).toEqual([]);
    expect(marks.winnersFor("no-such-award")).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("a film that won the same award twice appears ONCE, at its most recent win", () => {
    // Breaking Bad took Outstanding Drama Series in two different years. A strip showing it
    // twice is a bug wearing a duplicate.
    store.replaceAwards("oscars", [
      nom({ ceremony: 90, year: "2017", films: ["Repeat"], filmIds: ["tt-repeat"], won: true }),
      nom({ ceremony: 95, year: "2022", films: ["Repeat"], filmIds: ["tt-repeat"], won: true }),
    ]);
    const wins = new AwardMarkIndex(store, [oscarsDef()]).winnersFor("oscars");

    expect(wins).toHaveLength(1);
    // `awardWinners` orders newest first, so the most recent win is the one kept.
    expect(wins[0]).toEqual({
      tconst: "tt-repeat",
      title: "Repeat",
      award: "oscars",
      ceremony: 95,
      year: "2022",
    });
  });

  test("the same film under two awards is on BOTH strips, unlike the marks", () => {
    // Parasite took Best Picture and the Palme d'Or. One CARD draws one chip, so the marks
    // have to choose -- but the Palme d'Or's own list is exactly where a reader expects to
    // see it, so the strips deliberately do not.
    const parasite = { films: ["Parasite"], filmIds: ["tt6751668"], won: true };
    store.replaceAwards("oscars", [nom({ ceremony: 92, year: "2019", ...parasite })]);
    store.replaceAwards(PALME.id, [
      nom({
        award: PALME.id,
        ceremony: 2019,
        year: "2019",
        category: PALME.singleCategory?.key ?? "",
        ...parasite,
      }),
    ]);
    const marks = new AwardMarkIndex(store, [oscarsDef(), PALME]);

    expect(marks.get("tt6751668")?.award).toBe("oscars");
    expect(marks.winnersFor("oscars").map((w) => w.tconst)).toEqual(["tt6751668"]);
    expect(marks.winnersFor(PALME.id).map((w) => w.tconst)).toEqual(["tt6751668"]);
  });

  test("refresh picks up an import, and nothing else does", () => {
    const marks = new AwardMarkIndex(store, [oscarsDef()]);
    store.replaceAwards("oscars", [
      nom({ ceremony: 99, year: "2026", films: ["Sinners"], filmIds: ["tt31193180"], won: true }),
    ]);

    // Still the set it was built from: the getter reads memory and the swap happened in
    // SQLite. This is the staleness the explicit refresh exists to close.
    expect(marks.get("tt31193180")).toBeNull();
    expect(marks.get("tt15398776")).not.toBeNull();

    expect(marks.refresh()).toBe(1);
    expect(marks.get("tt31193180")?.ceremony).toBe(99);
    expect(marks.get("tt15398776")).toBeNull();
  });
});
