/**
 * The assistant's client half: the wire shapes, one POST, and one probe.
 *
 * Deliberately separate from `./api.ts`, which is the cached read path over the local
 * index. Nothing here is cached and nothing here should be: a chat turn is a side-effecting
 * call that costs real money upstream, and serving one from a cache would answer a new
 * question with an old answer.
 *
 * > [!IMPORTANT] The refusals are the interesting part of this file
 * > Four of the five outcomes are the server declining, and each means something different
 * > to the UI: 404 removes the feature entirely, 403 removes it for this reader, 402 is a
 * > budget that refills, 429 is a wait. Collapsing them into one `Error` message is how a
 * > "come back in a minute" ends up looking identical to "this was never installed", so
 * > every refusal is a discriminated `AgentRefusal` and the panel switches on the kind.
 */

import type { FacetProblem } from "./facets";

export interface AgentToolCall {
  /** The tool the model called. Shown verbatim -- it is our own vocabulary, not free text. */
  name: string;
  args: Record<string, unknown>;
  ms: number;
}

/**
 * Something the assistant tried to ask for -- and what came of it.
 *
 * > [!CAUTION] `queued` IS THE ONLY SUCCESS, and drawing this list as if it were all
 * > successes is a lie the reader cannot check
 * > `RequestOutcome` (`src/lib/agent/actions.ts`) reports five statuses, four of which mean
 * > NOTHING was downloaded: the library already had it, somebody already asked, the id did
 * > not resolve, or the arr refused. The first version of the panel printed "Started
 * > downloading 1 film" over every entry, which turns a refusal into a claim that disk and
 * > bandwidth were spent. `queuedOf`/`declinedOf` split them and the pane draws them
 * > differently.
 *
 * `status` is OPTIONAL because the contract this client was written against did not carry
 * it, and **absent counts as queued**: a server that reports only the things it actually
 * requested must not have them demoted to a footnote.
 */
export type RequestedStatus = "queued" | "already_have" | "already_requested" | "not_found" | "refused";

export interface AgentRequested {
  tconst: string;
  title: string;
  kind: "movie" | "series" | "episode";
  status?: RequestedStatus;
  /** Episode grain only -- both present or both absent. */
  season?: number;
  episode?: number;
}

/**
 * A title the answer named.
 *
 * NOT a `Title` from `./api.ts` -- it carries no library state, no request status and no
 * votes, because the assistant route builds it from what the model referred to rather than
 * from a decorated index row. So a card drawn from one of these links to the title page and
 * offers no Request button: the honest maximum for a row that cannot say whether we already
 * hold it.
 */
export interface AgentTitle {
  tconst: string;
  title: string;
  year: number | null;
  kind: string;
  /** Already a same-origin path. Still passed through `localImageUrl` before it is used. */
  poster: string | null;
}

export interface AgentEpisode {
  tconst: string;
  /** The series this belongs to, which is where the row links. */
  parent: string;
  season: number;
  number: number;
  title: string | null;
  /**
   * IMDb's score for this episode, or null.
   *
   * **`null` is not zero and must never render as one.** An unrated episode and an episode
   * the whole internet hated look identical the moment a `?? 0` gets written, and the second
   * is a claim we would be making up. `EpisodeRow` says "no score yet" instead.
   */
  rating: number | null;
}

export interface AgentUsage {
  costUsd: number;
  ms: number;
}

/**
 * One answer.
 *
 * > [!IMPORTANT] THREE FIELDS ARE OPTIONAL BECAUSE THE SERVER DOES NOT SEND THEM YET
 * > `ChatResponse` in `src/server/agent-chat.ts` carries `conversationId`, `answer`,
 * > `toolCalls`, `requested` and `usage` -- and nothing else. `titles`, `episodes` and
 * > `problems` were in the contract this client was written against and are not in the
 * > handler that shipped, so they are marked optional rather than trusted: a required field
 * > that arrives `undefined` is a type that lies, and the next person to write
 * > `answer.titles.map(...)` would find out in a browser rather than in `tsc`.
 * >
 * > Every renderer for them already returns `null` for an absent or empty list, so today's
 * > server degrades to prose plus the request outcomes with no gap and no error -- verified
 * > in a browser 2026-09-05. **Whether the server grows them or the client drops them is a
 * > decision, not a bug**, and it is the orchestrator's to take.
 */
export interface AgentAnswer {
  conversationId: string;
  answer: string;
  toolCalls: AgentToolCall[];
  requested: AgentRequested[];
  titles?: AgentTitle[];
  episodes?: AgentEpisode[];
  usage: AgentUsage;
  /**
   * Which addon failed while the assistant was working, by CODE.
   *
   * The same `{ pluginId, facet, reason }` the title page already receives, so it renders
   * through the same `problemNote` and the reader is told the same sentence in the same
   * words. The message stays in the server's log for the same reason it does there.
   */
  problems?: FacetProblem[];
}

/**
 * Why the server would not answer.
 *
 * `absent` and `forbidden` are terminal for the session -- there is nothing the reader can
 * do and no point drawing a launcher they cannot use. The other three are this turn only.
 */
export type AgentRefusal =
  /** 404: no assistant on this deployment. Not an error; the feature does not exist. */
  | { kind: "absent" }
  /** 403: the beta is admin-only and this reader is not one. */
  | { kind: "forbidden"; message: string }
  /** 402: the daily budget is spent. */
  | { kind: "over-limit"; message: string; remainingUsd: number; retryAfterSeconds: number }
  /** 429: too many turns too quickly. */
  | { kind: "rate-limited"; message: string }
  /** Anything else, including the network being gone. */
  | { kind: "error"; message: string };

/** Does this refusal mean the feature is gone for good, rather than for this turn? */
export function isTerminalRefusal(r: AgentRefusal): boolean {
  return r.kind === "absent" || r.kind === "forbidden";
}

/**
 * A refusal, thrown.
 *
 * An `Error` subclass rather than a returned union so a caller cannot forget to check --
 * every other client function in this tree throws on a bad status and the panel's `catch`
 * is where the handling already lives.
 */
export class AgentError extends Error {
  readonly refusal: AgentRefusal;
  constructor(refusal: AgentRefusal) {
    super(refusal.kind === "absent" ? "assistant not configured" : refusal.message);
    this.name = "AgentError";
    this.refusal = refusal;
  }
}

export const CHAT_PATH = "/api/agent/chat";

/**
 * Turn a refused response into the refusal it means.
 *
 * The body is read defensively at every step: a 402 from a proxy in front of us carries no
 * JSON at all, and a client that assumed the documented shape would throw a `SyntaxError`
 * inside its own error path and report the wrong thing entirely.
 */
export async function refusalOf(res: Response): Promise<AgentRefusal> {
  if (res.status === 404) return { kind: "absent" };
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    message?: string;
    remainingUsd?: number;
    retryAfterSeconds?: number;
  };
  const message = body.message ?? `assistant failed: ${res.status}`;
  if (res.status === 403) return { kind: "forbidden", message };
  if (res.status === 402) {
    return {
      kind: "over-limit",
      message,
      remainingUsd: typeof body.remainingUsd === "number" ? body.remainingUsd : 0,
      retryAfterSeconds: typeof body.retryAfterSeconds === "number" ? body.retryAfterSeconds : 0,
    };
  }
  if (res.status === 429) return { kind: "rate-limited", message };
  return { kind: "error", message };
}

/**
 * One turn.
 *
 * `conversationId` is omitted on the first message and echoed back from the answer
 * thereafter, so the server owns thread identity and the browser never invents one.
 */
export async function postAgentChat(
  message: string,
  conversationId?: string,
  signal?: AbortSignal,
): Promise<AgentAnswer> {
  let res: Response;
  try {
    res = await fetch(CHAT_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Absent rather than null on the first turn, the same rule `requestBody` follows:
      // "the key is not there" is what the server reads as "this is a new conversation".
      body: JSON.stringify(conversationId ? { message, conversationId } : { message }),
      signal,
    });
  } catch (e) {
    // An abort is the caller's own doing and must not be reported as a server failure.
    if ((e as Error).name === "AbortError") throw e;
    throw new AgentError({ kind: "error", message: "Could not reach finderr." });
  }
  if (!res.ok) throw new AgentError(await refusalOf(res));
  return (await res.json()) as AgentAnswer;
}

/** What the probe learnt. `available` is the only one that draws a launcher. */
export type AgentAvailability = "available" | "absent" | "forbidden";

/**
 * Is there an assistant here at all, and may this reader use it?
 *
 * > [!IMPORTANT] A GET, on a POST-only route, ON PURPOSE
 * > There is no cheap "are you there" endpoint in the contract, and the obvious probe --
 * > sending a message -- costs money and starts a conversation. A GET cannot: a route that
 * > exists refuses the method, a route that does not exist 404s, and the difference between
 * > those two answers is the entire question. So **404 is the only status read as absent**
 * > and every other one (405, 400, 401, 200) counts as present. Getting that backwards
 * > would hide a working assistant on the first server that answers a GET oddly.
 *
 * A failed fetch counts as absent rather than available: no launcher on a flaky network is
 * a quiet page, and a launcher that errors the moment it is clicked is not.
 */
export async function probeAgent(signal?: AbortSignal): Promise<AgentAvailability> {
  try {
    const res = await fetch(CHAT_PATH, { method: "GET", signal });
    if (res.status === 404) return "absent";
    if (res.status === 403) return "forbidden";
    return "available";
  } catch {
    return "absent";
  }
}
