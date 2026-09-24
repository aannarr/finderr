/**
 * TMDB popularity as imputed votes: the parser, the mapping, the build stage and the ranking.
 *
 * The case this exists for, as a FIXTURE rather than a canary line: `sacrifice` put Netflix's
 * 2026 *Sacrifice* at #10 behind older namesakes. A canary case on the real title would expire
 * the day the film earns its own votes, so the policy is pinned here instead, on rows that do
 * not age.
 */

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";
import { buildTitleSearchIndex, SCHEMA } from "./index-builder";
import { despace, normalizeStripped } from "./normalize";
import { rankingVotes, SearchEngine } from "./search";
import {
  BUZZ_RECENT_YEARS,
  buzzFromYear,
  ESTABLISHED_AGE_YEARS,
  exportUrl,
  fetchPopularityExport,
  loadBuzz,
  MIN_EXPORT_BYTES,
  POPULARITY_EXPORTS,
  type PopularityRow,
  parsePopularityLine,
  popularityDatePath,
  quantileImputer,
  readPopularityExport,
} from "./tmdb-popularity";

const dir = mkdtempSync(join(tmpdir(), "finderr-buzz-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const NOW = new Date("2026-09-24T09:00:00Z");
const YEAR = NOW.getUTCFullYear();

describe("parsePopularityLine", () => {
  test("reads a film line and a series line", () => {
    expect(
      parsePopularityLine(
        '{"adult":false,"id":3924,"original_title":"Blondie","popularity":1.9318,"video":false}',
      ),
    ).toEqual({ id: 3924, popularity: 1.9318 });
    expect(parsePopularityLine('{"id":2,"original_name":"Clerks","popularity":10.3133}')).toEqual({
      id: 2,
      popularity: 10.3133,
    });
  });

  test("drops what it cannot attribute rather than guessing", () => {
    for (const bad of [
      "",
      "{",
      '{"id":"12","popularity":3}',
      '{"id":1.5,"popularity":3}',
      '{"id":0,"popularity":3}',
      '{"id":7}',
      '{"id":7,"popularity":-1}',
      '{"id":7,"popularity":"3"}',
      "null",
      "[1,2]",
    ]) {
      expect(parsePopularityLine(bad)).toBeNull();
    }
  });
});

test("exportUrl spells TMDB's MM_DD_YYYY in UTC", () => {
  expect(exportUrl("movie_ids", new Date("2026-09-23T23:59:00Z"))).toBe(
    "https://files.tmdb.org/p/exports/movie_ids_09_23_2026.json.gz",
  );
  expect(exportUrl("tv_series_ids", new Date("2027-01-05T00:00:00Z"))).toBe(
    "https://files.tmdb.org/p/exports/tv_series_ids_01_05_2027.json.gz",
  );
});

test("the eligible years are this one and last, and move on 1 January", () => {
  expect(BUZZ_RECENT_YEARS).toBe(1);
  expect(buzzFromYear(new Date("2026-12-31T23:59:59Z"))).toBe(2025);
  expect(buzzFromYear(new Date("2027-01-01T00:00:00Z"))).toBe(2026);
});

describe("quantileImputer", () => {
  // Popularity i pairs with votes 10*i, so percentile P of one IS percentile P of the other.
  const reference = Array.from({ length: 100 }, (_, i) => ({ popularity: i + 1, votes: (i + 1) * 10 }));

  test("refuses to map over too small a sample", () => {
    expect(quantileImputer(reference.slice(0, 5), 10)).toBeNull();
  });

  test("maps a percentile of popularity onto the same percentile of votes", () => {
    const impute = quantileImputer(reference, 10);
    if (!impute) throw new Error("expected a mapping");
    expect(impute(50.5)).toBe(510); // 50 of 100 are less popular -> the 51st-lowest votes
    expect(impute(1)).toBe(10);
    expect(impute(0)).toBe(10);
    expect(impute(1_000)).toBe(1_000); // off the top of the scale -> the most-voted
  });

  test("is monotonic, so a more popular title is never imputed fewer votes", () => {
    // Shuffled and uncorrelated on purpose: the mapping sorts both sides independently,
    // which is what makes it rank-to-rank rather than a regression through noise.
    const noisy = Array.from({ length: 500 }, (_, i) => ({
      popularity: ((i * 7919) % 500) / 10,
      votes: ((i * 104729) % 997) + 1,
    }));
    const impute = quantileImputer(noisy, 10);
    if (!impute) throw new Error("expected a mapping");
    let last = -1;
    for (let p = 0; p <= 60; p += 0.25) {
      const v = impute(p);
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
  });
});

test("readPopularityExport streams a gzip, skipping bad lines and keeping an unterminated last one", async () => {
  const path = join(dir, "export.json.gz");
  const text = [
    '{"id":1,"original_title":"A","popularity":5.5}',
    "not json",
    '{"id":2,"original_title":"B","popularity":0.6}',
    '{"id":3,"original_title":"C","popularity":49.1}', // no trailing newline
  ].join("\n");
  writeFileSync(path, Bun.gzipSync(new TextEncoder().encode(text)));
  const rows: PopularityRow[] = [];
  for await (const r of readPopularityExport(path)) rows.push(r);
  expect(rows).toEqual([
    { id: 1, popularity: 5.5 },
    { id: 2, popularity: 0.6 },
    { id: 3, popularity: 49.1 },
  ]);
});

describe("fetchPopularityExport", () => {
  const source = POPULARITY_EXPORTS[0];
  /** Bytes shaped like a real export: gzip magic, and the size of one. */
  const exportBytes = () => {
    const b = new Uint8Array(MIN_EXPORT_BYTES + 1);
    b[0] = 0x1f;
    b[1] = 0x8b;
    return b;
  };

  /**
   * The crosswalk bug of 2026-09-21 in this file's clothes: a 200 that is not the export -- an
   * error page, an empty object -- must never replace the copy on disk.
   */
  test("a 200 that is not a gzip of plausible size is refused, and the day before is tried", async () => {
    const dumps = mkdtempSync(join(dir, "dumps-"));
    const ok = await fetchPopularityExport(source, dumps, {
      now: () => NOW.getTime(),
      fetchImpl: (async (url: string) =>
        url.includes("09_24_2026")
          ? new Response("<Error/>")
          : new Response(exportBytes())) as unknown as typeof fetch,
    });
    expect(ok).toBe(true);
    expect(readFileSync(popularityDatePath(join(dumps, source.file)), "utf8")).toBe("2026-09-23");
  });

  test("falls back to yesterday while today's export is not published yet", async () => {
    const dumps = mkdtempSync(join(dir, "dumps-"));
    const asked: string[] = [];
    const ok = await fetchPopularityExport(source, dumps, {
      now: () => NOW.getTime(),
      fetchImpl: (async (url: string) => {
        asked.push(url);
        // The bucket answers 403, not 404, for a file that does not exist yet.
        return url.includes("09_24_2026") ? new Response("", { status: 403 }) : new Response(exportBytes());
      }) as unknown as typeof fetch,
    });
    expect(ok).toBe(true);
    expect(asked.map((u) => u.slice(u.lastIndexOf("/") + 1))).toEqual([
      "movie_ids_09_24_2026.json.gz",
      "movie_ids_09_23_2026.json.gz",
    ]);
    const path = join(dumps, source.file);
    expect(readFileSync(path).length).toBe(MIN_EXPORT_BYTES + 1);
    expect(readFileSync(popularityDatePath(path), "utf8")).toBe("2026-09-23");
    expect(existsSync(`${path}.part`)).toBe(false);
  });

  test("reuses a fresh copy without asking, and keeps a stale one when every day fails", async () => {
    const dumps = mkdtempSync(join(dir, "dumps-"));
    const path = join(dumps, source.file);
    writeFileSync(path, "old");
    let calls = 0;
    const failing = (async () => {
      calls++;
      throw new Error("offline");
    }) as unknown as typeof fetch;

    expect(await fetchPopularityExport(source, dumps, { fetchImpl: failing })).toBe(true);
    expect(calls).toBe(0);

    expect(await fetchPopularityExport(source, dumps, { fetchImpl: failing, maxAgeMs: 0 })).toBe(true);
    expect(calls).toBe(3);
    expect(readFileSync(path, "utf8")).toBe("old");
  });

  test("reports no file when nothing was ever downloaded", async () => {
    const dumps = mkdtempSync(join(dir, "dumps-"));
    const missing = (async () => new Response("", { status: 403 })) as unknown as typeof fetch;
    expect(await fetchPopularityExport(source, dumps, { fetchImpl: missing })).toBe(false);
  });
});

interface Row {
  tconst: string;
  title: string;
  year: number;
  votes: number;
  kind?: string;
  /** TMDB id in the title's own id space, written to `title_ids`. */
  tmdb?: number;
  buzz?: number;
}

function indexOf(rows: Row[], opts: { buzzColumn?: boolean } = {}): string {
  const path = join(dir, `${crypto.randomUUID()}.db`);
  const db = new Database(path, { create: true });
  db.run(SCHEMA);
  const insert = db.prepare(
    "insert into title (tconst, kind, title, orig, year, votes, rating, genres, ntitle, norig, dtitle, buzz_votes) " +
      "values (?,?,?,?,?,?,0,'',?,?,?,?)",
  );
  const ids = db.prepare("insert into title_ids (tconst, tmdb) values (?, ?)");
  for (const r of rows) {
    insert.run(
      r.tconst,
      r.kind ?? "movie",
      r.title,
      r.title,
      r.year,
      r.votes,
      normalizeStripped(r.title),
      normalizeStripped(r.title),
      `${despace(r.title)} ${despace(r.title)}`.trim(),
      r.buzz ?? 0,
    );
    if (r.tmdb !== undefined) ids.run(r.tconst, r.tmdb);
  }
  buildTitleSearchIndex(db);
  if (opts.buzzColumn === false) db.run("alter table title drop column buzz_votes");
  db.close();
  return path;
}

describe("loadBuzz", () => {
  // 200 established films: popularity i, votes 1000*i. Old enough to be the truth.
  const established: Row[] = Array.from({ length: 200 }, (_, i) => ({
    tconst: `tt-old-${i}`,
    title: `Old ${i}`,
    year: YEAR - ESTABLISHED_AGE_YEARS - (i % 20),
    votes: 1000 * (i + 1),
    tmdb: 10_000 + i,
  }));
  const filmPop: PopularityRow[] = established.map((r, i) => ({ id: r.tmdb as number, popularity: i + 1 }));

  async function run(extra: Row[], extraFilms: PopularityRow[], series: PopularityRow[]) {
    const path = indexOf([...established, ...extra]);
    const db = new Database(path);
    const stats = await loadBuzz(
      db,
      { movies: [...filmPop, ...extraFilms], series },
      { now: NOW, minSample: 100 },
    );
    const buzz = new Map(
      (
        db.query("select tconst, buzz_votes from title").all() as { tconst: string; buzz_votes: number }[]
      ).map((r) => [r.tconst, r.buzz_votes]),
    );
    db.close();
    return { stats, buzz };
  }

  test("lifts a hot recent title to the votes of an equally popular established one", async () => {
    const { stats, buzz } = await run(
      [{ tconst: "tt-hot", title: "Hot", year: YEAR, votes: 464, tmdb: 1 }],
      [{ id: 1, popularity: 150.5 }],
      [],
    );
    // 150 of 200 established titles are less popular -> the 151st-lowest votes.
    expect(buzz.get("tt-hot")).toBe(151_000);
    expect(stats.reference).toBe(200);
    expect(stats.imputed).toBe(1);
  });

  test("leaves an OLD title alone however popular it is today -- the recency gate", async () => {
    // Criminal Minds (2005) was imputed 1.7M votes by the ungated variant. This is that row.
    const { buzz } = await run(
      [
        {
          tconst: "tt-longrunner",
          title: "Long Runner",
          year: YEAR - BUZZ_RECENT_YEARS - 1,
          votes: 50,
          tmdb: 2,
        },
      ],
      [{ id: 2, popularity: 999 }],
      [],
    );
    expect(buzz.get("tt-longrunner")).toBe(0);
  });

  test("covers last year too, and writes nothing for a title its real votes already outrun", async () => {
    const { buzz } = await run(
      [
        { tconst: "tt-lastyear", title: "Last Year", year: YEAR - 1, votes: 10, tmdb: 3 },
        { tconst: "tt-outrun", title: "Outrun", year: YEAR, votes: 900_000, tmdb: 4 },
      ],
      [
        { id: 3, popularity: 100.5 },
        { id: 4, popularity: 100.5 },
      ],
      [],
    );
    expect(buzz.get("tt-lastyear")).toBe(101_000);
    expect(buzz.get("tt-outrun")).toBe(0);
  });

  test("matches a series in the SERIES export, never a film sharing its TMDB id", async () => {
    // TMDB ids are per id space: film 5 and series 5 are different titles. Reading the film
    // export for a series would hand it somebody else's audience.
    const { buzz } = await run(
      [{ tconst: "tt-show", title: "Show", year: YEAR, votes: 0, kind: "tvSeries", tmdb: 5 }],
      [{ id: 5, popularity: 199.5 }],
      [{ id: 5, popularity: 0.5 }],
    );
    expect(buzz.get("tt-show")).toBe(1_000);
  });

  test("imputes nothing when the reference set is too small to mean anything", async () => {
    const path = indexOf([{ tconst: "tt-hot", title: "Hot", year: YEAR, votes: 0, tmdb: 1 }]);
    const db = new Database(path);
    const stats = await loadBuzz(db, { movies: [{ id: 1, popularity: 80 }], series: [] }, { now: NOW });
    db.close();
    expect(stats).toEqual({ matched: 1, reference: 0, imputed: 0 });
  });
});

/**
 * The reported case, reduced. Votes are the real ones from 2026-09-24; `buzz` is what the
 * mapping gave *Sacrifice* from popularity 48.8.
 */
const SACRIFICE: Row[] = [
  { tconst: "tt-netflix", title: "Sacrifice", year: YEAR, votes: 464, buzz: 314_000 },
  { tconst: "tt-tarkovsky", title: "The Sacrifice", year: 1986, votes: 31_000 },
  { tconst: "tt-2016", title: "Sacrifice", year: 2016, votes: 4_300 },
  { tconst: "tt-pawn", title: "Pawn Sacrifice", year: 2014, votes: 44_000 },
  { tconst: "tt-2011", title: "Sacrifice", year: 2011, votes: 3_100 },
];

describe("ranking on imputed votes", () => {
  function top(rows: Row[], query: string, opts?: { buzzColumn?: boolean }) {
    const engine = new SearchEngine(indexOf(rows, opts), loadConfig());
    try {
      return engine.search(query, { limit: 10 }).hits;
    } finally {
      engine.close();
    }
  }

  test("puts a hot new release above its older namesakes", () => {
    const hits = top(SACRIFICE, "sacrifice");
    expect(hits[0]?.tconst).toBe("tt-netflix");
    // The card still prints the IMDb count; the imputation is a ranking input only.
    expect(hits[0]?.votes).toBe(464);
  });

  test("without the imputation the same rows lose it -- so the lift is what decides", () => {
    // The fixture proving it can go red: identical rows, buzz zeroed.
    const hits = top(
      SACRIFICE.map((r) => ({ ...r, buzz: 0 })),
      "sacrifice",
    );
    expect(hits[0]?.tconst).not.toBe("tt-netflix");
  });

  test("an index built before the stage has no column and still searches, unlifted", () => {
    const hits = top(SACRIFICE, "sacrifice", { buzzColumn: false });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.tconst).not.toBe("tt-netflix");
  });
});

test("rankingVotes is a max, never a sum", () => {
  expect(rankingVotes({ votes: 464, buzz_votes: 314_000 })).toBe(314_000);
  expect(rankingVotes({ votes: 900_000, buzz_votes: 314_000 })).toBe(900_000);
  expect(rankingVotes({ votes: 12 })).toBe(12);
});
