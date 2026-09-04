/**
 * `POST /api/agent/chat` -- the assistant, as a browser meets it.
 *
 * One turn in, one answer out. There is no streaming yet and the shape is deliberately
 * chosen so adding it later is not a rewrite: the client already renders from the structured
 * fields rather than by parsing the prose.
 *
 * > [!IMPORTANT] THE GATE IS ASKED BEFORE THE MODEL, THE LEDGER IS WRITTEN AFTER -- ALWAYS
 * > `aiGate` (`../lib/ai-spend.ts`) owns who may spend; `chargeRun` owns recording what was
 * > spent. Both are called here and neither rule is re-implemented, which is what stops the
 * > admin-only beta and the daily cap acquiring a second owner in the route table.
 * >
 * > EVERY outcome writes a ledger row, including a run that errored or hit its turn cap. A
 * > run that died on turn six still spent five turns of tokens, and a cap that only counts
 * > successes leaks. The refusal path writes one too, at zero, so "how often is the wall
 * > being hit" is answerable.
 *
 * > [!CAUTION] NOT CONFIGURED ANSWERS 404, NOT 503
 * > A deployment with no OpenRouter key does not have this feature, and the honest report of
 * > that is the same one an unknown route gives -- the client then renders no launcher at
 * > all. 503 would say "it is broken and may come back", which is false and would leave a
 * > disabled button on every page. Same reasoning as the admin API answering 404 rather than
 * > 403: a surface you may not use does not announce itself.
 */

import type { Database } from "bun:sqlite";
import { MemoryResumeStore } from "../lib/agent/connections";
import { type RunResult, run } from "../lib/agent/runner";
import type { AgentContext } from "../lib/agent/schemas";
import { makeContext } from "../lib/agent/schemas";
import { aiGate, chargeRefusal, chargeRun, localDay } from "../lib/ai-spend";
import type { Principal } from "../lib/auth";
import type { Config } from "../lib/config";
import type { Store } from "../lib/store";
import { makeAgentActions } from "./agent-actions";
import { json } from "./json-response";
import type { LiveIndex } from "./live-index";
import type { RequestWorker } from "./request-worker";

export interface ChatDeps {
  cfg: Config;
  store: Store;
  live: LiveIndex;
  /**
   * A read handle on the CURRENT index, as a thunk.
   *
   * A thunk rather than a value because the daily swap retires whatever engine was open, and
   * a handle captured at wiring time would be the exact stale-connection bug `LiveIndex`
   * exists to prevent -- it either throws or, under load, quietly serves yesterday. Read at
   * the moment of use, from the same holder `live.current` reads from, so the two can never
   * disagree about which file is live.
   */
  indexDb: () => Database;
  worker: RequestWorker;
  has: { radarr: boolean; sonarr: boolean };
  log: (msg: string) => void;
}

/** What the browser gets back. The client renders from the STRUCTURE, not from the prose. */
export interface ChatResponse {
  conversationId: string;
  answer: string;
  toolCalls: { name: string; args: Record<string, unknown>; ms: number }[];
  requested: {
    tconst: string;
    title: string;
    kind: string;
    status: string;
    season?: number;
    episode?: number;
  }[];
  usage: { costUsd: number; ms: number };
}

export function makeChatHandler(deps: ChatDeps) {
  return async (req: Request, principal: Principal | null): Promise<Response> => {
    const key = deps.cfg.ai.openrouterApiKey;
    const model = deps.cfg.ai.models[0];
    // No key, or no model to call: the feature does not exist here. See the header.
    if (!key || !model) return new Response("Not Found", { status: 404 });

    const user = principal?.user;
    if (!user) return new Response("Not Found", { status: 404 });

    let body: { message?: unknown; conversationId?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: "bad_request", message: "body must be JSON" }, { status: 400 });
    }
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) return json({ error: "bad_request", message: "message is required" }, { status: 400 });

    const conversationId =
      typeof body.conversationId === "string" && body.conversationId
        ? body.conversationId
        : crypto.randomUUID();

    const verdict = aiGate({
      role: user.role,
      configured: true,
      limitUsd: deps.cfg.ai.dailyLimitUsd,
      spentToday: () => deps.store.aiSpendUsd(user.id, localDay()),
    });
    if (!verdict.allowed) {
      // A refusal is a ledger row too, at zero -- it is how the wall becomes countable.
      chargeRefusal(deps.store, { userId: user.id, convId: conversationId, model });
      if (verdict.reason === "beta_admin_only") {
        return json({ error: verdict.reason, message: verdict.message }, { status: 403 });
      }
      return json(
        {
          error: verdict.reason,
          message: verdict.message,
          remainingUsd: verdict.remainingUsd ?? 0,
          retryAfterSeconds: verdict.retryAfterSeconds ?? 60,
        },
        { status: 402, headers: { "Retry-After": String(verdict.retryAfterSeconds ?? 60) } },
      );
    }

    /*
      The engine is read at the MOMENT OF USE and never held across the run.

      `live.current` is the one owner of the open index, and a handler that destructures it
      into a local outliving an await goes on holding a retired engine after a daily swap --
      which either throws or, under load, quietly serves yesterday. Reading it here and
      handing it straight to the context is the shortest possible hold.
    */
    const actions = makeAgentActions({
      store: deps.store,
      worker: deps.worker,
      live: deps.live,
      principal,
      has: deps.has,
      quotaPerDay: deps.cfg.requests.quotaPerDay,
    });
    const ctx: AgentContext = { ...makeContext(deps.indexDb(), deps.live.current), actions };

    let result: RunResult;
    try {
      result = await run({
        ctx,
        model,
        apiKey: key,
        question: message,
        store: new MemoryResumeStore(),
      });
    } catch (err) {
      /*
        A run that THREW still cost tokens, so it still writes a row.

        The message goes to the log and never to the browser: an upstream URL can carry a
        credential and this field is one `JSON.stringify` from a user's screen. Same rule
        `work.problems` follows for a failing plugin.
      */
      deps.log(`agent chat: ${err instanceof Error ? err.message : String(err)}`);
      chargeRun(
        deps.store,
        { userId: user.id, convId: conversationId },
        { model, promptTokens: 0, completionTokens: 0, cachedTokens: 0, costUsd: 0, ms: 0, failure: "error" },
      );
      return json({ error: "agent_failed", message: "The assistant could not answer." }, { status: 502 });
    }

    chargeRun(
      deps.store,
      { userId: user.id, convId: conversationId },
      {
        model,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        cachedTokens: result.cachedTokens,
        costUsd: result.costUsd,
        ms: result.ms,
        ...(result.failure ? { failure: result.failure } : {}),
      },
    );

    const payload: ChatResponse = {
      conversationId,
      answer: result.answer,
      toolCalls: result.toolCalls.map((c) => ({ name: c.name, args: c.args, ms: c.ms })),
      // From the ACTIONS RECORD, never from the prose -- see `performed` in ../lib/agent/actions.ts.
      requested: actions.performed().map((r) => ({
        tconst: r.tconst,
        title: r.title,
        kind: r.grain,
        status: r.status,
        ...(r.season !== undefined ? { season: r.season, episode: r.episode } : {}),
      })),
      usage: { costUsd: result.costUsd, ms: result.ms },
    };
    return json(payload);
  };
}
