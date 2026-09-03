import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  CROSSWALK_MAX_AGE_MS,
  CROSSWALK_SOURCES,
  type CrosswalkRow,
  fetchCrosswalk,
  loadCrosswalk,
  loadPersonCrosswalk,
  nconstsByTmdbPersonId,
  parseCrosswalkCsv,
  parsePersonCrosswalkCsv,
  TITLE_CROSSWALK,
  titleIds,
} from "./crosswalk";
import { EXPLODE_GENRES, SCHEMA } from "./index-builder";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(`${tmpdir()}/finderr-crosswalk-`);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("parseCrosswalkCsv", () => {
  test("reads the four columns, with an absent id as null", () => {
    const rows = parseCrosswalkCsv(
      [
        "imdb,tmdbMovie,tmdbTv,tvdb",
        "tt1375666,27205,,",
        "tt0944947,,1399,121361",
        "tt5039916,,,232501",
      ].join("\n"),
    );
    expect(rows).toEqual([
      { imdb: "tt1375666", tmdbMovie: 27205, tmdbTv: null, tvdb: null },
      { imdb: "tt0944947", tmdbMovie: null, tmdbTv: 1399, tvdb: 121361 },
      { imdb: "tt5039916", tmdbMovie: null, tmdbTv: null, tvdb: 232501 },
    ]);
  });

  /**
   * P345 is the id space for people and companies too, and the query's own filter is the
   * first guard. This is the second: a crosswalk entry keyed on an `nm` would be a row
   * that can never match a title and only costs a page.
   */
  test("anything that is not a tconst is dropped", () => {
    const rows = parseCrosswalkCsv(
      ["imdb,tmdbMovie,tmdbTv,tvdb", "nm0000138,1,,", "co0144901,2,,"].join("\n"),
    );
    expect(rows).toEqual([]);
  });

  /**
   * A crosswalk is only useful if every entry is right. A malformed line is DROPPED rather
   * than repaired -- a half-parsed id sends a provider to somebody else's film, which is a
   * wrong answer wearing a right one's clothes.
   */
  test("a malformed row is dropped rather than half-read", () => {
    const rows = parseCrosswalkCsv(
      ["imdb,tmdbMovie,tmdbTv,tvdb", "tt1,27205", 'tt2,"12,34",,', "tt3,notanumber,,", "tt4,5,,"].join("\n"),
    );
    expect(rows.map((r) => r.imdb)).toEqual(["tt3", "tt4"]);
    // `tt3` survives as a row with no usable id, which `loadCrosswalk` then discards.
    expect(rows[0]).toEqual({ imdb: "tt3", tmdbMovie: null, tmdbTv: null, tvdb: null });
  });

  test("a negative or zero id is not an id", () => {
    const rows = parseCrosswalkCsv(["imdb,tmdbMovie,tmdbTv,tvdb", "tt1,0,,", "tt2,-5,,"].join("\n"));
    expect(rows.every((r) => r.tmdbMovie === null)).toBe(true);
  });
});

describe("loadCrosswalk", () => {
  /** Shaped from the real SCHEMA, so the fixture cannot disagree with the real index. */
  function indexWith(titles: { tconst: string; kind: string }[]): Database {
    const db = new Database(`${dir}/titles.db`, { create: true });
    db.run(SCHEMA);
    const insert = db.prepare("insert into title (tconst, kind, title) values (?,?,?)");
    for (const t of titles) insert.run(t.tconst, t.kind, t.tconst);
    db.run(EXPLODE_GENRES);
    return db;
  }

  const ROWS: CrosswalkRow[] = [
    { imdb: "tt1375666", tmdbMovie: 27205, tmdbTv: null, tvdb: null },
    { imdb: "tt0944947", tmdbMovie: 999, tmdbTv: 1399, tvdb: 121361 },
    { imdb: "tt9999999", tmdbMovie: 5, tmdbTv: null, tvdb: null },
  ];

  /**
   * The single most dangerous thing this file can get wrong. Wikidata keeps a film id and
   * a series id in different properties, and handing a provider the film one for a series
   * asks `/tv/{filmId}` -- which answers with somebody else's show, or a 404 that reads as
   * "TMDB has never heard of this". `tt0944947` carries BOTH in the fixture for exactly
   * this reason.
   */
  test("the title's kind decides which TMDB property applies", () => {
    const db = indexWith([
      { tconst: "tt1375666", kind: "movie" },
      { tconst: "tt0944947", kind: "tvSeries" },
    ]);
    loadCrosswalk(db, ROWS);

    expect(titleIds(db, "tt1375666")).toEqual({ tmdb: 27205 });
    expect(titleIds(db, "tt0944947")).toEqual({ tmdb: 1399, tvdb: 121361 });
    db.close();
  });

  test("a tvMovie takes the film id, like every other film", () => {
    const db = indexWith([{ tconst: "tt1375666", kind: "tvMovie" }]);
    loadCrosswalk(db, ROWS);
    expect(titleIds(db, "tt1375666")).toEqual({ tmdb: 27205 });
    db.close();
  });

  test("only titles this index holds are kept", () => {
    const db = indexWith([{ tconst: "tt1375666", kind: "movie" }]);
    // The source covers every IMDb id Wikidata knows, most of which this product never
    // renders -- ten title types we do not index, plus people.
    expect(loadCrosswalk(db, ROWS)).toBe(1);
    expect(titleIds(db, "tt9999999")).toEqual({});
    db.close();
  });

  test("a row with neither id is not stored -- it answers no question", () => {
    const db = indexWith([{ tconst: "tt1", kind: "movie" }]);
    expect(loadCrosswalk(db, [{ imdb: "tt1", tmdbMovie: null, tmdbTv: null, tvdb: null }])).toBe(0);
    expect(titleIds(db, "tt1")).toEqual({});
    db.close();
  });

  /** A series with only a TVDB id is a real and common shape: skyhook still gains a call. */
  test("one id without the other is stored, not discarded", () => {
    const db = indexWith([{ tconst: "tt1", kind: "tvSeries" }]);
    loadCrosswalk(db, [{ imdb: "tt1", tmdbMovie: null, tmdbTv: null, tvdb: 42 }]);
    expect(titleIds(db, "tt1")).toEqual({ tvdb: 42 });
    db.close();
  });
});

describe("fetchCrosswalk", () => {
  const path = () => `${dir}/${TITLE_CROSSWALK.file}`;
  const ok = (body: string) => async () => new Response(body);

  test("downloads and writes when there is nothing on disk", async () => {
    expect(
      await fetchCrosswalk(TITLE_CROSSWALK, dir, {
        fetchImpl: ok("imdb,a,b,c\n") as unknown as typeof fetch,
      }),
    ).toBe(true);
    expect(await Bun.file(path()).text()).toBe("imdb,a,b,c\n");
  });

  test("a recent file is reused and nothing is asked for", async () => {
    writeFileSync(path(), "cached");
    let called = false;
    const spy = (async () => {
      called = true;
      return new Response("fresh");
    }) as unknown as typeof fetch;

    expect(await fetchCrosswalk(TITLE_CROSSWALK, dir, { fetchImpl: spy })).toBe(true);
    expect(called).toBe(false);
    expect(await Bun.file(path()).text()).toBe("cached");
  });

  test("past the age window it is fetched again", async () => {
    writeFileSync(path(), "stale");
    const old = new Date(Date.now() - CROSSWALK_MAX_AGE_MS - 60_000);
    utimesSync(path(), old, old);

    await fetchCrosswalk(TITLE_CROSSWALK, dir, { fetchImpl: ok("fresh") as unknown as typeof fetch });
    expect(await Bun.file(path()).text()).toBe("fresh");
  });

  /**
   * The stale copy is the failure fallback, and it is a fine one: an id does not move, so
   * the only cost is that a title Wikidata gained this week pays a `/find` call.
   */
  test("a failed download leaves the copy on disk alone and still reports usable", async () => {
    writeFileSync(path(), "cached");
    const old = new Date(Date.now() - CROSSWALK_MAX_AGE_MS - 60_000);
    utimesSync(path(), old, old);
    const dead = (async () => new Response("boom", { status: 503 })) as unknown as typeof fetch;

    expect(await fetchCrosswalk(TITLE_CROSSWALK, dir, { fetchImpl: dead })).toBe(true);
    expect(await Bun.file(path()).text()).toBe("cached");
  });

  test("a failed download with nothing cached reports false rather than throwing", async () => {
    const dead = (async () => {
      throw new Error("dns");
    }) as unknown as typeof fetch;
    expect(await fetchCrosswalk(TITLE_CROSSWALK, dir, { fetchImpl: dead })).toBe(false);
  });

  /**
   * Two sources, two files, one downloader. The failure this pins is a source whose
   * `file` was copied from its sibling and never changed: both crosswalks would land on one
   * path, the second overwriting the first, and the index would carry the wrong table for
   * one of them with nothing to say so.
   */
  test("each source writes to its own file", async () => {
    for (const source of CROSSWALK_SOURCES) {
      await fetchCrosswalk(source, dir, { fetchImpl: ok(source.label) as unknown as typeof fetch });
    }
    for (const source of CROSSWALK_SOURCES) {
      expect(await Bun.file(`${dir}/${source.file}`).text()).toBe(source.label);
    }
    expect(new Set(CROSSWALK_SOURCES.map((s) => s.file)).size).toBe(CROSSWALK_SOURCES.length);
  });
});

describe("parsePersonCrosswalkCsv", () => {
  test("reads the two columns", () => {
    const rows = parsePersonCrosswalkCsv(["imdb,tmdb", "nm0000138,6193", "nm0001664,525"].join("\n"));
    expect(rows).toEqual([
      { nconst: "nm0000138", tmdb: 6193 },
      { nconst: "nm0001664", tmdb: 525 },
    ]);
  });

  /** P345 is shared with titles and companies, exactly as it is on the title side. */
  test("anything that is not an nconst is dropped", () => {
    const rows = parsePersonCrosswalkCsv(["imdb,tmdb", "tt1375666,27205", "co0144901,7"].join("\n"));
    expect(rows).toEqual([]);
  });

  /** A pair is only useful whole: half of one cannot link anybody. */
  test("a row with no usable id is dropped rather than half-read", () => {
    const rows = parsePersonCrosswalkCsv(
      ["imdb,tmdb", "nm1,notanumber", "nm2,", "nm3,0", "nm4,-5", "nm5,7"].join("\n"),
    );
    expect(rows).toEqual([{ nconst: "nm5", tmdb: 7 }]);
  });
});

describe("loadPersonCrosswalk", () => {
  /** Shaped from the real SCHEMA, so the fixture cannot disagree with the real index. */
  function indexWith(people: string[]): Database {
    const db = new Database(`${dir}/titles.db`, { create: true });
    db.run(SCHEMA);
    const insert = db.prepare("insert into person (nconst, name) values (?,?)");
    for (const nconst of people) insert.run(nconst, nconst);
    return db;
  }

  test("a clean pair for somebody we hold is stored", () => {
    const db = indexWith(["nm0000138"]);
    expect(loadPersonCrosswalk(db, [{ nconst: "nm0000138", tmdb: 6193 }])).toBe(1);
    expect(nconstsByTmdbPersonId(db, [6193])).toEqual(new Map([[6193, "nm0000138"]]));
    db.close();
  });

  /**
   * The dead-end rule. The crosswalk resolves this nconst perfectly and there is still no
   * filmography behind it, so a link would be a link to an empty page -- 31.3% of unlinked
   * cast are exactly this, and plain text is the right answer for all of them.
   */
  test("somebody absent from our index is not stored", () => {
    const db = indexWith(["nm0000138"]);
    expect(loadPersonCrosswalk(db, [{ nconst: "nm9999999", tmdb: 42 }])).toBe(0);
    expect(nconstsByTmdbPersonId(db, [42]).size).toBe(0);
    db.close();
  });

  /**
   * THE WHOLE POINT OF THE CARD, on the id axis. Wikidata's merge artefacts leave one TMDB
   * id pointing at two nconsts; there is no way to choose and a coin toss sends one reader
   * in sixty to a stranger's filmography. Both sides go.
   */
  test("a TMDB id claiming two people resolves to nobody", () => {
    const db = indexWith(["nm1", "nm2"]);
    expect(
      loadPersonCrosswalk(db, [
        { nconst: "nm1", tmdb: 7 },
        { nconst: "nm2", tmdb: 7 },
      ]),
    ).toBe(0);
    expect(nconstsByTmdbPersonId(db, [7]).size).toBe(0);
    db.close();
  });

  /** The same artefact seen from the other end, and it poisons the pair just as hard. */
  test("one person claiming two TMDB ids resolves to nobody", () => {
    const db = indexWith(["nm1"]);
    expect(
      loadPersonCrosswalk(db, [
        { nconst: "nm1", tmdb: 7 },
        { nconst: "nm1", tmdb: 8 },
      ]),
    ).toBe(0);
    db.close();
  });

  /**
   * Ambiguity is judged over the WHOLE source and only then restricted to people we hold.
   * The other way round, a collision whose second half is merely below our vote floor would
   * look unambiguous -- and the surviving half is a coin toss, not an answer.
   */
  test("a collision with somebody outside our index still poisons the pair", () => {
    const db = indexWith(["nm1"]);
    expect(
      loadPersonCrosswalk(db, [
        { nconst: "nm1", tmdb: 7 },
        { nconst: "nm9999999", tmdb: 7 },
      ]),
    ).toBe(0);
    db.close();
  });

  /** The same pair twice is a duplicate row, not a disagreement -- see `select distinct`. */
  test("an exactly repeated pair is not treated as ambiguity", () => {
    const db = indexWith(["nm1"]);
    expect(
      loadPersonCrosswalk(db, [
        { nconst: "nm1", tmdb: 7 },
        { nconst: "nm1", tmdb: 7 },
      ]),
    ).toBe(1);
    expect(nconstsByTmdbPersonId(db, [7])).toEqual(new Map([[7, "nm1"]]));
    db.close();
  });

  test("ids nobody answers to are simply absent from the batch", () => {
    const db = indexWith(["nm1"]);
    loadPersonCrosswalk(db, [{ nconst: "nm1", tmdb: 7 }]);
    expect(nconstsByTmdbPersonId(db, [7, 8, 9])).toEqual(new Map([[7, "nm1"]]));
    expect(nconstsByTmdbPersonId(db, []).size).toBe(0);
    db.close();
  });
});
