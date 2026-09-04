/**
 * The eval set, and the grader.
 *
 * > [!IMPORTANT] Grading is on IDS, never on prose, and never by a second model
 * > An LLM judge is a second thing to be wrong, it costs money per case, and it makes a
 * > regression indistinguishable from the judge having a bad day. Every case here either
 * > names the exact `tt…`/`nm…` that must appear in the answer, or asserts which TOOL the
 * > agent had to reach for. Both are exact, free, and stable across runs.
 * >
 * > The trick that makes id-grading work against prose: the grader resolves each expected id
 * > back to its NAME through the same index the agent read, and looks for that. A model
 * > writes "Emmy Rossum", not "nm0002536", and both are the same assertion.
 *
 * > [!IMPORTANT] CORRECTNESS AND ROUTE ARE TWO SCORES, AND MERGING THEM WAS A BUG
 * > `expectTools` used to sit inside the pass/fail verdict, which made A STRATEGY into a
 * > correctness condition. Measured 2026-09-04: a `gemini-3.8-flash` run produced the right
 * > answer by a different route and was scored FAILED. That is a benchmark lying about the
 * > thing it exists to measure -- and the lie points the wrong way, because it would reject a
 * > model that found a better path than the one the case author imagined.
 * >
 * > So there are two verdicts and they answer different questions. **`correct`** -- is the
 * > answer true, and is it backed by what the tools actually returned. **`efficient`** -- did
 * > it get there the cheap way. A model may be correct and wasteful; that is a real and
 * > useful state, and it is worth knowing separately from being wrong. Only `correct`
 * > decides the exit code.
 *
 * What each field checks, and which verdict it lands in:
 *
 * - `expect` (correct) -- the answer must name these. Getting the question right.
 * - `forbid` (correct) -- the answer must NOT name these. Usually a plausible wrong answer a
 *   model reaching for its weights instead of the index will produce.
 * - `mustResolve` (correct) -- these proper nouns must have reached a RESOLVER before the
 *   answer. An answer that happens to be right because the model remembered it is not a
 *   pass, because the next one will be wrong. Evidence, not efficiency.
 * - `expectJoin` (correct) -- a CONNECTION the answer rests on must have been returned by a
 *   tool rather than inferred by comparing results. See below.
 * - `expectTools` (efficient) -- the route. Never a correctness condition again.
 */

import type { Database } from "bun:sqlite";
import { hasJoin } from "./evidence.js";
import type { RunResult } from "./runner.js";

export interface Scenario {
  id: string;
  /** `simple` is one or two hops; `advanced` needs a join or a fan-out. */
  tier: "simple" | "advanced";
  question: string;
  /** Ids whose names must appear in the answer. */
  expect?: string[];
  /** Ids whose names must NOT appear -- the plausible wrong answer. */
  forbid?: string[];
  /**
   * Tools that must have been called at least once. THE ROUTE, never the correctness.
   *
   * A model that answers correctly without these is `correct` and not `efficient`, which is
   * a state worth reporting rather than a failure worth hiding.
   */
  expectTools?: string[];
  /** Names the agent must have passed to find_title / find_person before answering. */
  mustResolve?: string[];
  /**
   * Connections a correct answer to this question rests on.
   *
   * Some tool result in the run must have RETURNED the relation between each pair -- one
   * result carrying both ends. Comparing two results by eye does not count and cannot count,
   * which is the entire point: see `./evidence.ts` for what a tool establishes and what it
   * does not, and for the measured failure that bought this field.
   */
  expectJoin?: [string, string][];
  /** Why this case exists, when that is not obvious. */
  note?: string;
}

export const SCENARIOS: Scenario[] = [
  {
    id: "S1-cast-of-a-show",
    tier: "simple",
    question: "Who's in that show Furious?",
    expect: ["nm0002536"],
    expectTools: ["find_title", "list_cast"],
    mustResolve: ["Furious"],
    note:
      "The control case for the whole harness. `Furious` premiered July 2026 and is in the " +
      "index; a model answering from weights will say no such show exists.",
  },
  {
    id: "S2-title-details",
    tier: "simple",
    question: "What year did The Bear start, and has it ended?",
    expect: ["tt14452776"],
    expectTools: ["find_title"],
    mustResolve: ["The Bear"],
  },
  {
    id: "S3-person-filmography",
    tier: "simple",
    question: "What are the best-known things Brad Pitt has been in?",
    expect: ["nm0000093"],
    expectTools: ["find_person"],
    mustResolve: ["Brad Pitt"],
  },
  {
    id: "S4-recent-work",
    tier: "simple",
    question: "Has Emmy Rossum been in anything new, say 2025 or later?",
    expect: ["tt36303968"],
    expectTools: ["find_person", "list_credits"],
    mustResolve: ["Emmy Rossum"],
    note: "Recency is the one thing a daily-rebuilt index is reliably right about and weights are not.",
  },
  {
    id: "S5-browse-no-anchor",
    tier: "simple",
    question: "Suggest some good sci-fi films from the 1980s.",
    expectTools: ["browse_titles"],
    note:
      "No proper noun at all, so nothing to resolve. The only failure that matters here is " +
      "answering from memory without calling browse_titles.",
  },
  {
    id: "S6-navigate",
    tier: "simple",
    question: "Open the page for Al Pacino.",
    expectTools: ["find_person", "navigate"],
    mustResolve: ["Al Pacino"],
  },
  {
    id: "S7-not-in-index",
    tier: "simple",
    question: "Tell me about the show Zbrlqx Vandermolen.",
    forbid: ["tt14452776"],
    expectTools: ["find_title"],
    note:
      "A title that cannot exist. The pass condition is an honest 'not in the index' -- this " +
      "is the case that catches a model that invents a plausible answer rather than refusing.",
  },
  {
    id: "S8-the-furious-query",
    tier: "advanced",
    question:
      "Who is that actor that's in that show Furious and that show that the actor from The Bear is also in?",
    expect: ["nm0002536"],
    expectTools: ["find_connections"],
    mustResolve: ["Furious", "The Bear"],
    note:
      "The motivating case, verbatim as it was asked. The answer is Emmy Rossum via " +
      "Shameless and Jeremy Allen White. Two other true-but-weaker paths exist, so this also " +
      "tests whether the ranking is being respected.",
  },
  {
    id: "S9-intersection",
    tier: "advanced",
    question: "What films have Al Pacino and Robert De Niro both been in?",
    expect: ["tt0113277"],
    expectTools: ["find_person", "list_credits"],
    mustResolve: ["Al Pacino", "Robert De Niro"],
    note: "Heat. Should cost one list_credits with mode:'intersection', not two unions merged by hand.",
  },
  {
    id: "S10-two-show-anchored-people",
    tier: "advanced",
    question: "Is there anything connecting Severance and Yellowjackets?",
    expectTools: ["find_connections"],
    mustResolve: ["Severance", "Yellowjackets"],
  },
  {
    id: "S11-collaborators",
    tier: "advanced",
    question: "Which people does Christopher Nolan keep working with?",
    expect: ["nm0634240"],
    expectTools: ["find_person", "get_person"],
    mustResolve: ["Christopher Nolan"],
  },
  {
    id: "S12-misspelled",
    tier: "advanced",
    question: "who was in that movie sicaro with benicio del toro",
    expect: ["tt3397884"],
    expectTools: ["find_title"],
    note:
      "A human's typing. The agent should either pass match:'loose' or recover from a " +
      "loose_would_match hint. Failing by concluding the film does not exist is the bug.",
  },
  {
    id: "S13-inferred-join",
    tier: "advanced",
    question:
      "Is anybody from The Bear also in Furious? If they are not directly linked, tell me who connects them.",
    expect: ["nm0002536", "tt1586680"],
    expectJoin: [["tt36303968", "tt14452776"]],
    expectTools: ["find_connections"],
    mustResolve: ["Furious", "The Bear"],
    note:
      "THE FABRICATED-JOIN CASE, and it is red for a reason no other case here can catch. " +
      "Verified against the index: the two shows share NOBODY, and the link is Emmy Rossum " +
      "-> Shameless -> Jeremy Allen White -> The Bear. Measured 2026-09-04, claude-haiku-4.5 " +
      "resolved both titles, pulled both cast lists with two separate list_cast calls, and " +
      "asserted that actors from The Bear appear in Furious. Every NOUN in that answer came " +
      "from a tool, so `mustResolve` passed and the answer was still false. `expectJoin` is " +
      "what fails it: no single result ever carried both ids, so the connection the answer " +
      "states was inferred rather than looked up.",
  },
];

export interface Grade {
  /** Was the ANSWER right, and backed by what the tools returned. Owns the exit code. */
  correct: boolean;
  /** Did it take the route the case expects. A measurement, never a failure. */
  efficient: boolean;
  /** Why `correct` is false. */
  reasons: string[];
  /** Why `efficient` is false. Kept apart so a wasteful right answer reads as one. */
  routeNotes: string[];
  /** Every expected id whose name did NOT appear. */
  missing: string[];
  /** Names asserted without ever being resolved. */
  unresolved: string[];
  /** Connections the answer needs that no single tool result ever returned. */
  inferredJoins: string[];
}

/** The resolver calls, as a set of the names that were passed to them. */
function resolvedNames(result: RunResult): string[] {
  return result.toolCalls
    .filter((c) => c.name === "find_title" || c.name === "find_person")
    .map((c) => String(c.args.name ?? ""))
    .filter(Boolean);
}

function nameOf(db: Database, id: string): string | null {
  if (id.startsWith("tt")) {
    const r = db.query("select title from title where tconst = ?").get(id) as { title: string } | undefined;
    return r?.title ?? null;
  }
  const r = db.query("select name from person where nconst = ?").get(id) as { name: string } | undefined;
  return r?.name ?? null;
}

/** Loose containment: a model writes prose, so compare on folded text. */
function mentions(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Every relation any tool result returned, across the whole run.
 *
 * Flattened from the per-call evidence rather than recomputed, because the payloads are
 * gone by the time grading happens -- the trace is the only surviving record of what the
 * tools said, as opposed to what the model wrote afterwards.
 */
function returnedJoins(result: RunResult): Set<string> {
  const out = new Set<string>();
  for (const call of result.toolCalls) for (const j of call.evidence.joins) out.add(j);
  return out;
}

export function grade(db: Database, scenario: Scenario, result: RunResult): Grade {
  const reasons: string[] = [];
  const routeNotes: string[] = [];
  const missing: string[] = [];
  const unresolved: string[] = [];
  const inferredJoins: string[] = [];

  if (result.failure) {
    reasons.push(`run did not complete: ${result.failure}${result.error ? ` -- ${result.error}` : ""}`);
  }

  const answer = result.answer ?? "";

  for (const id of scenario.expect ?? []) {
    const name = nameOf(db, id);
    if (!name) {
      reasons.push(`expected id ${id} is not in this index -- the CASE is wrong, not the model`);
      continue;
    }
    // The id itself counts too: an agent that cites ids is being more precise, not less.
    if (!mentions(answer, name) && !mentions(answer, id)) {
      missing.push(`${id} (${name})`);
    }
  }
  if (missing.length > 0) reasons.push(`answer never names: ${missing.join(", ")}`);

  for (const id of scenario.forbid ?? []) {
    const name = nameOf(db, id);
    if (name && mentions(answer, name)) reasons.push(`answer names a forbidden result: ${name}`);
  }

  const called = new Set(result.toolCalls.map((c) => c.name));
  // ROUTE, not correctness. A different path to a true answer is a different path, and the
  // case author does not get to call it wrong -- see the note at the top of this file.
  for (const tool of scenario.expectTools ?? []) {
    if (!called.has(tool)) routeNotes.push(`never called ${tool}`);
  }

  const resolved = resolvedNames(result);
  for (const noun of scenario.mustResolve ?? []) {
    // The agent may correct a misspelling on the way, so match either direction.
    const hit = resolved.some((r) => mentions(r, noun) || mentions(noun, r));
    if (!hit) unresolved.push(noun);
  }
  if (unresolved.length > 0) {
    reasons.push(`asserted without resolving: ${unresolved.join(", ")} -- answered from memory`);
  }

  /*
    The join check, and it is graded on the TRACE rather than on the prose.

    There is no attempt to detect the sentence that states the connection, because that is
    prose parsing and it is exactly what the "grade on ids, never by a second model" rule
    forbids. The question asked instead is one the trace answers exactly: could this answer
    have been backed at all? If no single tool result carried both ends, then whatever the
    model wrote about these two, it did not read it anywhere -- and a case only carries
    `expectJoin` when a correct answer must rest on that link.
  */
  const joins = returnedJoins(result);
  for (const [a, b] of scenario.expectJoin ?? []) {
    if (hasJoin(joins, a, b)) continue;
    const an = nameOf(db, a) ?? a;
    const bn = nameOf(db, b) ?? b;
    inferredJoins.push(`${an} (${a}) -- ${bn} (${b})`);
  }
  if (inferredJoins.length > 0) {
    reasons.push(
      `no tool result ever returned the connection ${inferredJoins.join("; ")} -- any link the ` +
        "answer states was inferred by comparing results, not looked up",
    );
  }

  return {
    correct: reasons.length === 0,
    efficient: routeNotes.length === 0,
    reasons,
    routeNotes,
    missing,
    unresolved,
    inferredJoins,
  };
}
