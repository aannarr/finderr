/**
 * The stopword-only query path.
 *
 * The bug was a LATENCY bug -- `?q=the` cost 1033ms on the live NAS and blocked the event
 * loop for all of it -- but a test that asserts a duration is a test that goes red on a busy
 * CI runner and green on a fast one. So these pin the two things that MAKE it fast, both of
 * which are structural and neither of which is a clock:
 *
 *   1. the expression handed to FTS (the 234,192-row `"the"*` must never be built again), and
 *   2. the query shape and its ordering.
 *
 * The fixture is built from the real `SCHEMA` and the real builder DDL, following
 * `browse.test.ts`, so it is shaped like the index rather than like somebody's memory of it.
 */

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRank, EXPLODE_GENRES, SCHEMA } from "./index-builder";
import { normalize } from "./normalize";
import { POPULAR_TITLE_INDEX, STOPWORD_VOTE_FLOOR, STOPWORDS, stopwordTokens } from "./search-stopwords";

const dir = mkdtempSync(join(tmpdir(), "finderr-stopwords-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Row {
  title: string;
  votes: number;
}

function indexOf(rows: Row[]): Database {
  const db = new Database(join(dir, `${crypto.randomUUID()}.db`), { create: true });
  db.run(SCHEMA);
  const insert = db.query(
    "insert into title (tconst, kind, title, year, votes, rating, genres) values (?, ?, ?, ?, ?, ?, ?)",
  );
  rows.forEach((r, i) => {
    insert.run(`tt${i}`, "movie", r.title, 2000, r.votes, 7, "Drama");
  });
  applyRank(db, 10);
  db.run(EXPLODE_GENRES);
  db.run(POPULAR_TITLE_INDEX);
  return db;
}

/** The query `popularStopwordHits` runs, kept identical so the test exercises the real shape. */
function popular(db: Database, phrase: string): string[] {
  return (
    db
      .query(
        `select title from title where votes >= ? and (title like ? or title like ?) order by votes desc limit 400`,
      )
      .all(STOPWORD_VOTE_FLOOR, `${phrase} %`, phrase) as { title: string }[]
  ).map((r) => r.title);
}

describe("stopwordTokens", () => {
  test("a query of nothing but stopwords returns its tokens", () => {
    expect(stopwordTokens("the")).toEqual(["the"]);
    expect(stopwordTokens("the the")).toEqual(["the", "the"]);
    expect(stopwordTokens("of")).toEqual(["of"]);
  });

  test("one meaningful token is enough to take the ordinary path", () => {
    expect(stopwordTokens("the matrix")).toBeNull();
    expect(stopwordTokens("matrix")).toBeNull();
    // The keystroke BEFORE "the matrix" -- a single letter is not a stopword, so this is a
    // normal FTS query and was already cheap. Pinned because routing it here by accident
    // would answer "the l" with popular titles called "The" and drop the "l" entirely.
    expect(stopwordTokens("the l")).toBeNull();
  });

  test("an empty query is not a stopword query", () => {
    expect(stopwordTokens("")).toBeNull();
    expect(stopwordTokens("   ")).toBeNull();
  });

  test("a trailing space still reads as stopword-only", () => {
    // "the " is a real keystroke on the way to "the matrix" and cost the same 1033ms.
    expect(stopwordTokens(normalize("the "))).toEqual(["the"]);
  });

  test("every token it returns is a member of the closed set", () => {
    // This is the property that makes the result safe to interpolate into a `like` pattern:
    // no user text survives, so no `%` or `_` can reach it.
    for (const q of ["the", "the the", "la la", "el", "di da che"]) {
      for (const t of stopwordTokens(q) ?? []) expect(STOPWORDS.has(t)).toBe(true);
    }
    expect(stopwordTokens("100% of it")).toBeNull();
  });
});

describe("the popular-slice answer", () => {
  const CORPUS: Row[] = [
    { title: "The Shawshank Redemption", votes: 3_000_000 },
    { title: "The Matrix", votes: 2_000_000 },
    { title: "Se7en Somewhere The Middle", votes: 1_500_000 }, // contains "the", not a prefix
    { title: "The Obscure One", votes: 10 }, // right prefix, under the floor
    { title: "It", votes: 600_000 },
    { title: "It Follows", votes: 300_000 },
    { title: "Nothing Relevant", votes: 900_000 },
  ];

  test("returns titles that START with the word, most popular first", () => {
    expect(popular(indexOf(CORPUS), "the")).toEqual(["The Shawshank Redemption", "The Matrix"]);
  });

  test("a title merely CONTAINING the word is not an answer", () => {
    // The bug's FTS expression matched this row and 234,191 others. Prefix matching is what
    // makes the answer both cheap and the one a reader meant.
    expect(popular(indexOf(CORPUS), "the")).not.toContain("Se7en Somewhere The Middle");
  });

  test("a title that IS the word is an answer", () => {
    // `title like 'it %'` alone misses "It" (2017) entirely -- hence the `or title = ?`.
    const hits = popular(indexOf(CORPUS), "it");
    expect(hits[0]).toBe("It");
    expect(hits).toContain("It Follows");
  });

  test("the vote floor is what bounds the scan, and it excludes", () => {
    // Not incidental: the floor is the whole reason the worst case is 2.4ms rather than
    // 1461ms. A title under it is deliberately unreachable from a stopword-only query --
    // which is a query carrying no information, so there is nothing to reach it BY.
    expect(popular(indexOf(CORPUS), "the")).not.toContain("The Obscure One");
  });

  test("ordering is by votes and never by text similarity", () => {
    // Two titles equally "similar" to "the"; only popularity can separate them, and the
    // order must not depend on insertion order.
    const db = indexOf([
      { title: "The Quiet One", votes: 6_000 },
      { title: "The Loud One", votes: 900_000 },
    ]);
    expect(popular(db, "the")).toEqual(["The Loud One", "The Quiet One"]);
  });

  test("a stopword nothing starts with returns nothing rather than falling back", () => {
    expect(popular(indexOf(CORPUS), "che")).toEqual([]);
  });
});

describe("the partial covering index", () => {
  test("SQLite actually uses it, rather than scanning ix_votes", () => {
    // The index is only worth its 672 KB if the planner picks it. A `where` clause that
    // stopped matching the index's own predicate would silently fall back to the slow scan
    // -- correct answers, twenty times the cost, nothing red. That is the exact failure mode
    // the `popularTitles` stage stamp exists to catch on a real index, and this catches it
    // here.
    const db = indexOf([{ title: "The Matrix", votes: 2_000_000 }]);
    const plan = (
      db
        .query(
          `explain query plan select title from title where votes >= ? and (title like ? or title like ?) order by votes desc limit 400`,
        )
        .all(STOPWORD_VOTE_FLOOR, "the %", "the") as { detail: string }[]
    )
      .map((r) => r.detail)
      .join(" | ");

    expect(plan).toContain("ix_pop_title");
    // No temp b-tree: the index is already in votes order, which is why there is no sort to
    // pay for. A plan that sorts is a plan that walked the whole slice.
    expect(plan).not.toContain("TEMP B-TREE");
  });

  test("the DDL and the query agree about the floor", () => {
    // One owner for the number. If these ever disagree the index stops covering the range
    // the query asks for and nothing fails -- it just gets slow again.
    expect(POPULAR_TITLE_INDEX).toContain(`votes >= ${STOPWORD_VOTE_FLOOR}`);
  });
});
