/**
 * The tool schemas as a model meets them, plus the dispatcher that runs them.
 *
 * Two rules govern every `description` here and they are worth stating once rather than
 * being re-derived per tool:
 *
 * - **Open with the question it answers AND the one it does not.** A model routes on what a
 *   tool is FOR far more reliably than on a list of parameters.
 * - **State the cost in the model's own currency.** "<=20 rows, 1 of your calls" is
 *   actionable; "this is expensive" is not.
 *
 * The ordering rule is NOT in these strings, though -- it is in the types. Every tool past
 * the two resolvers takes `tt…`/`nm…` ids and nothing else, so calling `list_cast("Furious")`
 * is a schema violation rather than a bad idea. Descriptions are advice a confident model
 * talks past; a type is a wall. That distinction is the whole design.
 */

import type { Database } from "bun:sqlite";
import { findConnections, MemoryResumeStore, type ResumeStore } from "./connections.js";
import {
  type AgentContext,
  browseTitles,
  findPerson,
  findTitle,
  getPerson,
  getTitle,
  listCast,
  listCredits,
  navigate,
  TITLE_KINDS,
} from "./tools.js";

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const KIND_ENUM = { type: "string", enum: [...TITLE_KINDS] };

const MATCH = {
  type: "string",
  enum: ["exact", "strict", "loose"],
  description:
    "How much you trust the string, NOT how well you spell. 'strict' (default) if you " +
    "wrote the name yourself; 'loose' only when relaying a human's typing verbatim, which " +
    "enables the expensive typo tier; 'exact' when re-resolving a name a tool already gave you.",
};

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "find_title",
      description:
        "Which film or show is this NAME? Returns ids plus the metadata that tells two " +
        "candidates apart (year, kind, votes). Does NOT tell you who is in it (list_cast) " +
        "or whether we own it (get_title). YOU MUST CALL THIS BEFORE NAMING ANY TITLE IN " +
        "YOUR ANSWER -- your own memory of what exists is not evidence, and the index is " +
        "rebuilt daily so it knows about titles you do not. " +
        "Cost: <=20 rows, ~40 tokens each, 1 call. " +
        "If it returns found:[] with loose_would_match:N, N titles matched at a looser " +
        "setting -- retry with match:'loose' rather than concluding it does not exist.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The title as the user said it, however misspelled." },
          year: { type: "integer" },
          years: {
            type: "array",
            items: { type: "integer" },
            minItems: 2,
            maxItems: 2,
            description: "[from, to] inclusive. Use for 'recent' or 'from the 90s'.",
          },
          kind: {
            type: "array",
            items: KIND_ENUM,
            description:
              "IMDb's own four values; there is no 'short' and no plain 'series'. " +
              "A 'show' is ['tvSeries','tvMiniSeries'].",
          },
          match: MATCH,
          fields: {
            type: "array",
            items: { type: "string", enum: ["genres", "runtime", "rating"] },
            description:
              "Opt-in extras. 'runtime' IS FILM-ONLY -- for a series the column holds the " +
              "whole run for some titles and one episode for others, so never quote it for a show.",
          },
          limit: { type: "integer", description: "Default 5, max 20." },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_person",
      description:
        "Which person is this NAME? Returns ids plus birth/death year, which is what tells " +
        "two people of the same name apart. Does NOT tell you what they were in " +
        "(list_credits). Call this before naming any person in your answer. " +
        "Cost: <=20 rows, 1 call. Add fields:['known_for'] only if the birth year did not settle it.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          match: MATCH,
          fields: { type: "array", items: { type: "string", enum: ["known_for", "credit_count"] } },
          limit: { type: "integer", description: "Default 5, max 20." },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_cast",
      description:
        "Who is in these titles? Takes an ARRAY -- pass every title at once, never one call " +
        "each. mode:'intersection' returns only people in ALL of them, computed in the " +
        "database, which is far cheaper than reading a union and filtering it yourself. " +
        "TWO SEPARATE CALLS CANNOT ANSWER WHAT TWO TITLES SHARE -- a name appearing in both " +
        "results is your inference, not ours. Use mode:'intersection' here, or find_connections. " +
        "Rows carry 'billing' (IMDb order): when a user says 'the guy from X' they almost " +
        "always mean a low billing number. " +
        "Cost: limit is a TOTAL across all ids, default 20, max 50.",
      parameters: {
        type: "object",
        properties: {
          tconst: { type: "array", items: { type: "string" }, description: "tt… ids from find_title." },
          roles: {
            type: "array",
            items: { type: "string" },
            description: "IMDb categories, e.g. ['actor','actress'] or ['director'].",
          },
          mode: { type: "string", enum: ["union", "intersection"] },
          limit: { type: "integer" },
        },
        required: ["tconst"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_credits",
      description:
        "What have these people been in? The mirror of list_cast; takes an ARRAY. " +
        "mode:'intersection' answers 'what have A and B BOTH been in' in one call. " +
        "years:[2025,2026] is how you answer 'anything NEW by them' -- the index is rebuilt " +
        "daily, so this is authoritative about recent work in a way your memory is not. " +
        "Cost: limit is a TOTAL across all ids, default 20, max 50.",
      parameters: {
        type: "object",
        properties: {
          nconst: {
            type: "array",
            items: { type: "string" },
            description: "nm… ids from find_person or list_cast.",
          },
          kind: { type: "array", items: KIND_ENUM },
          years: { type: "array", items: { type: "integer" }, minItems: 2, maxItems: 2 },
          roles: { type: "array", items: { type: "string" } },
          mode: { type: "string", enum: ["union", "intersection"] },
          limit: { type: "integer" },
        },
        required: ["nconst"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_title",
      description:
        "Everything local about ONE title we already have the id for: genres, rating, " +
        "runtime, whether the run has ended. Does NOT do search -- use find_title for a name. " +
        "Cost: 1 row, 1 call.",
      parameters: {
        type: "object",
        properties: { tconst: { type: "string" } },
        required: ["tconst"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_person",
      description:
        "Everything local about ONE person we have the id for: top credits and frequent " +
        "collaborators. 'collaborators' answers 'who does this director keep working with'. " +
        "Cost: 1 call.",
      parameters: {
        type: "object",
        properties: { nconst: { type: "string" }, credits: { type: "integer" } },
        required: ["nconst"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browse_titles",
      description:
        "Find titles by CONSTRAINT when there is no name to look up -- 'good sci-fi from " +
        "the 80s', 'popular comedies'. This is the only tool that works without an id. " +
        "If it returns hidden_by_floor, a popularity threshold WE applied is what emptied " +
        "the page; re-run with min_votes:0 rather than reporting that nothing matches. " +
        "Cost: <=50 rows, 1 call.",
      parameters: {
        type: "object",
        properties: {
          genre: { type: "string", description: "A single IMDb genre, e.g. 'Sci-Fi', 'Comedy'." },
          kind: KIND_ENUM,
          year: { type: "integer" },
          decade: { type: "integer", description: "e.g. 1980 means the 1980s." },
          min_votes: { type: "integer" },
          sort: {
            type: "string",
            enum: ["votes", "rank"],
            description: "'rank' is the weighted best-of list.",
          },
          limit: { type: "integer" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_connections",
      description:
        "How are these two connected through who worked with whom? Answers 'the actor in X " +
        "who is also in a show that someone from Y is in' in ONE call. " +
        "IF YOU ARE ABOUT TO COMPARE TWO CAST LISTS YOURSELF, CALL THIS INSTEAD. Reading two " +
        "list_cast results and spotting a shared name is a guess, not a lookup: each of those " +
        "rows only says which of the titles YOU ASKED ABOUT that person was found in, so an " +
        "overlap you notice across two separate calls is not something the index told you. " +
        "This tool returns the join itself, as a path. " +
        "max_hops 1 means somebody was in both; 2 means somebody from one worked with " +
        "somebody from the other. " +
        "Cost: budget is a LOOKUP ceiling, default 100. " +
        "IF status IS 'budget_exhausted' THE TWO ARE NOT NECESSARILY UNCONNECTED -- we " +
        "stopped looking. Call again with the 'resume' handle and a fresh budget to continue.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "A tt… or nm… id." },
          to: { type: "string", description: "A tt… or nm… id." },
          max_hops: { type: "integer", enum: [1, 2] },
          budget: { type: "integer", description: "Max index lookups. Default 100, ceiling 1000." },
          limit: { type: "integer" },
          resume: { type: "string", description: "Opaque handle from a previous incomplete call." },
        },
        required: ["from", "to"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "navigate",
      description:
        "Open a page for the user. TERMINAL -- call it last, as the final action, never " +
        "while you are still working something out. Cost: free.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "A tt… or nm… id." } },
        required: ["id"],
      },
    },
  },
];

export type ToolName = (typeof TOOL_SCHEMAS)[number]["function"]["name"];

/**
 * Run one tool call.
 *
 * Every failure returns a value rather than throwing, and every message names the tool that
 * would fix it -- a refusal that teaches the ordering is the third mechanism holding the
 * tier discipline up, behind the types and the honest-empty rule.
 */
export function dispatch(
  ctx: AgentContext,
  store: ResumeStore,
  name: string,
  args: Record<string, unknown>,
): unknown {
  switch (name) {
    case "find_title":
      return findTitle(ctx, args as never);
    case "find_person":
      return findPerson(ctx, args as never);
    case "list_cast":
      return guardIds(args.tconst, "tt", "find_title") ?? listCast(ctx, args as never);
    case "list_credits":
      return guardIds(args.nconst, "nm", "find_person") ?? listCredits(ctx, args as never);
    case "get_title":
      return getTitle(ctx, String(args.tconst)) ?? { error: "No such title id. Use find_title." };
    case "get_person":
      return getPerson(ctx, String(args.nconst)) ?? { error: "No such person id. Use find_person." };
    case "browse_titles":
      return browseTitles(ctx, args as never);
    case "find_connections":
      return findConnections(ctx.db, args as never, store);
    case "navigate":
      return navigate(String(args.id));
    default:
      return { error: `Unknown tool ${name}` };
  }
}

/** The wall, enforced at the boundary as well as in the schema: ids only, never a name. */
function guardIds(value: unknown, prefix: "tt" | "nm", resolver: string): { error: string } | null {
  const list = Array.isArray(value) ? value : [value];
  const bad = list.filter((v) => typeof v !== "string" || !v.startsWith(prefix));
  if (bad.length === 0) return null;
  return {
    error:
      `Expected ${prefix}… ids, got ${JSON.stringify(bad)}. This tool never takes names -- ` +
      `call ${resolver} first and pass the ids it returns.`,
  };
}

export type { AgentContext, ResumeStore };
export { MemoryResumeStore };

export function makeContext(db: Database, engine: AgentContext["engine"]): AgentContext {
  return { db, engine };
}
