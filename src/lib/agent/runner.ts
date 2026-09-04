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

import { callSignature, type Facts, factsFrom, ledgerMessage } from "./facts.js";
import { type ChatMessage, chat, type ToolCall } from "./openrouter.js";
import { dispatch, type ResumeStore, TOOL_SCHEMAS } from "./schemas.js";
import type { AgentContext } from "./tools.js";

/**
 * The standing instructions.
 *
 * The last paragraph is the one that matters and it is written from a real failure: asked
 * about a 2026 series, a model answered from its weights, concluded no such show existed,
 * and was wrong -- the title was in the index the whole time. Absence from memory is not
 * evidence of absence, and for anything recent the inference is invalid by construction.
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

Answer in one or two sentences. Name the specific titles and people you found.`;

export interface ToolTrace {
  name: string;
  args: Record<string, unknown>;
  ms: number;
  /** Serialized size of what went back to the model -- the real token driver. */
  bytes: number;
  error?: string;
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
  ctx: AgentContext;
  store: ResumeStore;
  maxTurns?: number;
  maxToolCalls?: number;
  systemPrompt?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  /**
   * Replace the accumulated call/result transcript with a distilled facts ledger.
   *
   * Off by default so the harness can A/B it. See `./facts.ts` for what survives and why the
   * distillation is typed code rather than a summarising model call.
   */
  compact?: boolean;
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
   * The append-only transcript, used when NOT compacting.
   *
   * Under compaction this is never sent: the request is rebuilt from the ledger each turn,
   * which also sidesteps the protocol rule that every `tool_calls` id needs a matching
   * `tool` message -- there is no assistant tool_calls message in the payload to match.
   */
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: opts.question },
  ];

  const facts: Facts = [];
  const priorCalls: string[] = [];

  const toolCalls: ToolTrace[] = [];
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedTokens = 0;
  let costUsd = 0;
  let provider: string | undefined;

  for (let turn = 1; turn <= maxTurns; turn++) {
    // The ledger message is REBUILT rather than appended, and it sits after the question so
    // the stable prefix (tools, system) stays byte-identical and remains cacheable.
    const payload: ChatMessage[] = opts.compact
      ? [
          { role: "system", content: system },
          { role: "user", content: opts.question },
          ...(facts.length > 0 ? [{ role: "user" as const, content: ledgerMessage(facts, priorCalls) }] : []),
        ]
      : messages;

    let reply: Awaited<ReturnType<typeof chat>>;
    try {
      reply = await chat({
        model: opts.model,
        messages: payload,
        tools: TOOL_SCHEMAS,
        apiKey: opts.apiKey,
        fetchImpl: opts.fetchImpl,
        cacheSystem: opts.cacheSystem,
      });
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
      const done = executeOne(opts, call, toolCalls);
      messages.push(done.message);
      if (opts.compact) {
        facts.push(...factsFrom(call.function.name, done.args, done.payload));
        priorCalls.push(callSignature(call.function.name, done.args));
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
