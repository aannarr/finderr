import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadPlaces,
  type PlaceSourceRow,
  parseCsvRecord,
  parsePlaceId,
  parsePlacesCsv,
  parseTitlePlacesCsv,
  placeById,
  placeMapUrl,
  placesForTitle,
  type TitlePlaceSourceRow,
} from "./filming-locations";
import { INDEXES, SCHEMA } from "./index-builder";

const dir = mkdtempSync(join(tmpdir(), "finderr-places-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A real-shaped index: the production `SCHEMA` and `INDEXES.places`, with a handful of titles. */
function indexWith(titles: { tconst: string; votes: number }[]): Database {
  const db = new Database(join(dir, `${crypto.randomUUID()}.db`), { create: true });
  db.run(SCHEMA);
  const ins = db.prepare("insert into title (tconst, kind, title, votes) values (?, 'movie', ?, ?)");
  // ONE transaction. Measured 2026-09-14: 40,000 autocommit inserts take 21 s on the M1 Max,
  // which is what first made the scale case below look like a quadratic loader.
  db.transaction(() => {
    for (const t of titles) ins.run(t.tconst, t.tconst, t.votes);
  })();
  return db;
}

const site = (id: number, label: string, extra: Partial<PlaceSourceRow> = {}): PlaceSourceRow => ({
  id,
  label,
  lat: 1,
  lon: 2,
  country: "ES",
  kind: "site",
  studio: false,
  ...extra,
});

const E = "http://www.wikidata.org/entity/";

describe("parseCsvRecord", () => {
  test("a quoted field keeps its commas and un-doubles its quotes", () => {
    expect(parseCsvRecord(`${E}Q1,"Festetics Palace, Dég","POINT(1 2)",HU`)).toEqual([
      `${E}Q1`,
      "Festetics Palace, Dég",
      "POINT(1 2)",
      "HU",
    ]);
    expect(parseCsvRecord(`a,"the ""Tube""",c`)).toEqual(["a", 'the "Tube"', "c"]);
  });

  test("an unbalanced quote is refused rather than repaired", () => {
    expect(parseCsvRecord(`a,"never closed,c`)).toBeNull();
  });

  test("empty fields survive as empty strings, so column positions hold", () => {
    expect(parseCsvRecord("a,,,d")).toEqual(["a", "", "", "d"]);
  });
});

describe("parsePlacesCsv", () => {
  const header = "place,label,coord,country,studio,area,nation";

  test("classifies on the flags, and a nation beats an area", () => {
    const rows = parsePlacesCsv(
      [
        header,
        `${E}Q10400,Almería,POINT(-2.463889 36.841667),ES,false,true,false`,
        `${E}Q30,United States,POINT(-98.5 39.8),US,false,true,true`,
        `${E}Q192017,Monument Valley,POINT(-110.1 36.98),US,false,false,false`,
        `${E}Q1,Pinewood Studios,POINT(-0.53 51.54),GB,true,false,false`,
      ].join("\n"),
    );
    expect(rows.map((r) => [r.id, r.kind, r.studio])).toEqual([
      [10400, "area", false],
      [30, "country", false],
      [192017, "site", false],
      [1, "site", true],
    ]);
  });

  test("WKT is lon-first, and the parser swaps it into lat/lon", () => {
    const [row] = parsePlacesCsv(
      `${header}\n${E}Q10400,Almería,POINT(-2.463889 36.841667),ES,false,true,false`,
    );
    expect(row?.lat).toBeCloseTo(36.841667);
    expect(row?.lon).toBeCloseTo(-2.463889);
  });

  test("drops a blank node, a row with no label, and a malformed row", () => {
    const rows = parsePlacesCsv(
      [
        header,
        "http://www.wikidata.org/.well-known/genid/01128e84,,,,false,false,false",
        `${E}Q5,,POINT(1 2),ES,false,false,false`,
        `${E}Q6,Only three,columns`,
        `${E}Q7,Kept,,,false,false,false`,
      ].join("\n"),
    );
    expect(rows.map((r) => r.id)).toEqual([7]);
  });

  test("an off-globe coordinate or a bad country code becomes null, not a wrong pin", () => {
    const [row] = parsePlacesCsv(`${header}\n${E}Q8,Crater,POINT(400 95),mars,false,false,false`);
    expect([row?.lat, row?.lon, row?.country]).toEqual([null, null, null]);
  });
});

describe("parseTitlePlacesCsv", () => {
  test("keeps tt ids against entity IRIs and nothing else", () => {
    const rows = parseTitlePlacesCsv(
      [
        "imdb,place",
        `tt0060196,${E}Q10400`,
        `nm0000001,${E}Q10400`,
        "tt0060196,http://www.wikidata.org/.well-known/genid/abc",
        `tt0060196,${E}Q10400,extra`,
      ].join("\n"),
    );
    expect(rows).toEqual([{ imdb: "tt0060196", place: 10400 }]);
  });
});

describe("parsePlaceId", () => {
  test("accepts a Q id in either case", () => {
    expect(parsePlaceId("Q10400")).toBe(10400);
    expect(parsePlaceId("q10400")).toBe(10400);
  });

  test("refuses everything that is not exactly a Q id", () => {
    for (const bad of [
      "",
      "Q",
      "Q0",
      "Q012",
      "10400",
      "Q10400 ",
      "Q1e5",
      "Q1234567890123",
      "P915",
      10400,
      null,
    ]) {
      expect(parsePlaceId(bad)).toBeNull();
    }
  });
});

describe("loadPlaces", () => {
  const titles = [
    { tconst: "tt1", votes: 900 },
    { tconst: "tt2", votes: 50_000 },
    { tconst: "tt3", votes: 10 },
  ];

  test("keeps only places one of our titles reaches, counts them, and never keeps a country", () => {
    const db = indexWith(titles);
    const places = [
      site(100, "Almería", { kind: "area" }),
      site(200, "Monument Valley"),
      site(300, "United States", { kind: "country" }),
      site(400, "Nowhere we hold"),
    ];
    const pairs: TitlePlaceSourceRow[] = [
      { imdb: "tt1", place: 100 },
      { imdb: "tt2", place: 100 },
      { imdb: "tt2", place: 100 }, // the same pair twice is one pair
      { imdb: "tt2", place: 200 },
      { imdb: "tt2", place: 300 },
      { imdb: "tt9", place: 400 }, // a title this index does not hold
    ];
    expect(loadPlaces(db, places, pairs)).toEqual({ places: 2, pairs: 3 });
    expect(placeById(db, 100)?.titles).toBe(2);
    expect(placeById(db, 200)?.titles).toBe(1);
    expect(placeById(db, 300)).toBeNull();
    expect(placeById(db, 400)).toBeNull();
  });

  test("denormalises votes, so the place page's order needs no join to find its rows", () => {
    const db = indexWith(titles);
    loadPlaces(
      db,
      [site(100, "Almería")],
      [
        { imdb: "tt1", place: 100 },
        { imdb: "tt2", place: 100 },
        { imdb: "tt3", place: 100 },
      ],
    );
    for (const sql of INDEXES.places) db.run(sql);
    const order = db
      .query("select votes from title_place where place_id = 100 order by votes desc, title_rowid")
      .all() as { votes: number }[];
    expect(order.map((r) => r.votes)).toEqual([50_000, 900, 10]);
  });

  /*
    THE LOADER MUST STAY A SEEK, and a seven-row test cannot see it go quadratic. `loadOrigin`
    shipped a correlated scan that ran seventeen minutes on the real index while every small
    test passed. Measured on the M1 Max 2026-09-14: `loadPlaces` itself is 54 ms at this size,
    and its plan is SCAN tp_in | SEARCH title USING sqlite_autoindex_title_1 | SEARCH place_in
    USING INTEGER PRIMARY KEY. The 5 s bound is two orders of headroom, not a target.
  */
  test("scales: 40,000 titles and 40,000 pairs load without a quadratic join", () => {
    const n = 40_000;
    const db = indexWith(Array.from({ length: n }, (_, i) => ({ tconst: `tt${i}`, votes: i })));
    const places = Array.from({ length: 5_000 }, (_, i) => site(i + 1, `P${i}`));
    const pairs = Array.from({ length: n }, (_, i) => ({ imdb: `tt${i}`, place: (i % 5_000) + 1 }));
    const t0 = performance.now();
    const res = loadPlaces(db, places, pairs);
    const ms = performance.now() - t0;
    expect(res).toEqual({ places: 5_000, pairs: n });
    expect(ms).toBeLessThan(5_000);
  });
});

describe("placesForTitle", () => {
  /*
    LINKABLE FIRST, then sites before areas. The critique of 2026-09-14 caught the fold at 8
    keeping one-title plain-text sites and hiding every place with a page behind "N more".
  */
  test("places with a page come first, sites before areas within each, most-filmed then label", () => {
    const db = indexWith([
      { tconst: "tt1", votes: 1 },
      { tconst: "tt2", votes: 1 },
    ]);
    loadPlaces(
      db,
      [
        site(1, "Almería", { kind: "area" }),
        site(2, "Tabernas Desert"),
        site(3, "Fort Bravo"),
        site(4, "Zebra Rock"),
      ],
      [
        { imdb: "tt1", place: 1 },
        { imdb: "tt1", place: 2 },
        { imdb: "tt1", place: 3 },
        { imdb: "tt1", place: 4 },
        { imdb: "tt2", place: 4 },
        { imdb: "tt2", place: 1 },
      ],
    );
    for (const sql of INDEXES.places) db.run(sql);
    expect(placesForTitle(db, "tt1").map((p) => p.label)).toEqual([
      "Zebra Rock",
      "Almería",
      "Fort Bravo",
      "Tabernas Desert",
    ]);
    expect(placesForTitle(db, "tt1")[0]).toMatchObject({ id: "Q4", kind: "site", titles: 2 });
  });

  test("a title filmed nowhere we know is an empty list, and so is one we do not hold", () => {
    const db = indexWith([{ tconst: "tt1", votes: 1 }]);
    expect(placesForTitle(db, "tt1")).toEqual([]);
    expect(placesForTitle(db, "tt404")).toEqual([]);
  });
});

describe("placeMapUrl", () => {
  test("OpenStreetMap, lat before lon, and nothing without a coordinate", () => {
    expect(placeMapUrl({ lat: 36.841667, lon: -2.463889 })).toBe(
      "https://www.openstreetmap.org/?mlat=36.84167&mlon=-2.46389#map=14/36.84167/-2.46389",
    );
    expect(placeMapUrl({ lat: null, lon: 1 })).toBeNull();
  });
});
