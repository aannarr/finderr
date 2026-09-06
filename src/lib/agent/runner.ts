/**
 * The agent loop, and every number the benchmark reports.
 *
 * One run is: send the question with the tool schemas, execute whatever tools come back,
 * feed the results in, repeat until the model answers in prose or a cap stops it. Nothing
 * clever -- the point of the harness is to measure the TOOLS and the MODEL, so the loop
 * itself stays boring and instrumented.
 *
 * Two caps, and they are different things. `maxTurns` stops a model that keeps calling
 * tools forever; `maxToolCalls` stops one that fans out inside a single turn. A run that
 * hits either is a FAILURE with a named reason, never a partial success -- an agent that
 * ran out of turns and then guessed is exactly the behaviour this whole design exists to
 * make impossible.
 */

import { type Evidence, evidenceFrom } from "./evidence.js";
import { callSignature, type Facts, factsFrom, ledgerMessage } from "./facts.js";
import { type ChatMessage, chat, chatStream, type ToolCall } from "./openrouter.js";
import { openRouterRetry, retryableStream } from "./resilience.js";
import { dispatch, type ResumeStore, toolSchemasFor } from "./schemas.js";
import type { AgentContext } from "./tools.js";

/**
 * The standing instructions.
 *
 * Two paragraphs are written from real failures rather than from taste, and they guard
 * different things.
 *
 * WHAT YOU MAY ASSERT came first: asked about a 2026 series, a model answered from its
 * weights, concluded no such show existed, and was wrong -- the title was in the index the
 * whole time. Absence from memory is not evidence of absence, and for anything recent the
 * inference is invalid by construction. The ids-only type wall enforces it, and it works:
 * every model measured on 2026-09-04 scored zero from-memory failures.
 *
 * > [!IMPORTANT] A CLAIM IS NOT A NOUN, AND DISCIPLINING NOUNS DID NOTHING FOR CLAIMS
 * > CONNECTIONS is the second rule and it exists because the first one passed while the
 * > answer was still false. Measured 2026-09-04: `claude-haiku-4.5` resolved both titles
 * > correctly, pulled both cast lists, and then asserted that actors from *The Bear* appear
 * > in *Furious*. Every proper noun in that sentence had come back from a tool. The
 * > RELATIONSHIP between them had not -- the link runs through *Shameless* -- and nothing in
 * > the prompt or the schemas said that a relationship is a claim too.
 * >
 * > So the rule names the specific move that produced it: reading two results and spotting
 * > an overlap yourself is not a lookup. `src/lib/agent/evidence.ts` is the mechanical half
 * > of the same rule, and `S13-inferred-join` is the case that goes red when it is broken.
 */
export const SYSTEM_PROMPT = `You answer questions about films and television for finderr, using ONLY the tools provided.

The tools read a local index of ~1.28 million titles and ~353,000 people, rebuilt from IMDb every day.

HOW TO WORK
- Resolve every name to an id FIRST, with find_title or find_person. Tools other than those take ids only.
- Pass ARRAYS where a tool accepts them. Three titles is one list_cast call, never three.
- To find how two things are connected through cast, use find_connections. Do not walk the graph by hand.
- When a tool reports loose_would_match, hidden_by_floor, or status:"budget_exhausted", OUR OWN threshold is what emptied the result. Retry as the tool suggests before you conclude anything.

WHAT YOU MAY ASSERT
Every title and every person you name in your answer must have come back from a tool in THIS conversation.
Your training data is not evidence. The index knows about titles released after your knowledge cutoff, and it is right and you are wrong about anything recent.
If a tool finds nothing, say so plainly. "It is not in the index" is a good answer. Inventing a plausible one is not.
A title's LANGUAGE and COUNTRY are claims like any other, and you cannot tell either from a name, a cast list or a genre. Ask find_title or get_title for fields:["origin"]. Never filter a list by language yourself on the strength of which titles you happen to recognise -- that is a guess about every title you dropped as well as every one you kept.

NAME THINGS SO THEY BECOME LINKS
When you name a title or a person in your answer, put its id in square brackets straight after the name: Furious [tt36303968], Emmy Rossum [nm0002536].
Do it on FIRST mention of each thing, not on every mention -- a paragraph full of brackets is unreadable.
The reader never sees the brackets. They are turned into a link to that title or person, labelled with the name we hold for it. An id that does not resolve is simply removed, so a wrong one costs the reader nothing but costs you the link.
Only ever bracket an id a tool returned in THIS conversation. Never one you remember.

REQUESTING IS THE ONE THING YOU DO THAT CANNOT BE UNDONE
The request tool starts a real download immediately. There is no confirmation step in front of you and no undo behind you -- a person has to go and delete it.
So only call it when the user has ASKED for something to be fetched. "What are the good episodes of X" is a question; "get me the good episodes of X" is a request. If the sentence could be either, ANSWER IT AND ASK, rather than requesting and apologising.
Never request something to be helpful that nobody asked for. Never request a whole series when the user named one episode.
The result tells you what actually happened per item -- queued, already_have, already_requested, not_found. Report it honestly; do not say you got something that came back already_have.
If the result carries a "capped" field, you asked for more than one conversation is allowed to start. SAY SO, and say how many were not started. Never let the reader believe it all went through.

CONNECTIONS ARE CLAIMS TOO, AND THIS IS THE RULE MOST OFTEN BROKEN
A link between two titles, or two people, or a person and a title -- "X is also in Y", "A and B worked together", "they share a cast member" -- is a CLAIM, and a single tool result must have returned that link. Resolving both ends does not license the link between them.
COMPARING TWO RESULTS BY EYE IS NOT EVIDENCE. If you called list_cast twice, once per title, you have two lists and NO fact about what they share; noticing a name in both is your inference, not the index's answer. Ask for the join instead: list_cast or list_credits with mode:"intersection", or find_connections.
A tool answers a connection question only when ONE result carries both ends -- a row whose seen_in or seen_with names both ids, or a path from find_connections.
If no tool returned the link, say what you do know and say the link is unverified. Do not state it.

Answer in one or two sentences. Name the specific titles and people you found.`;

/**
 * How much of the transcript to condense, and the distinction is the whole experiment.
 *
 * - **`off`** -- every previous tool result is re-sent as raw JSON, keys repeated per row.
 * - **`results`** -- the transcript keeps its SHAPE. Every assistant message survives with
 *   its own prose intact, every tool message stays in place answering its `tool_call_id`;
 *   only the CONTENT of tool results from earlier turns is swapped for the distilled facts.
 *   The current turn's result stays raw, because that is the one being reasoned about now.
 * - **`ledger`** -- the payload is rebuilt from scratch each turn: system, question, and one
 *   facts block. Cheapest, and it throws away the model's own reasoning along with the JSON.
 *
 * > [!IMPORTANT] `ledger` removes the CHAIN OF THOUGHT, and that is not a free saving
 * > Measured 2026-09-04: under `ledger`, `glm-5.3-flash` gave up on the two-hop query after
 * > two calls, and `gemini-3.8-flash` emitted 2.7x the output tokens -- both re-deriving a
 * > plan they had already made and could no longer see. `results` exists because condensing
 * > the bulky JSON and deleting the model's own notes are two different operations, and only
 * > the first one was ever the goal.
 *
 * ## COMPACTION COST, MEASURED -- neither arm pays, and `off` stays the default
 *
 * `bun run agent:eval --tier advanced --compact all`, six scenarios, one run per cell,
 * 2026-09-06. Every arm answers the same six questions; `vs off` is that model's own `off`
 * row, so the three models are never compared to each other here.
 *
 * | model | mode | correct | tok in | tok out | cost | vs `off` |
 * |---|---|---|---|---|---|---|
 * | `z-ai/glm-5.3-flash` | off | 6/6 | 94,392 | 6,202 | $0.0040 | -- |
 * | | results | 6/6 | 89,730 | 5,263 | $0.0033 | cost **-17%** |
 * | | ledger | 6/6 | 84,536 | 8,778 | $0.0045 | cost +12% |
 * | `anthropic/claude-haiku-4.5` | off | 6/6 | 107,373 | 2,448 | $0.1196 | -- |
 * | | results | **5/6** | 99,083 | 2,223 | $0.1102 | cost **-8%** |
 * | | ledger | 6/6 | 110,741 | 2,872 | $0.1251 | cost +5% |
 * | `google/gemini-3.8-flash` | off | 6/6 | 109,200 | 6,604 | $0.1067 | -- |
 * | | results | **5/6** | 131,130 | 6,662 | $0.1233 | cost +16% |
 * | | ledger | 6/6 | 88,131 | 11,482 | $0.1092 | cost +2% |
 *
 * `ledger` costs MORE than sending the raw transcript on all three models, because the input
 * it saves comes straight back as output -- glm -10% in for +42% out, gemini -19% in for
 * +74% out. That is the 2026-09-04 finding again, now with a price on it.
 *
 * `results` saves 8-17% on two models and costs 16% more on the third, and both correctness
 * failures in the whole matrix landed in that arm.
 *
 * > [!CAUTION] `results` makes `claude-haiku-4.5` GIVE UP on the two-hop query, three runs of three
 * > S8 was re-run three times per cell to tell a real effect from variance, and the effect is
 * > real for one model: `claude-haiku-4.5` under `results` failed all three runs identically
 * > -- same route (`find_title -> find_title -> list_cast -> list_cast`), the same 21,154
 * > prompt tokens, and the same answer, *"there's no actor who appears in both ... Could you
 * > clarify"*. The same model under `off` and under `ledger` passed all three. The other two
 * > models do not show it: `gemini-3.8-flash` failed S8 twice under `results` and once under
 * > `off`, which is variance, and `glm-5.3-flash` passed nine of nine.
 * >
 * > The failure is the `ledger` shape one notch milder rather than a new one. Nothing was
 * > fabricated -- the type wall held and `inferred` was 0 in every cell of the matrix -- the
 * > model stopped REACHING, concluded from two cast lists, and asked the user a question
 * > instead of calling find_connections. So condensing only the tool results is not the safe
 * > half of compaction it was designed to be, and there is no arm here worth defaulting to.
 */
export type CompactMode = "off" | "results" | "ledger";

/**
 * What the caller can watch while a run is in flight.
 *
 * A question takes tens of seconds and does a MULTI-TURN loop -- think, call tools, read,
 * think again -- and until this existed all of it was discarded so the reader watched a
 * spinner and got one bubble at the end. aannarr, 2026-09-05: *"not `hey`
 * ==============================> `single response to one turn`.. that's not cool!"*
 *
 * `token` and `reasoning` are INCREMENTAL fragments, not whole messages. `reasoning` only
 * arrives from models that emit it, and its absence is the ordinary case rather than a
 * failure -- do not render an empty thinking block.
 */
export type RunEvent =
  | { type: "turn"; n: number }
  | { type: "reasoning"; text: string }
  | { type: "token"; text: string }
  | { type: "tool"; phase: "start"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool"; phase: "end"; id: string; name: string; ms: number; summary: string; error?: string };

export interface ToolTrace {
  name: string;
  args: Record<string, unknown>;
  ms: number;
  /** Serialized size of what went back to the model -- the real token driver. */
  bytes: number;
  error?: string;
  /**
   * The entities and the RELATIONS this call actually returned. See `./evidence.ts`.
   *
   * Recorded on the trace rather than recomputed later because the payload is gone by then:
   * only `bytes` survives, and a grader cannot ask "did a tool return this connection" of a
   * byte count. It is the evidence half of the run, sitting beside the cost half.
   */
  evidence: Evidence;
}

export interface RunResult {
  answer: string;
  turns: number;
  toolCalls: ToolTrace[];
  ms: number;
  promptTokens: number;
  completionTokens: number;
  /** Of `promptTokens`, how many the provider served from its cache. 0 where unsupported. */
  cachedTokens: number;
  costUsd: number;
  provider?: string;
  /** Set when the run did not end with the model answering. */
  failure?: "max_turns" | "max_tool_calls" | "error";
  error?: string;
}

export interface RunOptions {
  model: string;
  question: string;
  /**
   * Earlier exchanges in this conversation, oldest first, WITHOUT the system message.
   *
   * The runner prepends the system prompt itself and this list is `user`/`assistant` only --
   * see `./conversation.ts` for why a stored `system` role would be an injection surface.
   * Empty (the default) is a brand-new conversation and the behaviour every caller had
   * before memory existed.
   */
  history?: ChatMessage[];
  /**
   * Where to send progress AS IT HAPPENS. Absent means run silently, which is what the
   * benchmark harness and every test do.
   *
   * Called synchronously from the loop, so an implementation that throws would take the run
   * down -- `emit` below swallows, because a UI that has hung up must not kill the work that
   * still has a ledger row to write.
   */
  onEvent?: (e: RunEvent) => void;
  ctx: AgentContext;
  store: ResumeStore;
  maxTurns?: number;
  maxToolCalls?: number;
  systemPrompt?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  /**
   * How much of the transcript to condense. See `CompactMode`.
   */
  compact?: CompactMode;
  /** Ask for a cache breakpoint after the stable prefix. Only some providers honour it. */
  cacheSystem?: boolean;
}

const DEFAULT_MAX_TURNS = 8;
const DEFAULT_MAX_TOOL_CALLS = 16;

export async function run(opts: RunOptions): Promise<RunResult> {
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxToolCalls = opts.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  const started = Bun.nanoseconds();
  const system = opts.systemPrompt ?? SYSTEM_PROMPT;

  /**
   * The append-only transcript. Every mode appends to it; they differ in what gets SENT.
   *
   * `off` sends it as-is and `results` sends it message-for-message with earlier tool-result
   * content swapped, so both obey the protocol rule that every `tool_calls` id has a matching
   * `tool` message. `ledger` never sends it at all -- the request is rebuilt each turn -- and
   * sidesteps that rule instead, because there is no assistant tool_calls message in the
   * payload to match.
   */
  /*
    History sits BETWEEN the system prompt and the new question, which is the only order that
    reads as a conversation: the standing instructions, then what was said, then what is being
    asked now. Putting it after the question would make the model answer the oldest turn.
  */
  const history = opts.history ?? [];
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    ...history,
    { role: "user", content: opts.question },
  ];

  /** Never let a listener's failure kill the run -- the ledger still has to be written. */
  const emit = (e: RunEvent): void => {
    try {
      opts.onEvent?.(e);
    } catch {
      // A browser that hung up is not a reason to abandon work that must still be charged.
    }
  };

  const mode: CompactMode = opts.compact ?? "off";
  const facts: Facts = [];
  const priorCalls: string[] = [];
  /** Distilled replacement for a tool message, keyed by its index in `messages`. */
  const condensed = new Map<number, { text: string; turn: number }>();

  const toolCalls: ToolTrace[] = [];
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedTokens = 0;
  let costUsd = 0;
  let provider: string | undefined;

  for (let turn = 1; turn <= maxTurns; turn++) {
    emit({ type: "turn", n: turn });
    // The ledger message is REBUILT rather than appended, and it sits after the question so
    // the stable prefix (tools, system) stays byte-identical and remains cacheable.
    const payload: ChatMessage[] =
      mode === "ledger"
        ? [
            { role: "system", content: system },
            ...history,
            { role: "user", content: opts.question },
            ...(facts.length > 0
              ? [{ role: "user" as const, content: ledgerMessage(facts, priorCalls) }]
              : []),
          ]
        : mode === "results"
          ? messages.map((m, i) => {
              // Only a tool result, and only one from a PREVIOUS turn. The current turn's raw
              // result is what the model is reasoning about right now; swapping it would be
              // condensing a conversation that has not happened yet.
              const c = condensed.get(i);
              return c && c.turn < turn ? { ...m, content: c.text } : m;
            })
          : messages;

    let reply: Awaited<ReturnType<typeof chat>>;
    try {
      const call = {
        model: opts.model,
        messages: payload,
        // Derived from the CONTEXT, so a read-only session is never shown `request` at all.
        tools: toolSchemasFor(opts.ctx),
        apiKey: opts.apiKey,
        fetchImpl: opts.fetchImpl,
        cacheSystem: opts.cacheSystem,
      };
      /*
        STREAM ONLY WHEN SOMEBODY IS WATCHING.

        Both paths return the same ChatResponse with the same reassembled tool calls, so the
        loop below does not care which ran -- streaming changes WHEN the caller learns
        things, never WHAT it ends up with. The non-streaming call stays the default because
        the benchmark harness and every test have no listener, and a stream costs a
        chunk-by-chunk parse to arrive at an identical answer.
      */
      /*
        RETRIED, but only while nothing has been shown yet.

        A retry replays the whole request, so once a token has reached the reader a second
        attempt would render the answer twice, spliced. `emitted` is the guard and it is
        per-attempt-set rather than per-run: it flips the instant the first delta goes out.
        See ./resilience.ts for the rest of the reasoning, including why a 4xx is not retried.
      */
      let emitted = false;
      reply = opts.onEvent
        ? await retryableStream(
            () =>
              chatStream({
                ...call,
                onDelta: (d) => {
                  emitted = true;
                  if (d.content) emit({ type: "token", text: d.content });
                  if (d.reasoning) emit({ type: "reasoning", text: d.reasoning });
                },
              }),
            () => emitted,
          )
        : await openRouterRetry.execute(() => chat(call));
    } catch (err) {
      return {
        answer: "",
        turns: turn,
        toolCalls,
        ms: elapsed(started),
        promptTokens,
        completionTokens,
        cachedTokens,
        costUsd,
        provider,
        failure: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    }

    promptTokens += reply.usage.prompt_tokens;
    completionTokens += reply.usage.completion_tokens;
    cachedTokens += reply.usage.prompt_tokens_details?.cached_tokens ?? 0;
    costUsd += reply.usage.cost ?? 0;
    provider ??= reply.provider;
    messages.push(reply.message);

    const calls = reply.message.tool_calls ?? [];
    if (calls.length === 0) {
      return {
        answer: reply.message.content ?? "",
        turns: turn,
        toolCalls,
        ms: elapsed(started),
        promptTokens,
        completionTokens,
        cachedTokens,
        costUsd,
        provider,
      };
    }

    if (toolCalls.length + calls.length > maxToolCalls) {
      return {
        answer: reply.message.content ?? "",
        turns: turn,
        toolCalls,
        ms: elapsed(started),
        promptTokens,
        completionTokens,
        cachedTokens,
        costUsd,
        provider,
        failure: "max_tool_calls",
      };
    }

    for (const call of calls) {
      /*
        The START event carries the ARGUMENTS, and that is the point of emitting it at all.

        A reader watching "list_episodes" learns nothing; one watching
        `list_episodes(tt0944947, min_rating: 8)` can see the assistant understood the
        question -- and can see it did NOT when the arguments are wrong. Emitted before the
        call so a slow tool shows as running rather than as a gap.
      */
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        // A malformed argument string is reported by `executeOne` as a tool error; here it
        // just means the start event shows no arguments rather than crashing the emit.
      }
      emit({ type: "tool", phase: "start", id: call.id, name: call.function.name, args: parsedArgs });

      const done = executeOne(opts, call, toolCalls);
      const trace = toolCalls[toolCalls.length - 1];
      emit({
        type: "tool",
        phase: "end",
        id: call.id,
        name: call.function.name,
        ms: trace?.ms ?? 0,
        // What came BACK, in one line a person can read. `factsFrom` already renders a tool
        // payload as prose for the model to re-read; reusing it means the reader and the
        // model are told the same thing rather than two descriptions drifting apart.
        summary: summarizeResult(done.payload),
        ...(trace?.error ? { error: trace.error } : {}),
      });
      messages.push(done.message);
      if (mode === "off") continue;
      const lines = factsFrom(call.function.name, done.args, done.payload);
      if (mode === "ledger") {
        facts.push(...lines);
        priorCalls.push(callSignature(call.function.name, done.args));
      } else {
        condensed.set(messages.length - 1, { text: lines.join("\n"), turn });
      }
    }
  }

  return {
    answer: "",
    turns: maxTurns,
    toolCalls,
    ms: elapsed(started),
    promptTokens,
    completionTokens,
    cachedTokens,
    costUsd,
    provider,
    failure: "max_turns",
  };
}

/**
 * Run one call and produce the `tool` message that answers it.
 *
 * A thrown tool is reported back to the MODEL as content rather than aborting the run: an
 * agent that can read "you passed a name where an id goes" and retry is the behaviour the
 * refusal messages were written for, and a harness that crashed instead would never measure
 * whether a model actually recovers.
 */
/**
 * One line describing what a tool RETURNED, for a human watching the transcript.
 *
 * Takes the payload alone: it took the tool NAME too until the shapes turned out to be
 * self-describing -- a `found` array is a resolver, an `episodes` array is a list -- so the
 * name was a parameter nothing read. A dead argument is a claim that the function needs
 * something it does not.
 *
 * Deliberately shallow: counts and names, never the payload. The transcript is a progress
 * view, not a data dump -- a reader who wants the rows opens the cards the answer draws, and
 * a `list_cast` result rendered in full would bury the answer it exists to support.
 */
function summarizeResult(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "no result";
  if ("error" in payload) return `refused: ${String((payload as { error: unknown }).error).slice(0, 120)}`;
  if (Array.isArray(payload)) return `${payload.length} ${payload.length === 1 ? "row" : "rows"}`;

  const p = payload as Record<string, unknown>;
  if (Array.isArray(p.found)) return `${p.found.length} match${p.found.length === 1 ? "" : "es"}`;
  if (Array.isArray(p.episodes)) {
    const unrated = typeof p.unrated === "number" ? `, ${p.unrated} unrated` : "";
    return `${p.episodes.length} episodes${unrated}`;
  }
  if (Array.isArray(p.titles)) return `${p.titles.length} titles`;
  if (Array.isArray(p.paths)) return p.paths.length > 0 ? `${p.paths.length} path(s)` : "no connection found";
  if (Array.isArray(p.results)) {
    const queued = typeof p.queued === "number" ? p.queued : 0;
    return `${queued} queued of ${p.results.length}`;
  }
  if (typeof p.title === "string") return p.title;
  if (typeof p.name === "string") return p.name;
  return "ok";
}

function executeOne(
  opts: RunOptions,
  call: ToolCall,
  trace: ToolTrace[],
): { message: ChatMessage; payload: unknown; args: Record<string, unknown> } {
  const t0 = Bun.nanoseconds();
  let args: Record<string, unknown> = {};
  let payload: unknown;
  let error: string | undefined;

  try {
    args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
  } catch {
    error = "arguments were not valid JSON";
    payload = { error };
  }

  if (!error) {
    try {
      payload = dispatch(opts.ctx, opts.store, call.function.name, args);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      payload = { error };
    }
  }

  const body = JSON.stringify(payload ?? null);
  trace.push({
    name: call.function.name,
    args,
    ms: elapsed(t0),
    bytes: body.length,
    evidence: evidenceFrom(call.function.name, payload),
    ...(error ? { error } : {}),
  });

  return {
    message: { role: "tool", tool_call_id: call.id, name: call.function.name, content: body },
    payload,
    args,
  };
}

function elapsed(fromNs: number): number {
  return (Bun.nanoseconds() - fromNs) / 1e6;
}
