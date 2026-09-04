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
 * Three things are checked and they fail for different reasons:
 *
 * - `expect` -- the answer must name these. Getting the question right.
 * - `forbid` -- the answer must NOT name these. Usually a plausible wrong answer that a
 *   model reaching for its weights instead of the index will produce.
 * - `mustResolve` -- these proper nouns must have reached a RESOLVER before the answer.
 *   This is the discipline check, and it is the one that would have caught the failure the
 *   whole design is built around: an answer that happens to be right because the model
 *   remembered it is not a pass, because the next one will be wrong.
 */

import type { Database } from "bun:sqlite";
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
  /** Tools that must have been called at least once. */
  expectTools?: string[];
  /** Names the agent must have passed to find_title / find_person before answering. */
  mustResolve?: string[];
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
];

export interface Grade {
  pass: boolean;
  reasons: string[];
  /** Every expected id whose name did NOT appear. */
  missing: string[];
  /** Names asserted without ever being resolved. */
  unresolved: string[];
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

export function grade(db: Database, scenario: Scenario, result: RunResult): Grade {
  const reasons: string[] = [];
  const missing: string[] = [];
  const unresolved: string[] = [];

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
  for (const tool of scenario.expectTools ?? []) {
    if (!called.has(tool)) reasons.push(`never called ${tool}`);
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

  return { pass: reasons.length === 0, reasons, missing, unresolved };
}
