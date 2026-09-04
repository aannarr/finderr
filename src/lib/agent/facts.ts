/**
 * Turning a tool result into the FACTS it established, deterministically.
 *
 * The transcript a model re-reads on turn five is mostly JSON it has already understood,
 * with every key repeated on every row. Measured on the harness: the fixed prefix is 2,362
 * tokens re-sent per turn, and on top of that every previous tool result is re-sent in full.
 * Compaction replaces those results with the handful of facts they carried.
 *
 * **This is a quality change before it is a cost change, and there is evidence.** On the
 * motivating query `gemini-3.8-flash` called `find_title -> find_title -> get_title ->
 * list_cast -> find_title -> list_cast -> list_cast`: it RE-RESOLVED a title it had already
 * resolved, because the id was buried four JSON blobs back. A ledger puts every id it has
 * learned on one line, once, at the front.
 *
 * > [!IMPORTANT] Distillation happens HERE, in typed code, and never by asking a model
 * > A model-written summary costs a call, adds a turn of latency, and can silently drop the
 * > one fact needed three turns later -- and nothing would catch it, because a plausible
 * > summary of a cast list looks exactly like a correct one. These functions read the tools'
 * > own return types, so what survives is a decision made once, in the open, and pinned by
 * > tests.
 *
 * The formats below are TERSE ON PURPOSE. `{"nconst":"nm0002536","name":"Emmy Rossum",
 * "role":"actress","billing":1,"seen_in":["tt36303968"]}` is 95 characters that say what
 * `nm0002536 Emmy Rossum (actress, billed 1)` says in 41.
 */

import type { ConnectionPath, FindConnectionsResult } from "./connections.js";
import type { CastRow, CreditRow, PersonRef, TitleRef } from "./tools.js";

/** One line per fact, in the order it was learned. */
export type Facts = string[];

function titleLine(t: TitleRef): string {
  const bits = [t.kind, t.year === null ? "year unknown" : String(t.year)];
  if (t.end_year) bits.push(`ended ${t.end_year}`);
  if (t.orig) bits.push(`orig "${t.orig}"`);
  return `${t.tconst} = "${t.title}" (${bits.join(", ")}, ${t.votes} votes)`;
}

function personLine(p: PersonRef): string {
  const born = p.birth_year ? `b.${p.birth_year}` : "birth unknown";
  const died = p.death_year ? `, d.${p.death_year}` : "";
  return `${p.nconst} = "${p.name}" (${born}${died})`;
}

function pathLine(p: ConnectionPath): string {
  return `  ${p.path.map((n) => `${n.name} [${n.id}]`).join(" -> ")}  (strength ${p.strength})`;
}

/**
 * What one tool call established, as lines a model can read at a glance.
 *
 * An ERROR is passed through nearly verbatim, which is the one place terseness would cost
 * something: the refusals are written to teach the caller which resolver to reach for, and a
 * compacted "it failed" throws away the instruction that makes the retry work.
 */
export function factsFrom(tool: string, args: Record<string, unknown>, result: unknown): Facts {
  if (result && typeof result === "object" && "error" in result) {
    return [`${tool} FAILED: ${String((result as { error: unknown }).error)}`];
  }

  switch (tool) {
    case "find_title": {
      const r = result as { found: TitleRef[]; searched: string; loose_would_match?: number };
      if (r.found.length === 0) {
        return r.loose_would_match
          ? [
              `find_title("${r.searched}") found nothing at this match setting, but ${r.loose_would_match} ` +
                `would match with match:"loose" -- RETRY before concluding it does not exist.`,
            ]
          : [`find_title("${r.searched}") found nothing. It is not in the index.`];
      }
      return [`find_title("${r.searched}") ->`, ...r.found.map((t) => `  ${titleLine(t)}`)];
    }

    case "find_person": {
      const r = result as {
        found: PersonRef[];
        searched: string;
        loose_would_match?: number;
        unavailable?: string;
      };
      if (r.unavailable) return [`find_person("${r.searched}") unavailable: ${r.unavailable}`];
      if (r.found.length === 0) {
        return r.loose_would_match
          ? [
              `find_person("${r.searched}") found nothing; ${r.loose_would_match} would match with match:"loose".`,
            ]
          : [`find_person("${r.searched}") found nothing. Not in the index.`];
      }
      return [`find_person("${r.searched}") ->`, ...r.found.map((p) => `  ${personLine(p)}`)];
    }

    case "list_cast": {
      const rows = result as CastRow[];
      const ids = (args.tconst as string[] | undefined)?.join(", ") ?? "?";
      const mode = args.mode === "intersection" ? " (people in ALL of them)" : "";
      if (rows.length === 0) return [`list_cast([${ids}])${mode} -> nobody.`];
      return [
        `list_cast([${ids}])${mode} ->`,
        ...rows.map(
          (r) => `  ${r.nconst} "${r.name}" (${r.role}, billed ${r.billing}) in ${r.seen_in.join("+")}`,
        ),
      ];
    }

    case "list_credits": {
      const rows = result as CreditRow[];
      const ids = (args.nconst as string[] | undefined)?.join(", ") ?? "?";
      const mode = args.mode === "intersection" ? " (titles ALL of them are in)" : "";
      if (rows.length === 0) return [`list_credits([${ids}])${mode} -> nothing.`];
      return [
        `list_credits([${ids}])${mode} ->`,
        ...rows.map(
          (r) =>
            `  ${r.tconst} "${r.title}" (${r.kind} ${r.year ?? "?"}) as ${r.role} [${r.seen_with.join("+")}]`,
        ),
      ];
    }

    case "get_title": {
      const t = result as (TitleRef & { genres?: string[] }) | null;
      if (!t) return ["get_title -> no such id."];
      return [`${titleLine(t)}${t.genres?.length ? ` genres: ${t.genres.join("/")}` : ""}`];
    }

    case "get_person": {
      const p = result as {
        nconst: string;
        name: string;
        credit_count: number;
        top_credits: TitleRef[];
        collaborators: { nconst: string; name: string; shared: number }[];
      } | null;
      if (!p) return ["get_person -> no such id."];
      const out = [`${p.nconst} "${p.name}" -- ${p.credit_count} credits`];
      if (p.top_credits.length) {
        out.push(
          `  best known: ${p.top_credits.map((t) => `"${t.title}" (${t.year ?? "?"}) ${t.tconst}`).join("; ")}`,
        );
      }
      if (p.collaborators.length) {
        out.push(
          `  works often with: ${p.collaborators.map((c) => `${c.name} [${c.nconst}] x${c.shared}`).join("; ")}`,
        );
      }
      return out;
    }

    case "browse_titles": {
      const r = result as {
        titles: TitleRef[];
        total: number;
        hidden_by_floor?: { titles: number; min_votes: number };
      };
      const filters = JSON.stringify(args);
      if (r.hidden_by_floor) {
        return [
          `browse_titles(${filters}) -> 0 shown, but ${r.hidden_by_floor.titles} exist below our own ` +
            `${r.hidden_by_floor.min_votes}-vote floor. RETRY with min_votes:0 -- do not report that nothing matches.`,
        ];
      }
      return [
        `browse_titles(${filters}) -> ${r.total} total, top:`,
        ...r.titles.map((t) => `  ${t.tconst} "${t.title}" (${t.year ?? "?"}) ${t.votes} votes`),
      ];
    }

    case "find_connections": {
      const r = result as FindConnectionsResult;
      const head = `find_connections(${String(args.from)} -> ${String(args.to)}) status=${r.status}, ${r.spent} lookups`;
      if (r.paths.length === 0) {
        return r.status === "complete"
          ? [`${head}: genuinely no connection within the hop limit.`]
          : [
              `${head}: NO PATHS FOUND YET -- we ran out of budget, this does NOT mean they are ` +
                `unconnected. Call again with resume:"${r.resume ?? ""}" to continue.`,
            ];
      }
      return [`${head}, best paths:`, ...r.paths.map(pathLine)];
    }

    case "navigate": {
      const r = result as { ok: boolean; path?: string; error?: string };
      return [r.ok ? `navigate -> opened ${r.path}` : `navigate refused: ${r.error}`];
    }

    default:
      return [`${tool} -> ${JSON.stringify(result).slice(0, 300)}`];
  }
}

/** A one-line signature of a call, so the ledger can forbid repeating it. */
export function callSignature(tool: string, args: Record<string, unknown>): string {
  const parts = Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v.join(",")}]` : JSON.stringify(v)}`);
  return `${tool}(${parts.join(", ")})`;
}

/**
 * The ledger message that replaces every collapsed turn.
 *
 * The `ALREADY CALLED` list is not decoration -- it is the direct fix for the re-resolution
 * seen in the benchmark. Under compaction the model is not shown its own earlier tool_calls
 * at all, so without this it has no way to know it has already asked.
 */
export function ledgerMessage(facts: Facts, calls: string[]): string {
  const lines = [
    "FACTS ESTABLISHED SO FAR (from tools you already ran -- treat these as verified):",
    ...facts,
  ];
  if (calls.length > 0) {
    lines.push(
      "",
      "CALLS ALREADY MADE -- do not repeat any of these, the answer is above:",
      ...calls.map((c) => `  ${c}`),
    );
  }
  lines.push("", "Continue from these facts. Call another tool only if you still need something not listed.");
  return lines.join("\n");
}
