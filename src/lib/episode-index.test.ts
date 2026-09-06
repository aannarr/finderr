/**
 * The episode stage, exercised through the REAL builder against real gzipped dumps.
 *
 * Written against `buildIndex` rather than against the stage function directly, for the
 * reason `cast-build.test.ts` gives about its own stage: everything this one can get wrong
 * lives in the seams. The stage runs BEFORE `title.basics` is streamed and the name and year
 * are filled DURING that stream, the parent floor is applied against the ratings map while
 * the orphan prune is applied against the finished `title` table, and the header guard runs
 * inside `streamTsv`. A unit test of the filtering alone would pass while any of those was
 * broken.
 *
 * The fixtures are tiny but they are genuinely gzipped TSVs with genuine headers, so a
 * column reorder upstream fails here the same way it would in production.
 */

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DumpRows, dumpDir, indexConfig } from "../test/index-dumps";
import type { Config } from "./config";
import { buildIndex, SCHEMA } from "./index-builder";
import { currentStages, stagesOf, staleStagesOf } from "./index-stages";
import { EPISODE_PAGE, type EpisodeRow, queryEpisodes, SearchEngine } from "./search";

const root = mkdtempSync(join(tmpdir(), "finderr-episode-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** basics row: tconst, type, primary, original, isAdult, start, end, runtime, genres */
const basics = (tconst: string, kind: string, title: string, year: string, isAdult = "0") => [
  tconst,
  kind,
  title,
  title,
  isAdult,
  year,
  "\\N",
  "45",
  "Drama",
];

/** episode row: tconst, parentTconst, seasonNumber, episodeNumber */
const episode = (tconst: string, parent: string, season: string, number: string) => [
  tconst,
  parent,
  season,
  number,
];

const SERIES = "tt-series";
const OBSCURE_SERIES = "tt-obscure";
const MOVIE = "tt-movie";

/**
 * Two series -- one far above the vote floor, one far below -- and a film.
 *
 * `tt-e102` deliberately has NO ratings row. It is the episode that aired this week, and it
 * is the whole reason the floor sits on the series: an episode-level floor would delete it.
 */
const BASE = {
  ratings: [
    [SERIES, "8.9", "500000"],
    [OBSCURE_SERIES, "9.9", "40"],
    [MOVIE, "8.8", "2000000"],
    ["tt-e101", "9.2", "50000"],
    // tt-e102 is absent on purpose -- brand new, nobody has rated it.
    ["tt-e201", "7.1", "3000"],
    ["tt-e000", "8.5", "100"],
    ["tt-e-unnum", "9.4", "700"],
    ["tt-eo1", "9.9", "5"],
  ],
  basics: [
    basics(SERIES, "tvSeries", "The Good Show", "2011"),
    basics(OBSCURE_SERIES, "tvSeries", "Nobody Watches This", "2012"),
    basics(MOVIE, "movie", "Inception", "2010"),
    basics("tt-e101", "tvEpisode", "Pilot", "2011"),
    basics("tt-e102", "tvEpisode", "Aired Last Tuesday", "2026"),
    basics("tt-e201", "tvEpisode", "Second Season Opener", "2012"),
    basics("tt-e000", "tvEpisode", "Behind The Scenes", "2011"),
    basics("tt-e-unnum", "tvEpisode", "An Unnumbered Thing", "2013"),
    basics("tt-eo1", "tvEpisode", "Obscure Pilot", "2012"),
  ],
  episodes: [
    episode("tt-e101", SERIES, "1", "1"),
    episode("tt-e102", SERIES, "1", "2"),
    episode("tt-e201", SERIES, "2", "1"),
    // Season 0 is the specials, and it is a real season number rather than an absent one.
    episode("tt-e000", SERIES, "0", "1"),
    // IMDb writes \N for an episode it cannot place in a run.
    episode("tt-e-unnum", SERIES, "\\N", "\\N"),
    episode("tt-eo1", OBSCURE_SERIES, "1", "1"),
  ],
};

async function build(
  over: Partial<Config["index"]> = {},
  dumps: Partial<typeof BASE> = {},
): Promise<Database> {
  const dir = dumpDir(root, { ...BASE, ...dumps } as DumpRows);
  const dest = join(root, `${crypto.randomUUID()}.db`);
  await buildIndex(indexConfig(over), dir, dest, () => {});
  return new Database(dest, { readonly: true });
}

const rowsOf = (db: Database, sql: string, ...args: unknown[]) =>
  db.query(sql).all(...(args as never[])) as Record<string, unknown>[];

describe("the floor is on the SERIES, never on the episode", () => {
  test("an episode with no votes at all is kept when its series clears the floor", async () => {
    // The load-bearing case for the whole design. tt-e102 aired last Tuesday and has no
    // ratings row; an episode-level floor deletes exactly this row, on exactly the day
    // somebody wants it.
    const db = await build();
    const kept = rowsOf(db, "select tconst from episode order by tconst").map((r) => r.tconst);
    expect(kept).toContain("tt-e102");
  });

  test("every episode of a series below the floor is dropped, however good the episode", async () => {
    // tt-eo1 is rated 9.9. It is still gone, because nobody has heard of the show.
    const db = await build();
    const kept = rowsOf(db, "select tconst from episode").map((r) => r.tconst);
    expect(kept).not.toContain("tt-eo1");
  });

  test("dropping the floor to 0 picks the obscure series' episodes up", async () => {
    const db = await build({ episodeSeriesMinVotes: 0 });
    const kept = rowsOf(db, "select tconst from episode").map((r) => r.tconst);
    expect(kept).toContain("tt-eo1");
  });
});

describe("an unrated episode is null, never zero", () => {
  test("no ratings row means rating null and votes 0", async () => {
    const db = await build();
    const row = db.query("select rating, votes from episode where tconst = 'tt-e102'").get() as {
      rating: number | null;
      votes: number;
    };
    // 0 would mean "rated terribly", which is a different fact from "not rated yet" -- and
    // it is the one a "best episodes" list would have to sort somewhere.
    expect(row.rating).toBeNull();
    expect(row.votes).toBe(0);
  });

  test("a rated episode carries its own rating, not the series'", async () => {
    const db = await build();
    const row = db.query("select rating, votes from episode where tconst = 'tt-e101'").get() as {
      rating: number;
      votes: number;
    };
    expect(row.rating).toBe(9.2);
    expect(row.votes).toBe(50_000);
  });
});

describe("what an episode row carries", () => {
  test("season, number and parent come from title.episode", async () => {
    const db = await build();
    const row = db.query("select parent, season, number from episode where tconst = 'tt-e201'").get();
    expect(row).toEqual({ parent: SERIES, season: 2, number: 1 });
  });

  test("the name and year come from title.basics, which title.episode does not carry", async () => {
    const db = await build();
    const row = db.query("select title, year from episode where tconst = 'tt-e101'").get();
    expect(row).toEqual({ title: "Pilot", year: 2011 });
  });

  test("season 0 is kept -- it is the specials, not a missing value", async () => {
    const db = await build();
    expect(db.query("select season from episode where tconst = 'tt-e000'").get()).toEqual({ season: 0 });
  });

  test("an episode with no season or number is dropped rather than filed under zero", async () => {
    // Filing it at season 0 would put it among the specials, which is a claim we cannot
    // make, and there is no place for it in the season-ordered list this table exists for.
    const db = await build();
    const kept = rowsOf(db, "select tconst from episode").map((r) => r.tconst);
    expect(kept).not.toContain("tt-e-unnum");
  });
});

describe("episodes are not titles", () => {
  test("no episode reaches the title table, so none can reach search or browse", async () => {
    const db = await build();
    const titles = rowsOf(db, "select tconst from title order by tconst").map((r) => r.tconst);
    expect(titles).toEqual([MOVIE, OBSCURE_SERIES, SERIES]);
  });

  test("a series filtered out by titleTypes takes its episodes with it", async () => {
    // The floor is applied against the ratings map, which knows votes and nothing about
    // type -- so without the orphan prune these rows would survive as episodes of a series
    // that is not in the index and cannot be navigated to.
    const db = await build({ titleTypes: ["movie"] });
    expect((db.query("select count(*) c from episode").get() as { c: number }).c).toBe(0);
  });

  test("an adult series filtered out takes its episodes with it too", async () => {
    const dumps = {
      basics: BASE.basics.map((r) =>
        r[0] === SERIES ? basics(SERIES, "tvSeries", "The Good Show", "2011", "1") : r,
      ),
    };
    const db = await build({}, dumps);
    const parents = rowsOf(db, "select distinct parent from episode").map((r) => r.parent);
    expect(parents).not.toContain(SERIES);
  });
});

describe("the stage is additive and optional", () => {
  test("no title.episode dump means a complete title index with no episodes", async () => {
    const db = await build({}, { episodes: undefined });
    expect((db.query("select count(*) c from title").get() as { c: number }).c).toBe(3);
    expect((db.query("select count(*) c from episode").get() as { c: number }).c).toBe(0);
    // The table still EXISTS -- the stage is what is optional, not the schema. An index
    // this build produced can always be read; only its contents vary.
    expect(
      db.query("select 1 from sqlite_master where type='table' and name='episode'").get(),
    ).not.toBeNull();
  });

  test("a reordered title.episode column is refused rather than ingested", async () => {
    const dir = dumpDir(root, BASE);
    // parentTconst and tconst swapped -- every row would attribute an episode to itself
    // and no row count would catch it.
    const bad = ["parentTconst\ttconst\tseasonNumber\tepisodeNumber", `${SERIES}\ttt-e101\t1\t1`];
    await Bun.write(join(dir, "title.episode.tsv.gz"), Bun.gzipSync(Buffer.from(`${bad.join("\n")}\n`)));
    await expect(
      buildIndex(indexConfig(), dir, join(root, `${crypto.randomUUID()}.db`), () => {}),
    ).rejects.toThrow(/schema drift in title\.episode/);
  });
});

describe("the stage stamp", () => {
  test("a build stamps `episodes`, so a boot can tell an index predates it", async () => {
    const db = await build();
    const stamp = JSON.parse(
      (db.query("select value from meta where key = 'stages'").get() as { value: string }).value,
    ) as Record<string, string>;
    expect(stamp.episodes).toBe(currentStages(indexConfig()).episodes);
  });

  test("a build with NO dump still stamps it -- the stage ran and the answer was 'none'", async () => {
    // Stamping only successes would have a dumpless deployment rebuild its whole index on
    // every boot, forever, to re-discover the same absence.
    const dir = dumpDir(root, { ...BASE, episodes: undefined });
    const dest = join(root, `${crypto.randomUUID()}.db`);
    await buildIndex(indexConfig(), dir, dest, () => {});
    expect(stagesOf(dest).episodes).toBe(currentStages(indexConfig()).episodes);
  });

  test("moving episodeSeriesMinVotes makes the live index stale, so boot orders a rebuild", async () => {
    const dataDir = join(root, crypto.randomUUID());
    mkdirSync(dataDir, { recursive: true });
    const dir = dumpDir(root, BASE);
    const live = join(dataDir, "titles.db");
    await buildIndex(indexConfig(), dir, join(dataDir, "titles.new.db"), () => {});
    renameSync(join(dataDir, "titles.new.db"), live);

    expect(staleStagesOf(live, indexConfig()).map((s) => s.stage)).not.toContain("episodes");
    // The failure this catches: a lowered floor silently swallowed until a dump happens to
    // drift, whose symptom is a mid-sized show with no episode list and nothing to say why.
    const widened = staleStagesOf(live, indexConfig({ episodeSeriesMinVotes: 100 }));
    expect(widened.map((s) => s.stage)).toContain("episodes");
  });
});

// ---------------------------------------------------------------------------
// The query surface
// ---------------------------------------------------------------------------

/** A throwaway index with the real schema and the caller's episodes in it. */
function episodeIndex(rows: Partial<EpisodeRow>[]): string {
  const path = join(root, `${crypto.randomUUID()}.db`);
  const db = new Database(path, { create: true });
  db.run(SCHEMA);
  db.run("insert into title (tconst, kind, title, votes) values ('tt-s', 'tvSeries', 'Show', 90000)");
  const insert = db.query(
    "insert into episode (tconst, parent, season, number, title, rating, votes, year) values (?,?,?,?,?,?,?,?)",
  );
  for (const r of rows) {
    insert.run(
      r.tconst ?? crypto.randomUUID(),
      r.parent ?? "tt-s",
      r.season ?? 1,
      r.number ?? 1,
      r.title ?? null,
      r.rating ?? null,
      r.votes ?? 0,
      r.year ?? null,
    );
  }
  db.close();
  return path;
}

const RUN: Partial<EpisodeRow>[] = [
  { tconst: "e-s2e1", season: 2, number: 1, title: "Later", rating: 9.5, votes: 8000 },
  { tconst: "e-s1e2", season: 1, number: 2, title: "Second", rating: 7.4, votes: 6000 },
  { tconst: "e-s1e1", season: 1, number: 1, title: "Pilot", rating: 8.1, votes: 5000 },
  { tconst: "e-s0e1", season: 0, number: 1, title: "Special", rating: 8.9, votes: 40 },
  // The one that aired this week.
  { tconst: "e-s2e2", season: 2, number: 2, title: "Brand New", rating: null, votes: 0 },
];

describe("queryEpisodes", () => {
  const open = (rows = RUN) => new Database(episodeIndex(rows), { readonly: true });

  test("ordered by season then episode number, with SEASON 0 LAST", () => {
    const db = open();
    expect(queryEpisodes(db, "tt-s").map((e) => e.tconst)).toEqual([
      "e-s1e1",
      "e-s1e2",
      "e-s2e1",
      "e-s2e2",
      "e-s0e1",
    ]);
  });

  test("a huge specials season cannot crowd out the real ones under a limit", () => {
    /*
      THE MEASURED CASE: Rick and Morty's season 0 holds 187 entries.

      Sorted naively, season 0 comes first, so `list_episodes` at its 200 default would
      return 187 behind-the-scenes clips and 13 real episodes -- and an agent asked for the
      best episodes would answer from bloopers. The limit is what makes the ordering matter:
      without one, order is cosmetic; with one, it decides what is even visible.
    */
    const many: Partial<EpisodeRow>[] = [];
    for (let i = 1; i <= 187; i++) {
      many.push({ tconst: `e-s0e${i}`, season: 0, number: i, title: `Special ${i}`, rating: 6, votes: 20 });
    }
    many.push({ tconst: "e-s1e1", season: 1, number: 1, title: "Pilot", rating: 9.1, votes: 50_000 });
    const db = open(many);
    expect(queryEpisodes(db, "tt-s", { limit: 5 }).map((e) => e.tconst)).toEqual([
      "e-s1e1",
      "e-s0e1",
      "e-s0e2",
      "e-s0e3",
      "e-s0e4",
    ]);
  });

  test("another series' episodes are not in the answer", () => {
    const db = open([...RUN, { tconst: "other", parent: "tt-other", season: 1, number: 1 }]);
    expect(queryEpisodes(db, "tt-s").map((e) => e.tconst)).not.toContain("other");
    expect(queryEpisodes(db, "tt-nothing")).toEqual([]);
  });

  test("a season filter narrows to that season, and season 0 is askable", () => {
    const db = open();
    expect(queryEpisodes(db, "tt-s", { season: 1 }).map((e) => e.tconst)).toEqual(["e-s1e1", "e-s1e2"]);
    expect(queryEpisodes(db, "tt-s", { season: 0 }).map((e) => e.tconst)).toEqual(["e-s0e1"]);
  });

  test("minRating EXCLUDES an unrated episode, and that is the honest answer", () => {
    // "Every episode over 8.0" cannot include one nobody has scored: we do not know that it
    // is over 8.0. The row is still reachable by a query that pins no rating.
    const db = open();
    expect(queryEpisodes(db, "tt-s", { minRating: 8.0 }).map((e) => e.tconst)).toEqual([
      "e-s1e1",
      "e-s2e1",
      "e-s0e1",
    ]);
    expect(queryEpisodes(db, "tt-s").map((e) => e.tconst)).toContain("e-s2e2");
  });

  test("an unrated episode comes back as null rather than 0", () => {
    const db = open();
    const brandNew = queryEpisodes(db, "tt-s").find((e) => e.tconst === "e-s2e2");
    expect(brandNew?.rating).toBeNull();
    expect(brandNew?.votes).toBe(0);
    // And the guard that matters for any caller sorting these: null is not 0, so a
    // `rating > 0` test would not accidentally admit it either.
    expect(brandNew?.rating).not.toBe(0);
  });

  test("minVotes filters on the episode's own votes", () => {
    const db = open();
    expect(queryEpisodes(db, "tt-s", { minVotes: 5000 }).map((e) => e.tconst)).toEqual([
      "e-s1e1",
      "e-s1e2",
      "e-s2e1",
    ]);
  });

  test("filters compose", () => {
    const db = open();
    expect(queryEpisodes(db, "tt-s", { season: 2, minRating: 9 }).map((e) => e.tconst)).toEqual(["e-s2e1"]);
  });

  test("the limit defaults to a page and is honoured when given", () => {
    const db = open();
    expect(queryEpisodes(db, "tt-s", { limit: 2 }).map((e) => e.tconst)).toEqual(["e-s1e1", "e-s1e2"]);
    expect(queryEpisodes(db, "tt-s").length).toBe(Math.min(RUN.length, EPISODE_PAGE));
    // A nonsensical limit must not turn into "no rows" -- SQLite reads `limit 0` and
    // `limit -1` as two different things, and neither is what a caller passing 0 meant.
    expect(queryEpisodes(db, "tt-s", { limit: 0 }).length).toBe(1);
  });

  test("a row carries the whole contract, spelled out", () => {
    const db = open();
    expect(queryEpisodes(db, "tt-s", { season: 1, limit: 1 })[0]).toEqual({
      tconst: "e-s1e1",
      parent: "tt-s",
      season: 1,
      number: 1,
      title: "Pilot",
      rating: 8.1,
      votes: 5000,
      year: null,
    });
  });
});

describe("SearchEngine against an index without the episode table", () => {
  const cfg = { index: { fuzzyMinVotes: 100 } } as unknown as Config;

  /** An index carrying every other stage and not this one -- the shape a rollout meets. */
  function preEpisodeIndex(): string {
    const path = episodeIndex([]);
    const db = new Database(path);
    db.run("drop table episode");
    db.close();
    return path;
  }

  /**
   * The regression this exists for, and it has already been paid for once on `hasPeople`:
   * a capability probe written as a FIELD INITIALIZER runs before the constructor body, so
   * `= this.tableExists(...)` reads `this.db` while it is still undefined and merely
   * CONSTRUCTING a SearchEngine throws. That takes out the canary gate on a real index
   * build and the server on boot, and the suite did not catch it the first time.
   */
  test("constructing against an index with no episode table does not throw", () => {
    expect(() => new SearchEngine(preEpisodeIndex(), cfg)).not.toThrow();
  });

  test("hasEpisodes is false and episodesOf degrades to empty instead of erroring", () => {
    const engine = new SearchEngine(preEpisodeIndex(), cfg);
    expect(engine.hasEpisodes).toBe(false);
    // `no such table: episode` against exactly the index most likely to be live during a
    // rollout would be the worst possible moment for it.
    expect(engine.episodesOf("tt-s")).toEqual([]);
    expect(engine.episodesOf("tt-s", { season: 1, minRating: 8 })).toEqual([]);
  });

  test("hasEpisodes is true once the table is there, and the query answers", () => {
    const engine = new SearchEngine(episodeIndex(RUN), cfg);
    expect(engine.hasEpisodes).toBe(true);
    expect(engine.episodesOf("tt-s", { minRating: 8 }).map((e) => e.tconst)).toEqual([
      "e-s1e1",
      "e-s2e1",
      "e-s0e1",
    ]);
  });
});
