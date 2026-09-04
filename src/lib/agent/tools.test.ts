/**
 * The agent tools, against a fixture index rather than the 1.28M-row file.
 *
 * Same rule as `browse.test.ts`: what is under test is the POLICY -- arrays merge as a
 * union unless asked otherwise, a limit is a total, ids are refused where names are passed
 * -- and a test pinned to the real index would be measuring today's IMDb dump instead, and
 * would go red on the next rebuild.
 *
 * `findTitle` and `findPerson` are deliberately NOT covered here. They are thin wrappers
 * over `SearchEngine.search` / `.searchPeople`, which have their own suites and the 42-case
 * canary behind them; standing up an engine to re-assert the tier machinery would be a
 * second, worse copy of those tests.
 */

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRank, EXPLODE_GENRES, SCHEMA } from "../index-builder";
import { findConnections, MemoryResumeStore } from "./connections";
import { dispatch } from "./schemas";
import { type AgentContext, listCast, listCredits, navigate } from "./tools";

/**
 * Fixture ids are SHAPED LIKE REAL ONES -- `tt` or `nm` followed by digits -- and that is
 * not cosmetic. `resolveEndpoint` and `navigate` both match `/^tt\d+$/`, so a readable
 * `tt-furious` resolves to nothing and every graph assertion below fails for a reason that
 * has nothing to do with the graph. Found the hard way; the regex is right and the first
 * draft of this fixture was wrong.
 */
const T = {
  furious: "tt9000001",
  shameless: "tt9000002",
  bear: "tt9000003",
  heat: "tt9000004",
} as const;
const P = {
  rossum: "nm9000001",
  white: "nm9000002",
  lacy: "nm9000003",
  pacino: "nm9000004",
  deniro: "nm9000005",
} as const;

const dir = mkdtempSync(join(tmpdir(), "finderr-agent-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface TitleFix {
  tconst: string;
  title: string;
  year: number;
  kind: string;
  votes: number;
  genres?: string;
}
interface CastFix {
  tconst: string;
  nconst: string;
  name: string;
  category: string;
  ordering: number;
}

/**
 * A throwaway index with the real schema, a handful of titles and a small cast graph.
 *
 * The graph is the shape of the motivating question: `Furious` and `The Bear` share nobody,
 * but a person in each shares `Shameless`. That is the two-hop path, and it is the only
 * one -- so a test that finds two paths has found a bug, not a coincidence.
 */
function fixture(titles: TitleFix[], cast: CastFix[]): Database {
  const db = new Database(join(dir, `${crypto.randomUUID()}.db`), { create: true });
  db.run(SCHEMA);
  const insT = db.query(
    "insert into title (tconst, kind, title, year, votes, rating, genres) values (?, ?, ?, ?, ?, 7, ?)",
  );
  for (const t of titles) insT.run(t.tconst, t.kind, t.title, t.year, t.votes, t.genres ?? "Drama");
  applyRank(db, 10);
  db.run(EXPLODE_GENRES);

  const insP = db.query("insert or ignore into person (nconst, name) values (?, ?)");
  for (const c of cast) insP.run(c.nconst, c.name);
  const insTP = db.query(
    `insert into title_principal (title_rowid, person_rowid, category, ordering, characters)
     values ((select rowid_ from title where tconst = ?), (select rowid_ from person where nconst = ?), ?, ?, null)`,
  );
  for (const c of cast) insTP.run(c.tconst, c.nconst, c.category, c.ordering);
  return db;
}

const TITLES: TitleFix[] = [
  { tconst: T.furious, title: "Furious", year: 2026, kind: "tvSeries", votes: 14_000 },
  { tconst: T.shameless, title: "Shameless", year: 2011, kind: "tvSeries", votes: 338_000 },
  { tconst: T.bear, title: "The Bear", year: 2022, kind: "tvSeries", votes: 324_000 },
  { tconst: T.heat, title: "Heat", year: 1995, kind: "movie", votes: 817_000 },
];

const CAST: CastFix[] = [
  { tconst: T.furious, nconst: P.rossum, name: "Emmy Rossum", category: "actress", ordering: 1 },
  { tconst: T.furious, nconst: P.lacy, name: "Jake Lacy", category: "actor", ordering: 4 },
  { tconst: T.shameless, nconst: P.rossum, name: "Emmy Rossum", category: "actress", ordering: 1 },
  { tconst: T.shameless, nconst: P.white, name: "Jeremy Allen White", category: "actor", ordering: 2 },
  { tconst: T.bear, nconst: P.white, name: "Jeremy Allen White", category: "actor", ordering: 1 },
  { tconst: T.heat, nconst: P.pacino, name: "Al Pacino", category: "actor", ordering: 1 },
  { tconst: T.heat, nconst: P.deniro, name: "Robert De Niro", category: "actor", ordering: 2 },
];

const db = fixture(TITLES, CAST);
// These tools read `ctx.db` only; the engine half is exercised by `SearchEngine`'s own suite.
const ctx = { db } as AgentContext;

describe("listCast", () => {
  test("a union carries every person, and says which titles each was seen in", () => {
    const rows = listCast(ctx, { tconst: [T.furious, T.shameless] });
    const byName = new Map(rows.map((r) => [r.name, r]));
    expect([...byName.keys()].sort()).toEqual(["Emmy Rossum", "Jake Lacy", "Jeremy Allen White"]);
    expect(byName.get("Emmy Rossum")?.seen_in.sort()).toEqual([T.furious, T.shameless]);
  });

  test("an intersection is computed in SQL, not left for the caller to filter", () => {
    const rows = listCast(ctx, { tconst: [T.furious, T.shameless], mode: "intersection" });
    expect(rows.map((r) => r.name)).toEqual(["Emmy Rossum"]);
  });

  test("billing order leads, because 'the guy from X' means a lead", () => {
    const rows = listCast(ctx, { tconst: [T.furious] });
    expect(rows.map((r) => r.name)).toEqual(["Emmy Rossum", "Jake Lacy"]);
  });

  test("limit is a TOTAL across every id, never per id", () => {
    const rows = listCast(ctx, { tconst: [T.furious, T.shameless, T.heat], limit: 2 });
    expect(rows).toHaveLength(2);
  });

  test("roles filter on IMDb's own categories", () => {
    const rows = listCast(ctx, { tconst: [T.shameless], roles: ["actress"] });
    expect(rows.map((r) => r.name)).toEqual(["Emmy Rossum"]);
  });
});

describe("listCredits", () => {
  test("intersection answers 'what have both been in' in one call", () => {
    const rows = listCredits(ctx, { nconst: [P.pacino, P.deniro], mode: "intersection" });
    expect(rows.map((r) => r.title)).toEqual(["Heat"]);
  });

  test("a union of the same two returns everything either was in", () => {
    const rows = listCredits(ctx, { nconst: [P.rossum, P.white] });
    expect(rows.map((r) => r.title).sort()).toEqual(["Furious", "Shameless", "The Bear"]);
  });

  test("years is the recency lever", () => {
    const rows = listCredits(ctx, { nconst: [P.rossum], years: [2025, 2026] });
    expect(rows.map((r) => r.title)).toEqual(["Furious"]);
  });

  test("kind filters on IMDb's four values", () => {
    const rows = listCredits(ctx, { nconst: [P.pacino], kind: ["tvSeries"] });
    expect(rows).toEqual([]);
  });
});

describe("the ids-only wall", () => {
  const store = new MemoryResumeStore();

  test("a NAME where an id belongs is refused, and the refusal names the resolver", () => {
    const out = dispatch(ctx, store, "list_cast", { tconst: ["Furious"] }) as { error: string };
    expect(out.error).toContain("find_title");
    expect(out.error).toContain("never takes names");
  });

  test("the same wall guards list_credits, pointing at the other resolver", () => {
    const out = dispatch(ctx, store, "list_credits", { nconst: ["Emmy Rossum"] }) as { error: string };
    expect(out.error).toContain("find_person");
  });

  test("a real id passes straight through", () => {
    const out = dispatch(ctx, store, "list_cast", { tconst: [T.furious] }) as { name: string }[];
    expect(out.map((r) => r.name)).toContain("Emmy Rossum");
  });
});

describe("navigate", () => {
  test("routes both id spaces, with the trailing slash", () => {
    expect(navigate("tt0111161")).toEqual({ ok: true, path: "/title/tt0111161/" });
    expect(navigate("nm0000199")).toEqual({ ok: true, path: "/person/nm0000199/" });
  });

  test("refuses anything that is not an id rather than guessing a route", () => {
    expect(navigate("The Bear").ok).toBe(false);
  });
});

describe("findConnections", () => {
  const store = () => new MemoryResumeStore();

  test("one hop is somebody who was in both", () => {
    const out = findConnections(db, { from: T.furious, to: T.shameless, max_hops: 1 }, store());
    expect(out.paths).toHaveLength(1);
    expect(out.paths[0]?.path.map((n) => n.name)).toEqual(["Furious", "Emmy Rossum", "Shameless"]);
  });

  test("two hops finds the bridge title, which is the motivating question", () => {
    const out = findConnections(db, { from: T.furious, to: T.bear, max_hops: 2 }, store());
    expect(out.status).toBe("complete");
    expect(out.paths[0]?.path.map((n) => n.name)).toEqual([
      "Furious",
      "Emmy Rossum",
      "Shameless",
      "Jeremy Allen White",
      "The Bear",
    ]);
  });

  test("an unconnected pair completes with no paths -- which is a real answer", () => {
    const out = findConnections(db, { from: T.heat, to: T.bear, max_hops: 2 }, store());
    expect(out.status).toBe("complete");
    expect(out.paths).toEqual([]);
  });

  test("running out of budget is REPORTED, never returned as 'unconnected'", () => {
    const out = findConnections(db, { from: T.furious, to: T.bear, budget: 2 }, store());
    expect(out.status).toBe("budget_exhausted");
    expect(out.resume).toBeTruthy();
    expect(out.spent).toBeLessThanOrEqual(2);
  });

  test("a resumed walk continues and finishes the job the budget cut short", () => {
    const s = store();
    const first = findConnections(db, { from: T.furious, to: T.bear, budget: 3 }, s);
    expect(first.status).toBe("budget_exhausted");
    const second = findConnections(db, { from: T.furious, to: T.bear, resume: first.resume }, s);
    expect(second.status).toBe("complete");
    expect(second.paths[0]?.path.map((n) => n.name)).toContain("Shameless");
  });

  test("an expired handle says so, so the agent restarts instead of reporting nothing", () => {
    const out = findConnections(db, { from: T.furious, to: T.bear, resume: "gone" }, store());
    expect(out.error).toBe("resume_expired");
  });

  test("an unresolvable id points at the resolver rather than failing silently", () => {
    const out = findConnections(db, { from: "Furious", to: T.bear }, store());
    expect(out.error).toContain("find_title");
  });
});
