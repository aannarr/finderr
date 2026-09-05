/**
 * What happens when the reader types a title's whole name.
 *
 * THE BUG THIS EXISTS FOR, found on the live index 2026-09-05: `heart of the beast` put
 * `tt7526136` -- a film whose title is exactly that string -- at position **112**, behind
 * "In the Heart of the Sea", "Transformers: Rise of the Beasts" and a hundred others. The
 * reader's report was that the film "doesn't show up at all", which at 112 is the same
 * thing.
 *
 * Two separate defects in `rank()` produced it and both are pinned below:
 *
 *   1. The exact-title branch scaled its bonus by votes (`14 * ln(votes+10)/ln(50_000)`),
 *      so at zero votes it paid **2.98** -- LESS than the flat **12** the coverage branch
 *      pays a title that merely contains every query word. The three branches measure the
 *      same thing and the code's own comment says to take the strongest signal, never the
 *      sum; the strongest was silently the weakest.
 *   2. The popularity term spans 5.5 to 30.3 unconditionally, so no exact match on an
 *      unvoted title could clear a popular partial one whatever the first defect did.
 *
 * Tested as POLICY against a handful of rows in a temp file, never against
 * `data/titles.db` -- a test pinned to the real index measures the IMDb dump and goes red
 * on the next rebuild. Same rule `browse.test.ts` and `rank.test.ts` follow. The canary
 * suite is what guards the real corpus, and it stays at 42/42 across this change.
 */

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";
import { buildTitleSearchIndex, SCHEMA } from "./index-builder";
import { despace, normalizeStripped } from "./normalize";
import { SearchEngine } from "./search";

const dir = mkdtempSync(join(tmpdir(), "finderr-exact-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Row {
  tconst: string;
  title: string;
  year: number;
  votes: number;
  kind?: string;
}

/**
 * An index shaped like the real one, down to the normalized columns.
 *
 * The three derived columns are the build's own derivation rather than a test-local
 * approximation: `rank()` compares the query against `ntitle`/`norig` and FTS matches on
 * `dtitle` too, so a fixture that filled them differently would be measuring a different
 * engine from the one that ships.
 */
function engineOf(rows: Row[]): SearchEngine {
  const path = join(dir, `${crypto.randomUUID()}.db`);
  const db = new Database(path, { create: true });
  db.run(SCHEMA);
  const insert = db.prepare(
    "insert into title (tconst, kind, title, orig, year, votes, rating, genres, ntitle, norig, dtitle) " +
      "values (?,?,?,?,?,?,0,'',?,?,?)",
  );
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
    );
  }
  buildTitleSearchIndex(db);
  db.close();
  return new SearchEngine(path, loadConfig());
}

/** The live case, reduced: an unvoted exact match against a famous near-miss. */
const HEART_OF_THE_BEAST: Row[] = [
  { tconst: "tt-exact", title: "Heart of the Beast", year: 2026, votes: 0 },
  { tconst: "tt-sea", title: "In the Heart of the Sea", year: 2015, votes: 160_542 },
  { tconst: "tt-transformers", title: "Transformers: Rise of the Beasts", year: 2023, votes: 133_774 },
  { tconst: "tt-whisper", title: "Whisper of the Heart", year: 1995, votes: 84_650 },
];

describe("an exact title match", () => {
  test("wins even with no votes at all, against a far more popular partial match", () => {
    // The reported bug, stated as the thing a reader would say: I typed the film's whole
    // name and the film was not on the page. Nothing here is about the 2026 film being
    // good -- it is about "no votes yet" not being evidence that the reader meant
    // something else, when the reader named the title exactly.
    const engine = engineOf(HEART_OF_THE_BEAST);
    try {
      const hits = engine.search("heart of the beast", { limit: 10 }).hits;
      expect(hits[0]?.tconst).toBe("tt-exact");
    } finally {
      engine.close();
    }
  });

  test("is never worth less than merely containing every query word", () => {
    // Defect 1 in isolation, and the reason it is a defect rather than a tuning choice:
    // "the whole title IS the query" strictly implies "every query word appears", so a
    // scoring branch that pays the first less than the second is incoherent whatever the
    // constants are. Both candidates here have the same (zero) popularity, so the branch
    // is the only thing separating them.
    const engine = engineOf([
      { tconst: "tt-exact", title: "Heart of the Beast", year: 2026, votes: 0 },
      { tconst: "tt-covers", title: "The Beast at the Heart of Everything", year: 2026, votes: 0 },
    ]);
    try {
      const hits = engine.search("heart of the beast", { limit: 10 }).hits;
      expect(hits[0]?.tconst).toBe("tt-exact");
    } finally {
      engine.close();
    }
  });

  test("still loses to a BETTER-KNOWN title carrying the same exact name", () => {
    // The guard on the fix. Lifting an unvoted exact match must not flatten the ordering
    // AMONG exact matches -- somebody typing "Dune" means the Dune everybody means, and
    // popularity is the only thing that can say which one that is.
    const engine = engineOf([
      { tconst: "tt-dune-short", title: "Dune", year: 2019, votes: 0 },
      { tconst: "tt-dune-2021", title: "Dune", year: 2021, votes: 850_000 },
      { tconst: "tt-dune-1984", title: "Dune", year: 1984, votes: 187_000 },
    ]);
    try {
      const hits = engine.search("dune", { limit: 10 }).hits;
      expect(hits.map((h) => h.tconst)).toEqual(["tt-dune-2021", "tt-dune-1984", "tt-dune-short"]);
    } finally {
      engine.close();
    }
  });

  test("does not outrank a popular SEQUEL the reader is more likely to mean", () => {
    // The cost of the fix, bounded. An unvoted exact match now clears a popular partial
    // one -- but only just, and a title that both covers the query and is watched by
    // millions still comes first. This is the assertion that would catch a floor set too
    // high: at 50k votes' worth of credit the unvoted short would bury "Part Two".
    const engine = engineOf([
      { tconst: "tt-dune-short", title: "Dune", year: 2019, votes: 0 },
      { tconst: "tt-dune-part-two", title: "Dune: Part Two", year: 2024, votes: 600_000 },
    ]);
    try {
      const hits = engine.search("dune", { limit: 10 }).hits;
      expect(hits[0]?.tconst).toBe("tt-dune-part-two");
    } finally {
      engine.close();
    }
  });

  test("an explicit year still beats it, which is the one gate that was already right", () => {
    // `The Matrix 2021` -> Resurrections, canary case and stated intent of the year gate.
    // The fix must not reach around it: an exact match whose year contradicts the query is
    // not treated as exact at all, so nothing here gets a popularity floor either.
    const engine = engineOf([
      { tconst: "tt-matrix", title: "The Matrix", year: 1999, votes: 2_000_000 },
      { tconst: "tt-resurrections", title: "The Matrix Resurrections", year: 2021, votes: 250_000 },
    ]);
    try {
      const hits = engine.search("the matrix 2021", { limit: 10 }).hits;
      expect(hits[0]?.tconst).toBe("tt-resurrections");
    } finally {
      engine.close();
    }
  });
});
