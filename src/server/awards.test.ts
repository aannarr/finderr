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
import type { Nomination } from "../lib/awards";
import { loadConfig } from "../lib/config";
import type { TitleRow } from "../lib/search";
import { Store } from "../lib/store";
import { type AwardsDeps, ceremonyPayload, timelinePayload } from "./awards";

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

function deps(engine: AwardsDeps["engine"]): AwardsDeps {
  return { store, engine, decorate, source: null };
}

function nom(over: Partial<Nomination>): Nomination {
  return {
    award: "oscars",
    ceremony: 98,
    seq: 0,
    year: "2025",
    className: "Production",
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
    expect(p.ceremonies[1]?.bestPictureTitle).toBe("Unindexed");
    expect(p.titles.tt404).toBeUndefined();
  });

  test("the anchor completion counts the LIBRARY, not the index", () => {
    // A winner we do not index can still be in Radarr. Counting against the decorated rows
    // would report it as unowned, which is a different question from the one being asked.
    store.replaceLibrary("radarr", [
      { imdb_id: "tt404", arr_id: 1, has_file: 1, monitored: 1, progress: null },
    ]);
    const p = timelinePayload(deps(indexOf("tt1")));
    expect(p.anchor).toEqual({ category: "BEST PICTURE", owned: 1, total: 2 });
  });

  test("totals are over every ceremony, not the page", () => {
    const p = timelinePayload(deps(indexOf("tt1")));
    expect(p.totals).toEqual({ ceremonies: 2, nominations: 3, wins: 3 });
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

  test("neighbours come from ceremonies that EXIST, never from arithmetic", () => {
    const p = ceremonyPayload(deps(indexOf()), 98);
    // 97 exists and 99 does not, so `next` is null rather than 99.
    expect(p?.prev).toBe(97);
    expect(p?.next).toBeNull();

    const older = ceremonyPayload(deps(indexOf()), 97);
    expect(older?.prev).toBeNull();
    expect(older?.next).toBe(98);
  });

  test("names the Best Picture winner for the header", () => {
    const p = ceremonyPayload(deps(indexOf("tt1")), 98);
    expect(p?.bestPicture).toEqual({ title: "Winner", tconst: "tt1" });
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
