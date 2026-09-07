/**
 * `POST /api/agent/chat` -- the assistant, as a browser meets it.
 *
 * One turn in, one answer out, delivered two ways. A caller whose `Accept` asks for
 * `text/event-stream` gets the run as SSE; everybody else gets the finished answer as JSON.
 * Streaming was added on top of the original shape rather than replacing it, because the
 * client renders from the structured fields rather than by parsing the prose. The two paths
 * share every rule and differ only in when the caller is told things -- `streamResponse`
 * below is where that is spelled out.
 *
 * > [!IMPORTANT] THE GATE IS ASKED BEFORE THE MODEL, THE LEDGER IS WRITTEN AFTER -- ALWAYS
 * > `aiGate` (`../lib/ai-spend.ts`) owns who may spend; `chargeRun` owns recording what was
 * > spent. Both are called here and neither rule is re-implemented, which is what stops the
 * > audience rule and the daily cap acquiring a second owner in the route table.
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
import { historyFor, isRememberable, toMessages } from "../lib/agent/conversation";
import { idsIn, type Mention, resolveMentions } from "../lib/agent/mentions";
import { type RunEvent, type RunResult, run } from "../lib/agent/runner";
import type { AgentContext } from "../lib/agent/schemas";
import { makeContext } from "../lib/agent/schemas";
import { aiGate, assistantOffered, chargeRefusal, chargeRun, localDay } from "../lib/ai-spend";
import type { Principal, User } from "../lib/auth";
import type { Config } from "../lib/config";
import { boundedText, LIMITS, refusalMessage } from "../lib/input-guards";
import type { SearchEngine } from "../lib/search";
import type { SiteSettingsReader } from "../lib/site-settings";
import type { Store } from "../lib/store";
import { makeAgentActions } from "./agent-actions";
import { json } from "./json-response";
import type { LiveIndex } from "./live-index";
import type { RequestWorker } from "./request-worker";

export interface ChatDeps {
  cfg: Config;
  /**
   * The site defaults, read fresh per run: the assistant's request tool is held to the same
   * daily quota as the Request button, and an operator changing it on `/admin` must bind a
   * conversation that starts a second later.
   */
  settings: SiteSettingsReader;
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
  /**
   * Every TITLE the agent looked at, so the panel can draw a poster card instead of a name.
   *
   * MEMBERSHIP comes from the tool EVIDENCE and only from there -- `evidence.ids` already
   * records every id each result carried, for the fabricated-join grader, and this is the
   * same record read for a different purpose. A card is therefore never drawn for a title the
   * tools did not actually return, however confidently the prose names it.
   *
   * ORDER is a separate question and the prose is the right authority on it, which is the one
   * thing this comment used to get wrong by lumping the two together. See `surfaced`: a title
   * the answer names is put first, and the ids come from the same extractor that builds
   * `mentions`, so a model naming something that does not exist still gets no card and no
   * link. Reading the prose to RANK evidence cannot invent anything; reading it to SELECT
   * evidence could, and that is still not done.
   */
  titles: {
    tconst: string;
    title: string;
    year: number | null;
    kind: string;
    poster: string | null;
  }[];
  /** Every EPISODE it surfaced, with its score. `rating` is null when nobody has voted. */
  episodes: {
    tconst: string;
    parent: string;
    season: number;
    number: number;
    title: string | null;
    rating: number | null;
  }[];
  /**
   * Every id the ANSWER mentions, resolved against our index.
   *
   * The client turns `Name [tt…]` into a link using these; a bracket with no entry here is
   * stripped and the name stays plain text. That is the dead-end rule -- a model can emit a
   * well-formed id that never existed, and a link built from the SHAPE of an id would hand
   * the reader a confident 404. See ../lib/agent/mentions.ts.
   */
  mentions: Mention[];
  usage: { costUsd: number; ms: number };
}

/**
 * The titles and episodes a run actually touched, for the panel to draw.
 *
 * Reads `ToolTrace.evidence.ids`, which the run already records, and resolves each against
 * the SAME engine the tools read through -- so a card can never show a title the tools did
 * not return, and never a stale one from a retired index.
 *
 * Capped, because an agent that browsed 200 titles should not push 200 poster cards at a
 * browser; the answer names a handful and the rest are noise the reader never asked for.
 */
const MAX_CARDS = 24;

export function surfaced(result: RunResult, engine: SearchEngine, store: Store, answer: string) {
  const titles: ChatResponse["titles"] = [];
  const episodes: ChatResponse["episodes"] = [];
  const seenT = new Set<string>();
  const seenE = new Set<string>();

  // Every title id the tools returned, deduped, in the order the calls were made.
  const evidenceIds: string[] = [];
  for (const call of result.toolCalls) {
    for (const id of call.evidence.ids) {
      if (id.startsWith("tt") && !seenT.has(id)) {
        seenT.add(id);
        evidenceIds.push(id);
      }
    }
  }

  /*
    THE IDS THE ANSWER NAMES COME FIRST, and evidence order is only the tie-break.

    Call order is not relevance, and a run that searches twice makes that obvious. Asked "is
    there an Adrenochrome movie?" on 2026-09-06, the agent searched the misspelling, searched
    it again loosely, then searched the correct spelling -- and the middle call returned five
    unrelated films that took every visible card. The prose said *Adrenochrome (2017)* and
    *Adrenochrome II*; the reader saw Ender's Game, Andrei Rublev, Antichrist, Under the Dome
    and Andromeda, with the first named title sixth and the second off the bottom of the panel.
    A superseded search is still evidence, so it is not dropped -- it is just not the answer.

    `idsIn` is the same extractor `resolveMentions` uses, so the cards and the links in the
    prose can never disagree about which ids the answer named. It is a regex over a string and
    costs no query; ordering does not need the ids RESOLVED, because the loop below already
    resolves each one against the index and drops what it cannot find.
  */
  const named = new Set(idsIn(answer));
  const ordered = [
    ...evidenceIds.filter((id) => named.has(id)),
    ...evidenceIds.filter((id) => !named.has(id)),
  ];

  // The cap is applied AFTER the ordering, which is the half that matters: capping during
  // collection is what buried a named title behind two dozen rows nobody asked about.
  for (const id of ordered) {
    if (titles.length >= MAX_CARDS) break;
    const row = engine.byTconst(id);
    if (!row) continue;
    titles.push({
      tconst: row.tconst,
      title: row.title,
      year: row.year,
      kind: row.kind,
      /*
        THE SAME RULE `decorate()` APPLIES, and it is not "always a path".

        `/img/t/<tconst>` is our own proxy, so the browser never sees an upstream URL.
        But a title whose artwork has been RESOLVED TO NOTHING (`art.url === null`)
        gets null rather than a path, because pointing an <img> at a proxy we know will
        404 makes the card flash a broken image before falling back to initials.
        `undefined` means we have not looked yet, which is not the same as knowing
        there is none -- so it still gets the path and the proxy resolves it on demand.
      */
      poster: (() => {
        const art = store.getArtwork(row.tconst);
        return art !== undefined && art.url === null ? null : `/img/t/${row.tconst}`;
      })(),
    });
  }

  /*
    Episodes come from the CALL ARGUMENTS plus the engine, not from the payload.

    `evidence` deliberately records entity ids and relations, and an episode tconst is
    neither -- it is not a browsable title and it forms no join. So the parent is read off
    the list_episodes call that asked, and the rows are re-read from the index, which is
    cheap (a covering-index lookup) and cannot disagree with what the tool returned.

    Its own loop now, rather than sharing the title loop: the titles are no longer walked in
    call order, and an episode list belongs to the call that asked for it.
  */
  for (const call of result.toolCalls) {
    if (call.name === "list_episodes" && typeof call.args.tconst === "string") {
      const parent = call.args.tconst;
      if (seenE.has(parent)) continue;
      seenE.add(parent);
      for (const e of engine.episodesOf(parent, {
        season: typeof call.args.season === "number" ? call.args.season : undefined,
        minRating: typeof call.args.min_rating === "number" ? call.args.min_rating : undefined,
        minVotes: typeof call.args.min_votes === "number" ? call.args.min_votes : undefined,
        limit: MAX_CARDS,
      })) {
        episodes.push({
          tconst: e.tconst,
          parent: e.parent,
          season: e.season,
          number: e.number,
          title: e.title,
          rating: e.rating,
        });
      }
    }
  }
  return { titles, episodes };
}

/**
 * "Does this deployment have an assistant, and may I use it?"
 *
 * An EXPLICIT endpoint rather than inferring availability from a 405 on the POST route. The
 * client needs to know whether to draw a launcher at all, and inferring that from
 * method-not-allowed makes a UI decision depend on how the framework happens to answer an
 * unmatched verb -- which is not a contract anybody wrote down, and which measured as a 404
 * here rather than the 405 the client expected. A launcher that never appears is the exact
 * failure that would have caused, and nothing would have errored.
 *
 * 404 for every reason it is unavailable -- no key, not signed in, or switched off for this
 * account -- so an instance without it says the feature does not exist in the same voice the
 * POST route does, and a surface you may not use does not announce itself.
 */
export function makeChatProbe(deps: Pick<ChatDeps, "cfg">) {
  return (_req: Request, principal: Principal | null): Response => {
    const model = deps.cfg.ai.models[0];
    // SIGNED IN, then the two WALLS -- a deployment with no key, and an account an admin
    // switched off. Both are `assistantOffered`, so this and `aiGate` cannot disagree about
    // whether a launcher should exist. It was `role !== "admin"` until 2026-09-05; do not
    // re-add a role check, that is not what the per-account switch replaced.
    if (!model || !principal?.user) return new Response("Not Found", { status: 404 });
    const offered = assistantOffered({
      configured: Boolean(deps.cfg.ai.openrouterApiKey),
      allowedForAccount: principal.user.assistantAllowed,
    });
    // The DAILY BUDGET is deliberately not asked here: it is a wait rather than a wall, and
    // hiding the launcher for the rest of the day would turn "come back tomorrow" into "this
    // feature vanished". The 402 explains itself when a message is actually sent.
    if (!offered) return new Response("Not Found", { status: 404 });
    return json({ available: true, model });
  };
}

/**
 * One SSE frame. Blank line terminates, which is the framing the client splits on.
 *
 * `JSON.stringify` on the data is not decoration: a newline inside a payload would otherwise
 * end the frame early and split one event into two, and model text is full of newlines.
 */
function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * The streaming half of the chat route.
 *
 * Shares every rule with the JSON path and re-implements none of them -- same gate, same
 * ledger, same memory, same `surfaced`. What differs is only WHEN the caller is told things.
 *
 * > [!CAUTION] THE RUN IS NOT ABANDONED WHEN THE CLIENT HANGS UP
 * > A closed browser tab cancels the response stream, not the work: the model call is
 * > already in flight, the tools may already have started a download, and the ledger row is
 * > owed either way. So every write goes through `push`, which swallows a closed-controller
 * > error, and the charge happens after the loop regardless. A cap that a user could dodge
 * > by closing the tab would not be a cap.
 */
function streamResponse(
  deps: ChatDeps,
  args: {
    /**
     * The REAL principal, and not a `{ user: { id, role } }` stand-in.
     *
     * `makeAgentActions` reads the whole user off it -- their quota override among other
     * things -- so a fabricated one would silently give the streaming path a different
     * answer from the JSON path for the same person. The two must not be able to disagree,
     * and passing the actual object is what makes that structural rather than remembered.
     */
    principal: Principal & { user: User };
    conversationId: string;
    message: string;
    model: string;
    key: string;
  },
): Response {
  const { user } = args.principal;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const push = (chunk: string): void => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // The reader is gone. Stop writing; keep working.
          open = false;
        }
      };

      const actions = makeAgentActions({
        store: deps.store,
        worker: deps.worker,
        live: deps.live,
        principal: args.principal,
        has: deps.has,
        siteQuotaPerDay: deps.settings.read().requestQuotaPerDay,
      });
      const ctx: AgentContext = {
        ...makeContext(deps.indexDb(), deps.live.current, deps.cfg.languages),
        actions,
      };

      let result: RunResult | null = null;
      try {
        result = await run({
          ctx,
          model: args.model,
          apiKey: args.key,
          question: args.message,
          history: toMessages(historyFor(deps.store, user.id, args.conversationId), args.message).slice(
            0,
            -1,
          ),
          store: new MemoryResumeStore(),
          onEvent: (e: RunEvent) => push(frame(e.type === "tool" ? "tool" : e.type, e)),
        });
      } catch (err) {
        // The message goes to the LOG and never to the browser -- an upstream URL can carry a
        // credential. Same rule `work.problems` follows for a failing plugin.
        deps.log(`agent chat stream: ${err instanceof Error ? err.message : String(err)}`);
        chargeRun(
          deps.store,
          { userId: user.id, convId: args.conversationId },
          {
            model: args.model,
            promptTokens: 0,
            completionTokens: 0,
            cachedTokens: 0,
            costUsd: 0,
            ms: 0,
            failure: "error",
          },
        );
        push(frame("error", { error: "agent_failed", message: "The assistant could not answer." }));
        try {
          controller.close();
        } catch {
          // Already closed by a reader that left.
        }
        return;
      }

      chargeRun(
        deps.store,
        { userId: user.id, convId: args.conversationId },
        {
          model: args.model,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          cachedTokens: result.cachedTokens,
          costUsd: result.costUsd,
          ms: result.ms,
          ...(result.failure ? { failure: result.failure } : {}),
        },
      );
      if (isRememberable(args.message, result.answer)) {
        deps.store.appendConversationTurn(user.id, args.conversationId, {
          question: args.message,
          answer: result.answer,
          at: new Date().toISOString(),
        });
      }

      push(
        frame("done", {
          conversationId: args.conversationId,
          answer: result.answer,
          toolCalls: result.toolCalls.map((c) => ({ name: c.name, args: c.args, ms: c.ms })),
          requested: actions.performed().map((r) => ({
            tconst: r.tconst,
            title: r.title,
            kind: r.grain,
            status: r.status,
            ...(r.season !== undefined ? { season: r.season, episode: r.episode } : {}),
          })),
          ...surfaced(result, deps.live.current, deps.store, result.answer),
          mentions: resolveMentions(deps.indexDb(), result.answer),
          usage: { costUsd: result.costUsd, ms: result.ms },
        }),
      );
      try {
        controller.close();
      } catch {
        // Reader already gone.
      }
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      // No buffering anywhere in front of us, or the whole point is lost: a proxy that
      // accumulates the stream delivers one blob at the end, which is what we are fixing.
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

export function makeChatHandler(deps: ChatDeps) {
  return async (req: Request, principal: Principal | null): Promise<Response> => {
    const key = deps.cfg.ai.openrouterApiKey;
    const model = deps.cfg.ai.models[0];
    // No key, or no model to call: the feature does not exist here. See the header.
    if (!key || !model) return new Response("Not Found", { status: 404 });

    const user = principal?.user;
    if (!user) return new Response("Not Found", { status: 404 });
    // The account switch is a WALL, and it answers in the same voice the missing key does --
    // the assistant does not exist for this reader, and the probe already drew no launcher.
    // Same `assistantOffered` the probe asks, so the two cannot disagree. A 403 here would
    // announce a surface they may not use; see the header.
    if (!assistantOffered({ configured: true, allowedForAccount: user.assistantAllowed }))
      return new Response("Not Found", { status: 404 });

    let body: { message?: unknown; conversationId?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: "bad_request", message: "body must be JSON" }, { status: 400 });
    }
    /*
      THE SPEND GATE BOUNDS THE MONEY AND CANNOT BOUND THE TURN.

      `aiGate` below checks what this account has spent TODAY, which is a check that runs
      BEFORE the call and therefore cannot see what this one call is about to cost. A 256 KB
      message -- the largest `maxRequestBodySize` admits -- is one call the budget waves
      through and then discovers. `LIMITS.message` is what makes the gate's arithmetic
      meaningful, by bounding the thing it is doing arithmetic about.

      Refused rather than truncated, and here that is not merely a convention: half a
      question answered confidently is worse than no answer.
    */
    const guarded = boundedText(body.message, LIMITS.message);
    if (!guarded.ok)
      return json({ error: "bad_request", message: refusalMessage("message", guarded) }, { status: 400 });
    const message = guarded.value;

    /*
      A CLIENT-CHOSEN id is a KEY IN OUR STORAGE, so it is bounded like any other.

      Unbounded, a caller could hand us a 256 KB conversation id and we would file every
      turn under it -- and a fresh one on every request, which is a key space they control
      the size of. Anything unusable falls back to a UUID rather than being refused: the
      caller loses the thread they asked to continue and gets a working new one, which is
      the same outcome an expired conversation already produces.
    */
    const claimed = boundedText(body.conversationId, LIMITS.id);
    const conversationId = claimed.ok ? claimed.value : crypto.randomUUID();

    const verdict = aiGate({
      role: user.role,
      configured: true,
      limitUsd: deps.cfg.ai.dailyLimitUsd,
      spentToday: () => deps.store.aiSpendUsd(user.id, localDay()),
    });
    if (!verdict.allowed) {
      // A refusal is a ledger row too, at zero -- it is how the wall becomes countable.
      chargeRefusal(deps.store, { userId: user.id, convId: conversationId, model });
      // The 403 branch that stood here answered `beta_admin_only` and is gone with it. Every
      // refusal `aiGate` can still return is a BUDGET, which is a wait rather than a wall --
      // so 402 with a `Retry-After` is now the only shape, and the client reads it as one.
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
      STREAM WHEN ASKED, JSON OTHERWISE -- one route, two renderings of one answer.

      Negotiated on `Accept` rather than split into `/chat` and `/chat/stream`, because they
      are the same operation with the same gate, the same ledger and the same memory; two
      routes would be two owners of all three and the pair would drift. It also keeps the
      non-streaming path alive as a real fallback rather than as dead code.
    */
    if (req.headers.get("accept")?.includes("text/event-stream")) {
      return streamResponse(deps, {
        // `user` is `principal.user`, narrowed non-null above -- restated so the stream path
        // gets the real principal and not a stand-in built from two of its fields.
        principal: { ...principal, user },
        conversationId,
        message,
        model,
        key,
      });
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
      siteQuotaPerDay: deps.settings.read().requestQuotaPerDay,
    });
    const ctx: AgentContext = {
      ...makeContext(deps.indexDb(), deps.live.current, deps.cfg.languages),
      actions,
    };

    let result: RunResult;
    try {
      result = await run({
        ctx,
        model,
        apiKey: key,
        question: message,
        // THE CONVERSATION CONTINUES -- aannarr's ruling of 2026-09-05, which the build plan
        // had left open. `toMessages` owns the replay budget; see ../lib/agent/conversation.ts.
        history: toMessages(historyFor(deps.store, user.id, conversationId), message).slice(0, -1),
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

    /*
      Remembered AFTER the ledger, and only when there is something to remember.

      Order matters: the charge is owed whatever happened, the memory is only owed when a
      turn actually completed. A run that died before answering writes its cost and leaves no
      turn behind -- replaying a question with an empty reply would teach the model that
      ignoring people is a thing it does.
    */
    if (isRememberable(message, result.answer)) {
      deps.store.appendConversationTurn(user.id, conversationId, {
        question: message,
        answer: result.answer,
        at: new Date().toISOString(),
      });
    }

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
      ...surfaced(result, deps.live.current, deps.store, result.answer),
      mentions: resolveMentions(deps.indexDb(), result.answer),
      usage: { costUsd: result.costUsd, ms: result.ms },
    };
    return json(payload);
  };
}
