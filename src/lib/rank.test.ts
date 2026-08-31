/**
 * The weighted rank column, and the layer the build writes around it.
 *
 * Tested as POLICY against a handful of rows in a temp file, never against
 * `data/titles.db` -- a test pinned to the real index would be measuring the IMDb dump and
 * would go red the next time it is rebuilt. Same rule `browse.test.ts` follows.
 */

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";
import { applyRank, buildRankLayer, SCHEMA } from "./index-builder";
import { SearchEngine } from "./search";

const dir = mkdtempSync(join(tmpdir(), "finderr-rank-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Row {
  tconst: string;
  kind?: string;
  votes: number;
  rating: number;
  genres?: string;
}

function indexOf(rows: Row[]): Database {
  const db = new Database(join(dir, `${crypto.randomUUID()}.db`), { create: true });
  db.run(SCHEMA);
  const insert = db.query(
    "insert into title (tconst, kind, title, year, votes, rating, genres) values (?, ?, ?, 2000, ?, ?, ?)",
  );
  for (const r of rows) {
    insert.run(r.tconst, r.kind ?? "movie", r.tconst, r.votes, r.rating, r.genres ?? "");
  }
  return db;
}

const rankOf = (db: Database, tconst: string): number | null =>
  (db.query("select rank from title where tconst = ?").get(tconst) as { rank: number | null }).rank;

/**
 * Filler that PINS THE CORPUS MEAN, and every test about ordering needs it.
 *
 * The prior mean is measured from the rows that clear the prior's vote count, so a fixture
 * of two or three titles is degenerate: the title under test is most of the population it
 * is being compared against, and `mean` comes out equal to its own rating. Three tests here
 * were written without this and asserted things that are false only because of it -- the
 * arithmetic was right and the corpus was one row.
 *
 * Enough rows at a known rating, all clearing any prior these tests use, that the mean is
 * theirs and the titles under test are rounding errors in it.
 */
const ballast = (rating: number, n = 20): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    tconst: `tt-ballast-${rating}-${i}`,
    votes: 100_000,
    rating,
  }));

describe("applyRank", () => {
  test("the prior mean is MEASURED from the corpus, not written down", () => {
    // Two titles clear the prior's vote count and average 8.0; the third is below it and
    // must not drag the mean. Hardcoding a mean is the failure this asserts against: the
    // value has to describe THIS corpus, because the real one drifts on every rebuild.
    const db = indexOf([
      { tconst: "tt-a", votes: 1000, rating: 7 },
      { tconst: "tt-b", votes: 1000, rating: 9 },
      { tconst: "tt-c", votes: 1, rating: 1 },
    ]);
    expect(applyRank(db, 100).mean).toBeCloseTo(8, 10);
  });

  test("a title sitting exactly at the prior is half its own rating and half the mean", () => {
    // The formula, stated as arithmetic rather than as a number copied out of a run:
    // v == C means the weights are 0.5/0.5, which is the entire meaning of "prior strength
    // in votes". If this drifts, every list in the product silently re-orders.
    const db = indexOf([...ballast(6), { tconst: "tt-at-prior", votes: 100, rating: 10 }]);
    const { mean } = applyRank(db, 100);
    // Asserted against the mean the run MEASURED rather than against a number typed here:
    // the constant is the 0.5/0.5 split, and pinning the mean too would be pinning the
    // fixture instead of the formula.
    expect(rankOf(db, "tt-at-prior")).toBeCloseTo(0.5 * 10 + 0.5 * mean, 10);
  });

  test("more votes at the same rating always ranks higher", () => {
    // Monotonic in votes, which is what makes the order defensible as "weighted by how
    // many people voted" rather than as a tuning artefact.
    // The ballast rates 5, so 9 is above the mean and more evidence moves a title UP. Below
    // the mean the same formula moves it down, which is the same property seen from the
    // other side rather than a different rule.
    const db = indexOf([
      ...ballast(5),
      { tconst: "tt-few", votes: 200, rating: 9 },
      { tconst: "tt-some", votes: 20_000, rating: 9 },
      { tconst: "tt-many", votes: 2_000_000, rating: 9 },
    ]);
    applyRank(db, 25_000);
    const few = rankOf(db, "tt-few") ?? 0;
    const some = rankOf(db, "tt-some") ?? 0;
    const many = rankOf(db, "tt-many") ?? 0;
    expect(few).toBeLessThan(some);
    expect(some).toBeLessThan(many);
  });

  test("an unrated title gets NULL, never the prior mean", () => {
    // The dangerous alternative is a well-formed number that means "we know nothing":
    // collapsing to the mean would file every unrated title ABOVE every genuinely bad one.
    const db = indexOf([
      ...ballast(7),
      { tconst: "tt-bad", votes: 50_000, rating: 2 },
      { tconst: "tt-unrated", votes: 0, rating: 0 },
    ]);
    const { mean, ranked } = applyRank(db, 25_000);
    expect(rankOf(db, "tt-unrated")).toBeNull();
    // Everything but the unrated one, which is the whole distinction being drawn.
    expect(ranked).toBe(21);
    // And the badly-rated one really is below the mean, so a NULL sitting at the mean
    // would have outranked it.
    expect(rankOf(db, "tt-bad") ?? 0).toBeLessThan(mean);
  });

  test("re-running it is idempotent", () => {
    // The build runs once, but the daily refresh rebuilds from scratch and a rank that
    // shifted on a second application would mean the column depended on its own prior
    // value rather than only on votes and rating.
    const db = indexOf([{ tconst: "tt-x", votes: 50_000, rating: 8 }]);
    const first = applyRank(db, 25_000);
    const value = rankOf(db, "tt-x");
    const second = applyRank(db, 25_000);
    expect(second.mean).toBeCloseTo(first.mean, 10);
    expect(rankOf(db, "tt-x")).toBeCloseTo(value ?? 0, 10);
  });
});

/**
 * An index built BEFORE the rank column existed, which is the index every deploy meets.
 *
 * A redeploy keeps its data directory, so `titles.db` stays whatever the last refresh
 * built and the rank column does not appear until the next one. This is not a hypothetical
 * migration case -- it is the state of the live index for up to a day after this ships.
 */
describe("an index built before the rank column", () => {
  /** The pre-rank schema, verbatim: no `rank` on `title`, no `kind`/`rank` on `title_genre`. */
  function preRankIndex(): string {
    const path = join(dir, `${crypto.randomUUID()}.db`);
    const db = new Database(path, { create: true });
    db.run(`
      create table title (
        rowid_ integer primary key, tconst text not null unique, kind text not null,
        title text not null, orig text, year integer, end_year integer, runtime integer,
        genres text not null default '', votes integer not null default 0,
        rating real not null default 0, ntitle text not null default '',
        norig text not null default '', dtitle text not null default ''
      );
      create table title_genre (title_rowid integer not null, genre text not null);
      create table meta (key text primary key, value text not null);
    `);
    db.run(
      "insert into title (tconst, kind, title, votes, rating, genres) values ('tt1','movie','One',9000,8,'Drama')",
    );
    db.run("insert into title_genre (title_rowid, genre) values (1, 'Drama')");
    db.close();
    return path;
  }

  test("reports hasRank false rather than throwing at construction", () => {
    const engine = new SearchEngine(preRankIndex(), loadConfig());
    try {
      expect(engine.hasRank).toBe(false);
      // The rest of the product is unaffected -- the column is additive, like the cast tables.
      expect(engine.byTconst("tt1")?.title).toBe("One");
    } finally {
      engine.close();
    }
  });

  test("a ranked browse degrades to votes instead of `no such column: rank`", () => {
    // THE BUG THIS EXISTS FOR: the front page calls a ranked browse on every /api/discover,
    // so an unguarded query would take the whole discover route down for every visitor
    // until the next nightly refresh.
    const engine = new SearchEngine(preRankIndex(), loadConfig());
    try {
      expect(() => engine.browse({ kind: "movie", sort: "rank", minVotes: 0 })).not.toThrow();
      expect(engine.browse({ kind: "movie", sort: "rank", minVotes: 0 }).rows).toHaveLength(1);
      // A genre browse takes the other SQL path -- `title_genre` has no rank column either.
      expect(() => engine.browse({ genre: "Drama", sort: "rank", minVotes: 0 })).not.toThrow();
    } finally {
      engine.close();
    }
  });

  test("a NEW index reports hasRank true", () => {
    const path = join(dir, `${crypto.randomUUID()}.db`);
    const db = new Database(path, { create: true });
    db.run(SCHEMA);
    db.close();
    const engine = new SearchEngine(path, loadConfig());
    try {
      expect(engine.hasRank).toBe(true);
    } finally {
      engine.close();
    }
  });
});

describe("buildRankLayer", () => {
  const cfg = { ...loadConfig(), index: { ...loadConfig().index, rankPriorVotes: 100 } };

  test("the genre copy carries the same rank the title does", () => {
    // `title_genre.rank` is a DENORMALISED copy, and a copy that disagreed with its source
    // would order a per-genre list differently from the unfiltered one with nothing on
    // screen to explain why.
    const db = indexOf([
      { tconst: "tt-h", votes: 40_000, rating: 8, genres: "Horror,Thriller" },
      { tconst: "tt-d", votes: 40_000, rating: 6, genres: "Drama" },
    ]);
    buildRankLayer(db, cfg);
    const rows = db
      .query(
        "select t.tconst, t.kind, t.rank as trank, g.genre, g.kind as gkind, g.rank as grank " +
          "from title_genre g join title t on t.rowid_ = g.title_rowid order by g.genre",
      )
      .all() as {
      tconst: string;
      kind: string;
      trank: number;
      genre: string;
      gkind: string;
      grank: number;
    }[];
    expect(rows.map((r) => r.genre)).toEqual(["Drama", "Horror", "Thriller"]);
    for (const r of rows) {
      expect(r.grank).toBeCloseTo(r.trank, 10);
      expect(r.gkind).toBe(r.kind);
    }
  });

  test("it creates the two indexes the lists are ordered by", () => {
    // Without these every list is a scan plus a sort. The measurement that justified this
    // whole card is only true while both exist, so their absence should fail here rather
    // than show up as a slow page nobody profiles.
    const db = indexOf([{ tconst: "tt-a", votes: 40_000, rating: 8, genres: "Horror" }]);
    buildRankLayer(db, cfg);
    const names = (
      db.query("select name from sqlite_master where type = 'index'").all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toContain("ix_rank");
    expect(names).toContain("ix_tg_rank");
  });

  test("the ranked list really is an index seek, not a sort", () => {
    // The plan is the claim. `USE TEMP B-TREE FOR ORDER BY` appearing here is the whole
    // regression this card exists to prevent -- it is the difference between 0.05ms and
    // 142ms, and nothing else in the test suite would notice.
    const db = indexOf([{ tconst: "tt-a", votes: 40_000, rating: 8, genres: "Horror" }]);
    buildRankLayer(db, cfg);
    const plan = (
      db
        .query(
          "explain query plan select tconst from title t where t.kind = ? and t.rank is not null " +
            "order by t.rank desc limit 250",
        )
        .all("movie") as { detail: string }[]
    )
      .map((r) => r.detail)
      .join(" | ");
    expect(plan).toContain("ix_rank");
    expect(plan).not.toContain("TEMP B-TREE");
  });
});
