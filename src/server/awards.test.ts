/**
 * The two award payloads, assembled over a real store and a fake index.
 *
 * The index is faked rather than built, because what these functions decide is not "what
 * does the corpus contain" but "what happens when it does NOT contain something" -- a
 * nomination whose film we do not index has to travel with an id and no row, so the client
 * prints text instead of a link. A fake lookup is the only cheap way to hold that case
 * still.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AwardDef, awardById, oscarsDef } from "../lib/award-registry";
import type { Nomination } from "../lib/awards";
import { loadConfig } from "../lib/config";
import type { TitleRow } from "../lib/search";
import { Store } from "../lib/store";
import { type AwardsDeps, ceremonyPayload, peoplePayload, timelinePayload } from "./awards";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "finderr-awards-srv-"));
  process.env.FINDERR_DATA_DIR = dir;
  store = new Store(loadConfig(true));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  process.env.FINDERR_DATA_DIR = undefined;
});

function row(tconst: string, title: string): TitleRow {
  return {
    tconst,
    title,
    orig: null,
    year: 2024,
    kind: "movie",
    votes: 1000,
    rating: 7.5,
    genres: "Drama",
    runtime: 120,
  } as TitleRow;
}

/** An index holding exactly the ids given, and nothing else. */
function indexOf(...ids: string[]): AwardsDeps["engine"] {
  const held = new Set(ids);
  return { byTconst: (t) => (held.has(t) ? row(t, `Title ${t}`) : null) };
}

const decorate = ((rows: TitleRow[]) =>
  rows.map((r) => ({ ...r, inLibrary: false }))) as AwardsDeps["decorate"];

function deps(engine: AwardsDeps["engine"], def: AwardDef = oscarsDef()): AwardsDeps {
  return { store, engine, decorate, def, source: null };
}

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

describe("timelinePayload", () => {
  beforeEach(() => {
    store.replaceAwards("oscars", [
      nom({ ceremony: 98, seq: 0, films: ["Held"], filmIds: ["tt1"], won: true }),
      nom({
        ceremony: 98,
        seq: 1,
        category: "DIRECTING",
        className: "Directing",
        films: ["Held"],
        filmIds: ["tt1"],
        won: true,
      }),
      nom({ ceremony: 97, seq: 0, year: "2024", films: ["Unindexed"], filmIds: ["tt404"], won: true }),
    ]);
  });

  test("sends a row only for an anchor we index", () => {
    const p = timelinePayload(deps(indexOf("tt1")));
    expect(Object.keys(p.titles)).toEqual(["tt1"]);
    // The ceremony is still there, still carrying its title as text. A film we do not
    // index must not delete a year from the timeline.
    expect(p.ceremonies.map((c) => c.ceremony)).toEqual([98, 97]);
    expect(p.ceremonies[1]?.anchorTitle).toBe("Unindexed");
    expect(p.titles.tt404).toBeUndefined();
  });

  test("the anchor completion counts the LIBRARY, not the index", () => {
    // A winner we do not index can still be in Radarr. Counting against the decorated rows
    // would report it as unowned, which is a different question from the one being asked.
    store.replaceLibrary("radarr", [
      { imdb_id: "tt404", arr_id: 1, has_file: 1, monitored: 1, progress: null },
    ]);
    const p = timelinePayload(deps(indexOf("tt1")));
    expect(p.anchor).toEqual({ noun: "Best Picture winners", owned: 1, total: 2 });
  });

  test("totals are over every ceremony, not the page", () => {
    const p = timelinePayload(deps(indexOf("tt1")));
    expect(p.totals).toEqual({ ceremonies: 2, nominations: 3, wins: 3 });
    // These fixtures name films and nobody, which is exactly the state that must stop the
    // timeline offering a link to an empty leaderboard.
    expect(p.hasPeople).toBe(false);
  });

  test("an empty store is an empty timeline rather than a throw", () => {
    store.replaceAwards("oscars", []);
    const p = timelinePayload(deps(indexOf()));
    expect(p.ceremonies).toEqual([]);
    expect(p.anchor.total).toBe(0);
  });
});

describe("ceremonyPayload", () => {
  beforeEach(() => {
    store.replaceAwards("oscars", [
      nom({
        seq: 0,
        category: "BEST PICTURE",
        films: ["Winner"],
        filmIds: ["tt1"],
        nominees: ["A Producer"],
        nconsts: ["nm1"],
        won: true,
      }),
      nom({ seq: 1, category: "BEST PICTURE", films: ["Loser"], filmIds: ["tt2"] }),
      nom({
        seq: 2,
        category: "ACTOR IN A LEADING ROLE",
        className: "Acting",
        films: ["Winner"],
        filmIds: ["tt1"],
        nominees: ["An Actor"],
        nconsts: ["nm2"],
        won: true,
        detail: "Some Character",
      }),
      nom({
        seq: 3,
        category: "SOUND",
        className: "Special",
        films: ["Winner"],
        filmIds: ["tt1"],
        // A studio and a person in one row: the company id was already dropped at import.
        nominees: ["A Studio", "A Person"],
        nconsts: [null, "nm3"],
      }),
      nom({ ceremony: 97, seq: 0, year: "2024", films: ["Older"], filmIds: ["tt3"], won: true }),
    ]);
  });

  test("unknown ceremony is null, so the handler can 404", () => {
    expect(ceremonyPayload(deps(indexOf()), 42)).toBeNull();
  });

  test("groups on the canonical category with the winner first", () => {
    const p = ceremonyPayload(deps(indexOf("tt1", "tt2")), 98);
    const bp = p?.groups.find((g) => g.category === "BEST PICTURE");
    expect(bp?.nominations.map((n) => n.films[0]?.title)).toEqual(["Winner", "Loser"]);
    expect(bp?.nominations[0]?.won).toBe(true);
  });

  test("Best Picture leads the page", () => {
    const p = ceremonyPayload(deps(indexOf("tt1")), 98);
    expect(p?.groups[0]?.category).toBe("BEST PICTURE");
  });

  test("resolves each film ONCE however many categories name it", () => {
    let calls = 0;
    const counting: AwardsDeps["engine"] = {
      byTconst: (t) => {
        calls++;
        return t === "tt1" ? row(t, "Winner") : null;
      },
    };
    ceremonyPayload(deps(counting), 98);
    // Three nominations name tt1 and one names tt2. Four lookups would mean the Set is
    // not doing its job; two is one per distinct film.
    expect(calls).toBe(2);
  });

  test("a studio keeps its name and gains no link", () => {
    const p = ceremonyPayload(deps(indexOf("tt1")), 98);
    const sound = p?.groups.find((g) => g.category === "SOUND");
    expect(sound?.nominations[0]?.nominees).toEqual([
      { name: "A Studio", nconst: null },
      { name: "A Person", nconst: "nm3" },
    ]);
  });

  test("carries the source's own qualifier through to the view", () => {
    const p = ceremonyPayload(deps(indexOf("tt1")), 98);
    const acting = p?.groups.find((g) => g.category === "ACTOR IN A LEADING ROLE");
    expect(acting?.nominations[0]?.detail).toBe("Some Character");
  });

  /*
    `className` reaches the browser, and this is the assertion that keeps the ceremony page
    honest rather than merely typed.

    The page decides person-first vs film-first from this field. If it silently stopped
    being sent, `isPersonLed(undefined)` is false, EVERY acting category quietly flips to
    film-first, and nothing throws -- the page still renders, just wrong. That is precisely
    the failure the original bug was: a layout decision made from the wrong input, invisible
    unless somebody reads a category block closely.
  */
  test("sends the source's class, which is what decides a category's shape", () => {
    const p = ceremonyPayload(deps(indexOf("tt1")), 98);
    const acting = p?.groups.find((g) => g.category === "ACTOR IN A LEADING ROLE");
    const bp = p?.groups.find((g) => g.category === "BEST PICTURE");
    expect(acting?.nominations[0]?.className).toBe("Acting");
    // `Title`, not `Production` -- the source files an award to a whole WORK under Title
    // and reserves Production for the crafts. The fixture below carries the real value.
    expect(bp?.nominations[0]?.className).toBe("Title");
  });

  test("every row in one category carries the SAME class", () => {
    // The invariant the fix rests on. Best Picture's ten rows must agree, or the page is
    // back to reading two ways down one block -- which is the bug, restated as data.
    const p = ceremonyPayload(deps(indexOf("tt1", "tt2")), 98);
    for (const g of p?.groups ?? []) {
      expect(new Set(g.nominations.map((n) => n.className)).size).toBe(1);
    }
  });

  test("neighbours come from ceremonies that EXIST, never from arithmetic", () => {
    const p = ceremonyPayload(deps(indexOf()), 98);
    // 97 exists and 99 does not, so `next` is null rather than 99.
    expect(p?.prev).toBe(97);
    expect(p?.next).toBeNull();

    const older = ceremonyPayload(deps(indexOf()), 97);
    expect(older?.prev).toBeNull();
    expect(older?.next).toBe(98);
  });

  test("names the anchor winner for the header", () => {
    const p = ceremonyPayload(deps(indexOf("tt1")), 98);
    expect(p?.anchorFilm).toEqual({ title: "Winner", tconst: "tt1" });
  });

  /**
   * The anchor for an award that has no anchor CATEGORY -- the case the Oscars alone could
   * never exercise.
   *
   * `ceremonyPayload` used to find the header's winner by looking for the group called
   * `BEST PICTURE`. For a winner-only award there is no such group and never will be, so it
   * takes the first group's win instead, which for one prize per edition is the only win.
   */
  test("an award with no anchor category still names its edition's winner", () => {
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
        filmIds: ["tt9"],
        won: true,
      }),
    ]);
    const p = ceremonyPayload(deps(indexOf("tt9"), palme), 1994);
    expect(p?.anchorFilm).toEqual({ title: "Pulp Fiction", tconst: "tt9" });
    expect(p?.award.anchorLabel).toBe("Palme d'Or");
    expect(p?.award.editionKey).toBe("year");
  });

  test("counts films and ownership, distinct", () => {
    store.replaceLibrary("radarr", [
      { imdb_id: "tt1", arr_id: 1, has_file: 1, monitored: 1, progress: null },
    ]);
    const p = ceremonyPayload(deps(indexOf("tt1", "tt2")), 98);
    expect(p?.films).toBe(2);
    expect(p?.filmsOwned).toBe(1);
    expect(p?.nominations).toBe(4);
  });
});

/**
 * The payload behind `/api/awards/:award/people`.
 *
 * The engine is deliberately EMPTY in every case here, because a board names people and no
 * films: a payload that reached the index at all would be doing something this page has no
 * use for, and an empty lookup is the cheapest way to hold that still.
 */
describe("peoplePayload", () => {
  beforeEach(() => {
    store.replaceAwards("oscars", [
      nom({
        seq: 0,
        className: "Acting",
        category: "ACTOR IN A LEADING ROLE",
        nominees: ["Winner Person"],
        nconsts: ["nm1"],
        won: true,
      }),
      nom({ seq: 1, className: "Acting", nominees: ["Winner Person"], nconsts: ["nm1"] }),
      nom({ seq: 2, className: "Directing", nominees: ["Never Person"], nconsts: ["nm2"] }),
      // A studio, which the import already stripped of its company id.
      nom({ seq: 3, className: "Production", nominees: ["A Studio"], nconsts: [null] }),
    ]);
  });

  test("three boards over the whole award, and the classes to narrow them by", () => {
    const p = peoplePayload(deps(indexOf()), null);
    expect(p?.className).toBeNull();
    expect(p?.boards.map((b) => b.id)).toEqual(["most-nominated", "never-won", "most-wins"]);
    expect(p?.boards[0]?.entries.map((e) => e.name)).toEqual(["Winner Person", "Never Person"]);
    // `Production` is absent: its only nomination names a studio, and a studio is not a
    // person, so a chip for it would lead to an empty board.
    expect(p?.classes).toEqual([
      { className: "Directing", people: 1 },
      { className: "Acting", people: 1 },
    ]);
  });

  test("a class narrows every board and is echoed back", () => {
    const p = peoplePayload(deps(indexOf()), "Directing");
    expect(p?.className).toBe("Directing");
    expect(p?.boards.map((b) => b.id)).toEqual(["most-nominated", "never-won"]);
    expect(p?.boards[0]?.entries.map((e) => e.name)).toEqual(["Never Person"]);
  });

  /**
   * "We do not group people that way" and "nobody in that group" are different answers, and
   * only the first is a URL nobody should be able to bookmark.
   */
  test("a class this award does not use is null, which the handler answers with a 404", () => {
    expect(peoplePayload(deps(indexOf()), "Choreography")).toBeNull();
  });

  test("no index lookup happens at all, because no board names a film", () => {
    let calls = 0;
    peoplePayload(
      deps({
        byTconst: () => {
          calls++;
          return null;
        },
      }),
      null,
    );
    expect(calls).toBe(0);
  });

  test("an award with no people is a payload with no boards rather than a throw", () => {
    const palme = awardById("palme-dor") as AwardDef;
    store.replaceAwards(palme.id, [
      nom({ award: palme.id, ceremony: 1994, films: ["Pulp Fiction"], filmIds: ["tt9"], won: true }),
    ]);
    const p = peoplePayload(deps(indexOf(), palme), null);
    expect(p?.boards).toEqual([]);
    expect(p?.classes).toEqual([]);
  });
});
