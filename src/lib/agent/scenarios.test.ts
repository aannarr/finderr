/**
 * The grader, and specifically the two verdicts it now keeps apart.
 *
 * The runs below are SYNTHESISED rather than measured. A test that called a model would
 * cost money, need a key, and go red on a day OpenRouter is slow -- and none of that would
 * be testing the grader, which is a pure function of a `RunResult`. The two runs that matter
 * are transcribed from the real 2026-09-04 benchmark: one model that compared two cast lists
 * by eye and one that asked for the join.
 */

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA } from "../index-builder";
import { evidenceFrom } from "./evidence";
import type { RunResult, ToolTrace } from "./runner";
import { grade, SCENARIOS, type Scenario } from "./scenarios";

const FURIOUS = "tt36303968";
const BEAR = "tt14452776";
const SHAMELESS = "tt1586680";
const ROSSUM = "nm0002536";
const WHITE = "nm2087739";

const dir = mkdtempSync(join(tmpdir(), "finderr-grade-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Just enough index for `nameOf` to turn an expected id back into the name a model writes. */
function index(): Database {
  const db = new Database(join(dir, `${crypto.randomUUID()}.db`), { create: true });
  db.run(SCHEMA);
  const t = db.query("insert into title (tconst, kind, title, year, votes, rating) values (?,?,?,?,?,7)");
  t.run(FURIOUS, "tvSeries", "Furious", 2026, 14556);
  t.run(BEAR, "tvSeries", "The Bear", 2022, 324317);
  t.run(SHAMELESS, "tvSeries", "Shameless", 2011, 338017);
  const p = db.query("insert into person (nconst, name, birth_year) values (?,?,?)");
  p.run(ROSSUM, "Emmy Rossum", 1986);
  p.run(WHITE, "Jeremy Allen White", 1991);
  return db;
}

const db = index();
afterAll(() => db.close());

/** A trace entry whose evidence is derived from the payload, exactly as the runner does it. */
function call(name: string, args: Record<string, unknown>, payload: unknown): ToolTrace {
  return { name, args, ms: 1, bytes: JSON.stringify(payload).length, evidence: evidenceFrom(name, payload) };
}

function runOf(answer: string, toolCalls: ToolTrace[]): RunResult {
  return {
    answer,
    turns: toolCalls.length + 1,
    toolCalls,
    ms: 1000,
    promptTokens: 100,
    completionTokens: 10,
    cachedTokens: 0,
    costUsd: 0.0001,
  };
}

const resolveBoth: ToolTrace[] = [
  call("find_title", { name: "Furious" }, { searched: "Furious", found: [{ tconst: FURIOUS }] }),
  call("find_title", { name: "The Bear" }, { searched: "The Bear", found: [{ tconst: BEAR }] }),
];

const CASE: Scenario = {
  id: "T-join",
  tier: "advanced",
  question: "Is anybody from The Bear also in Furious?",
  expect: [ROSSUM],
  expectJoin: [[FURIOUS, BEAR]],
  expectTools: ["find_connections"],
  mustResolve: ["Furious", "The Bear"],
};

describe("a join no tool returned", () => {
  /*
    The failure verbatim. Two separate list_cast calls, then a sentence asserting an overlap
    that does not exist. Note what passes: both titles were resolved, and the answer names
    only people the tools returned. Every noun-level check is satisfied.
  */
  const eyeballed = runOf("Yes -- Emmy Rossum from Furious and actors from The Bear appear together.", [
    ...resolveBoth,
    call("list_cast", { tconst: [FURIOUS] }, [
      { nconst: ROSSUM, name: "Emmy Rossum", billing: 1, role: "actress", seen_in: [FURIOUS] },
    ]),
    call("list_cast", { tconst: [BEAR] }, [
      { nconst: WHITE, name: "Jeremy Allen White", billing: 1, role: "actor", seen_in: [BEAR] },
    ]),
  ]);

  test("is RED, and that is the whole point of the field", () => {
    expect(grade(db, CASE, eyeballed).correct).toBe(false);
  });

  test("the reason says the link was inferred rather than looked up", () => {
    const g = grade(db, CASE, eyeballed);
    expect(g.inferredJoins).toHaveLength(1);
    expect(g.reasons.join(" ")).toContain("inferred by comparing results");
  });

  test("every OTHER check passed, which is why nothing caught this before", () => {
    const g = grade(db, CASE, eyeballed);
    expect(g.missing).toEqual([]);
    expect(g.unresolved).toEqual([]);
  });
});

describe("a join a tool actually returned", () => {
  const looked = runOf(
    "Nobody is in both. Emmy Rossum links them: she was in Shameless with Jeremy Allen White of The Bear.",
    [
      ...resolveBoth,
      call(
        "find_connections",
        { from: FURIOUS, to: BEAR },
        {
          paths: [
            {
              path: [
                { id: FURIOUS, name: "Furious", kind: "title" },
                { id: ROSSUM, name: "Emmy Rossum", kind: "person" },
                { id: SHAMELESS, name: "Shameless", kind: "title" },
                { id: WHITE, name: "Jeremy Allen White", kind: "person" },
                { id: BEAR, name: "The Bear", kind: "title" },
              ],
              strength: 338017,
            },
          ],
          spent: 12,
          status: "complete",
        },
      ),
    ],
  );

  test("is green on both verdicts", () => {
    const g = grade(db, CASE, looked);
    expect(g.correct).toBe(true);
    expect(g.efficient).toBe(true);
  });
});

describe("correctness and route are separate scores", () => {
  /*
    The gemini-3.8-flash shape, 2026-09-04: the right answer by a route the case author did
    not predict. Under the old grader this was scored FAILED, which is a benchmark lying
    about the thing it exists to measure.
  */
  const otherRoute = runOf("Nobody is in both. Emmy Rossum connects them through Shameless.", [
    ...resolveBoth,
    call("list_cast", { tconst: [FURIOUS, BEAR], mode: "intersection" }, []),
    call("list_credits", { nconst: [ROSSUM, WHITE], mode: "intersection" }, [
      {
        tconst: SHAMELESS,
        title: "Shameless",
        year: 2011,
        kind: "tvSeries",
        votes: 1,
        role: "actor",
        seen_with: [ROSSUM, WHITE],
      },
    ]),
    call(
      "find_connections",
      { from: FURIOUS, to: BEAR },
      {
        paths: [
          {
            path: [
              { id: FURIOUS, name: "Furious", kind: "title" },
              { id: ROSSUM, name: "Emmy Rossum", kind: "person" },
              { id: BEAR, name: "The Bear", kind: "title" },
            ],
            strength: 1,
          },
        ],
        spent: 40,
        status: "complete",
      },
    ),
  ]);

  test("a right answer by an unexpected route is CORRECT", () => {
    // No find_connections in this case's expectations, so the route note fires and the
    // answer still stands. That split is the fix.
    const routeCase: Scenario = { ...CASE, expectTools: ["get_person"] };
    const g = grade(db, routeCase, otherRoute);
    expect(g.correct).toBe(true);
    expect(g.efficient).toBe(false);
    expect(g.routeNotes).toEqual(["never called get_person"]);
  });

  test("a missing expected tool never lands in the correctness reasons", () => {
    const routeCase: Scenario = { ...CASE, expectTools: ["get_person"] };
    expect(grade(db, routeCase, otherRoute).reasons).toEqual([]);
  });
});

describe("the shipped S13 case", () => {
  test("declares the join that the measured failure fabricated", () => {
    const s = SCENARIOS.find((x) => x.id === "S13-inferred-join");
    expect(s?.expectJoin).toEqual([[FURIOUS, BEAR]]);
  });
});
