/**
 * What the tools actually RETURNED -- the entities, and the relations between them.
 *
 * `facts.ts` reads the same payloads and renders them as prose for the model to re-read.
 * This file reads them for a different consumer and produces a different thing: a set of
 * pairs, so a grader (and later the transcript decorator) can ask a mechanical question --
 * **did any tool result actually contain this connection, or did the model infer it?**
 *
 * > [!IMPORTANT] A CONNECTION IS EVIDENCE ONLY WHEN ONE RESULT CARRIED BOTH ENDS
 * > This is the whole distinction the file exists for, and it is the difference between a
 * > lookup and a guess. Measured 2026-09-04: `claude-haiku-4.5` resolved two titles
 * > correctly, pulled BOTH cast lists with two separate `list_cast` calls, and then asserted
 * > that actors from *The Bear* appear in *Furious*. They do not; the link runs through
 * > *Shameless*. Every entity in that answer came from a tool and the answer was still false,
 * > because the JOIN came from comparing two lists by eye.
 * >
 * > So two `list_cast` calls, one title each, establish nothing between those titles: each
 * > row's `seen_in` names one id. ONE `list_cast` over both titles that returns a row with
 * > both ids in `seen_in` is the database itself asserting the overlap, and that counts. The
 * > shape of the call is what makes the difference, which is exactly why this cannot be
 * > checked by reading the answer.
 *
 * Pairs are UNORDERED -- `joinKey` sorts them -- because "A worked with B" and "B worked
 * with A" are one fact and storing both directions would double every set for nothing.
 */

import type { ConnectionPath, FindConnectionsResult } from "./connections.js";
import type { CastRow, CreditRow, PersonRef, TitleRef } from "./tools.js";

export interface Evidence {
  /** Every `tt…`/`nm…` the result named. */
  ids: string[];
  /** Every relation the result asserted, as `joinKey` strings. */
  joins: string[];
}

const EMPTY: Evidence = { ids: [], joins: [] };

/** The canonical, direction-free key for a relation between two entities. */
export function joinKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Whether anything in `joins` established a relation between these two. */
export function hasJoin(joins: Iterable<string>, a: string, b: string): boolean {
  const wanted = joinKey(a, b);
  for (const j of joins) if (j === wanted) return true;
  return false;
}

/** Every unordered pair drawn from one list. Self-pairs are not relations and are skipped. */
function pairs(ids: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i];
      const b = ids[j];
      if (a && b && a !== b) out.push(joinKey(a, b));
    }
  }
  return out;
}

/** One entity related to each of several others. */
function fan(one: string, many: readonly string[]): string[] {
  return many.filter((m) => m && m !== one).map((m) => joinKey(one, m));
}

/**
 * Every node on a returned path is connected to every other node ON THAT PATH.
 *
 * All pairs rather than only adjacent ones, because the endpoints are the answer: a path
 * `Furious -> Emmy Rossum -> Shameless -> Jeremy Allen White -> The Bear` is the tool
 * stating that those two shows ARE connected, and grading only the adjacent hops would
 * refuse to count the one claim the caller asked about.
 */
function pathJoins(p: ConnectionPath): string[] {
  return pairs(p.path.map((n) => n.id));
}

/**
 * What one tool call established.
 *
 * A result carrying an `error` establishes nothing, and saying so explicitly matters: a
 * refusal that names the right resolver still teaches the model something, but it is not
 * evidence about the world and must never be counted as any.
 *
 * The ARGUMENTS are deliberately absent, unlike `factsFrom` which takes them to render the
 * call back to the model. What was asked for is not evidence: `list_cast([a, b])` is a
 * question about two titles and says nothing about whether they share anybody. Only the
 * returned rows can answer that.
 */
export function evidenceFrom(tool: string, result: unknown): Evidence {
  if (!result || typeof result !== "object") return EMPTY;
  if ("error" in result) return EMPTY;

  switch (tool) {
    case "find_title": {
      const r = result as { found?: TitleRef[] };
      return { ids: (r.found ?? []).map((t) => t.tconst), joins: [] };
    }

    case "find_person": {
      // `known_for` is opt-in (fields:['known_for']) and when present it IS a relation the
      // index returned -- the same fact `list_credits` would have cost a second call for.
      const r = result as { found?: (PersonRef & { known_for?: { tconst: string }[] })[] };
      const ids: string[] = [];
      const joins: string[] = [];
      for (const p of r.found ?? []) {
        ids.push(p.nconst);
        const credits = (p.known_for ?? []).map((k) => k.tconst);
        ids.push(...credits);
        joins.push(...fan(p.nconst, credits));
      }
      return { ids, joins };
    }

    case "list_cast": {
      const rows = (Array.isArray(result) ? result : []) as CastRow[];
      const ids: string[] = [];
      const joins: string[] = [];
      for (const r of rows) {
        ids.push(r.nconst, ...r.seen_in);
        joins.push(...fan(r.nconst, r.seen_in));
        // The titles this ONE person was returned in are joined to each other. A row whose
        // `seen_in` names two ids is the database asserting the overlap; a row naming one
        // asserts nothing between titles, which is the eyeball case this whole file guards.
        joins.push(...pairs(r.seen_in));
      }
      return { ids, joins };
    }

    case "list_credits": {
      const rows = (Array.isArray(result) ? result : []) as CreditRow[];
      const ids: string[] = [];
      const joins: string[] = [];
      for (const r of rows) {
        ids.push(r.tconst, ...r.seen_with);
        joins.push(...fan(r.tconst, r.seen_with));
        joins.push(...pairs(r.seen_with));
      }
      return { ids, joins };
    }

    case "get_title": {
      const t = result as TitleRef;
      return t.tconst ? { ids: [t.tconst], joins: [] } : EMPTY;
    }

    case "get_person": {
      const p = result as {
        nconst?: string;
        top_credits?: TitleRef[];
        collaborators?: { nconst: string }[];
      };
      if (!p.nconst) return EMPTY;
      const credits = (p.top_credits ?? []).map((t) => t.tconst);
      const mates = (p.collaborators ?? []).map((c) => c.nconst);
      return {
        ids: [p.nconst, ...credits, ...mates],
        // `collaborators` is "worked with N times", which is a person-to-person relation the
        // index computed. It is the honest answer to "who does this director keep using".
        joins: [...fan(p.nconst, credits), ...fan(p.nconst, mates)],
      };
    }

    case "browse_titles": {
      const r = result as { titles?: TitleRef[] };
      return { ids: (r.titles ?? []).map((t) => t.tconst), joins: [] };
    }

    case "find_connections": {
      const r = result as FindConnectionsResult;
      const ids: string[] = [];
      const joins: string[] = [];
      for (const p of r.paths ?? []) {
        ids.push(...p.path.map((n) => n.id));
        joins.push(...pathJoins(p));
      }
      // A call that returned NO path establishes nothing, and that is the point of `status`:
      // `budget_exhausted` means we stopped looking, not that the two are unrelated.
      return { ids, joins };
    }

    default:
      return EMPTY;
  }
}
