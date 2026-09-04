/**
 * A minimal OpenRouter chat client. Native `fetch`, no dependency.
 *
 * OpenRouter rather than a hardcoded provider so model choice belongs to whoever runs this
 * -- which is also what makes the harness a BENCHMARK rather than a test of one vendor.
 *
 * The credential travels in a header and never in a query parameter, and no error thrown
 * here quotes a URL with its query intact. Same lesson the `tmdb` plugin bought with
 * `?api_key=` and the Plex mirror bought with its token: a credential in a URL is a logging
 * problem, and every log line is a place it leaks.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** OpenRouter's own figure, in USD. Present when `usage.include` was requested. */
  cost?: number;
  /**
   * Cache accounting, where the provider does any.
   *
   * > [!WARNING] Caching is provider-roulette -- measured 2026-09-04, not assumed
   * > Identical back-to-back calls with a 2-3k token prefix: `z-ai/glm-5.3-flash` served
   * > 2,432 of 2,463 prompt tokens from cache and cost fell 3.3x; `google/gemini-3.8-flash`
   * > cached NOTHING despite the docs listing it as automatic; `anthropic/claude-haiku-4.5`
   * > with an explicit `cache_control` breakpoint cached NOTHING and cost the same on both
   * > passes. So a design that needs caching to be affordable is a design that only works on
   * > some providers. GLM's hit exceeded the message content, which does settle one thing
   * > the docs are silent on: where caching fires at all, the `tools` array is inside the
   * > cached prefix.
   */
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  cache_discount?: number;
}

export interface ChatResponse {
  message: ChatMessage;
  usage: Usage;
  finish_reason: string;
  /** Which upstream actually served it -- OpenRouter routes, so this can differ from `model`. */
  provider?: string;
  /** The model's own thinking, when it emits any. Most do not; absent is the normal case. */
  reasoning?: string;
}

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Rewrite the system message as a content array carrying a cache breakpoint.
 *
 * Only the system message, and only the first one: a breakpoint marks a PREFIX, so putting
 * one further down would cache text that changes between turns and buy nothing.
 */
function withCacheBreakpoint(messages: ChatMessage[]): unknown[] {
  return messages.map((m) =>
    m.role === "system" && typeof m.content === "string"
      ? { role: m.role, content: [{ type: "text", text: m.content, cache_control: { type: "ephemeral" } }] }
      : m,
  );
}

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "OpenRouterError";
  }
}

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  tools?: unknown[];
  temperature?: number;
  /** Hard ceiling on one call, so a runaway model cannot spend the whole budget in one turn. */
  maxTokens?: number;
  signal?: AbortSignal;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  /**
   * Mark the system block as a cache breakpoint.
   *
   * Anthropic and Qwen need this; OpenAI, Gemini and Z.AI are documented as automatic. It
   * goes on the SYSTEM message because the cached prefix is ordered `tools -> system ->
   * messages`, so a breakpoint here is the only one that can cover the schemas -- which are
   * 2,041 of the 2,362 fixed tokens and therefore the whole point.
   */
  cacheSystem?: boolean;
}

export async function chat(opts: ChatOptions): Promise<ChatResponse> {
  const key = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new OpenRouterError(
      "OPENROUTER_API_KEY is not set. The agent surface is opt-in by key: with no key there " +
        "is nothing to run, which is deliberate, not a failure.",
      0,
    );
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      // OpenRouter asks for these for attribution; they are not credentials.
      "http-referer": "https://github.com/aannarr/finderr",
      "x-title": "finderr agent harness",
    },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.cacheSystem ? withCacheBreakpoint(opts.messages) : opts.messages,
      ...(opts.tools?.length ? { tools: opts.tools, tool_choice: "auto" } : {}),
      temperature: opts.temperature ?? 0,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      usage: { include: true },
    }),
    signal: opts.signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new OpenRouterError(`${res.status} ${res.statusText}: ${body.slice(0, 400)}`, res.status);
  }

  const json = (await res.json()) as {
    choices?: { message: ChatMessage; finish_reason: string }[];
    usage?: Usage;
    provider?: string;
    error?: { message?: string };
  };

  const choice = json.choices?.[0];
  if (!choice) {
    throw new OpenRouterError(
      `No choice in response: ${json.error?.message ?? "(no error given)"}`,
      res.status,
    );
  }
  return {
    message: choice.message,
    finish_reason: choice.finish_reason,
    provider: json.provider,
    usage: json.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/**
 * A fragment of a streamed reply.
 *
 * `content` and `reasoning` arrive as many small deltas; `tool_calls` arrive as PARTIAL
 * objects that have to be reassembled by index (see `mergeToolCallDelta`). That reassembly is
 * the whole difficulty of streaming a tool-calling model and it is why this returns a
 * finished `ChatResponse` rather than making every caller do it.
 */
export interface StreamDelta {
  content?: string;
  reasoning?: string;
}

/**
 * OpenRouter's own streamed tool-call shape: an INDEX plus whatever arrived of the call.
 *
 * The arguments come as a string built up character by character across many chunks, so a
 * partial is not parseable JSON and must not be handed to a caller until the stream ends.
 */
interface ToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

/**
 * Fold one streamed tool-call fragment into the accumulator.
 *
 * Keyed by `index` rather than by `id`, because the id only arrives on the FIRST fragment of
 * each call -- later fragments carry the index and nothing else. Keying on id would create a
 * new entry for every argument chunk under key `undefined`, silently collapsing every call
 * into one, and the resulting JSON would parse cleanly while being wrong.
 */
export function mergeToolCallDelta(acc: Map<number, ToolCall>, d: ToolCallDelta): void {
  const cur = acc.get(d.index) ?? {
    id: "",
    type: "function" as const,
    function: { name: "", arguments: "" },
  };
  acc.set(d.index, {
    id: d.id ?? cur.id,
    type: "function",
    function: {
      name: d.function?.name ?? cur.function.name,
      // Concatenated, never replaced: this is the character-by-character argument string.
      arguments: cur.function.arguments + (d.function?.arguments ?? ""),
    },
  });
}

/**
 * Parse one SSE frame's `data:` payload. Returns null for the terminator and for noise.
 *
 * OpenRouter sends `: OPENROUTER PROCESSING` comment lines as keepalives during a long
 * think, and a comment is not an event -- treating one as JSON throws in the middle of a
 * working stream, which is exactly the failure that makes streaming look flaky.
 */
export function parseSseData(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed === "[DONE]") return null;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface StreamOptions extends ChatOptions {
  /** Called for every fragment as it arrives. Throwing here does not stop the stream. */
  onDelta?: (d: StreamDelta) => void;
}

/**
 * The streaming twin of `chat`, returning the SAME `ChatResponse` when the stream ends.
 *
 * Identical return type on purpose: the agent loop needs a complete message with reassembled
 * tool calls before it can act, so streaming changes WHEN the caller learns things, never
 * WHAT it finally gets. That is what lets the runner take one code path and hand progress to
 * a listener rather than growing a second loop.
 *
 * > [!IMPORTANT] USAGE ARRIVES IN THE LAST CHUNK, NOT THE FIRST
 * > `usage: { include: true }` puts the token counts on a final chunk that has no choices.
 * > A parser that stops at the first `finish_reason` never sees it and reports every
 * > streamed run as costing nothing -- which would silently zero the ledger and the daily
 * > cap. Read to the end of the stream, always.
 */
export async function chatStream(opts: StreamOptions): Promise<ChatResponse> {
  const key = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new OpenRouterError("OPENROUTER_API_KEY is not set.", 0);
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "text/event-stream",
      "http-referer": "https://github.com/aannarr/finderr",
      "x-title": "finderr agent",
    },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.cacheSystem ? withCacheBreakpoint(opts.messages) : opts.messages,
      ...(opts.tools?.length ? { tools: opts.tools, tool_choice: "auto" } : {}),
      temperature: opts.temperature ?? 0,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      stream: true,
      usage: { include: true },
    }),
    signal: opts.signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new OpenRouterError(`${res.status} ${res.statusText}: ${body.slice(0, 400)}`, res.status);
  }
  if (!res.body) throw new OpenRouterError("stream had no body", res.status);

  let content = "";
  let reasoning = "";
  let finish = "stop";
  let provider: string | undefined;
  let usage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const calls = new Map<number, ToolCall>();

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    /*
      SPLIT ON A BLANK LINE, NOT ON A NEWLINE.

      An SSE event ends at a blank line and may carry several `data:` lines that join with a
      newline. Splitting per line would cut a multi-line event in half and hand two fragments
      of one JSON object to the parser. Keeping the tail in `buffer` is the other half of the
      same rule: a chunk boundary lands mid-event far more often than not.
    */
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const json = parseSseData(line.slice(5));
        if (!json) continue;

        const choice = (
          json.choices as { delta?: Record<string, unknown>; finish_reason?: string }[] | undefined
        )?.[0];
        if (json.provider) provider = json.provider as string;
        if (json.usage) usage = json.usage as Usage;
        if (choice?.finish_reason) finish = choice.finish_reason;

        const delta = choice?.delta;
        if (!delta) continue;

        if (typeof delta.content === "string" && delta.content) {
          content += delta.content;
          try {
            opts.onDelta?.({ content: delta.content });
          } catch {
            // A listener that throws must not break the stream it is watching.
          }
        }
        // Reasoning models put their thinking here. Most models never send it.
        if (typeof delta.reasoning === "string" && delta.reasoning) {
          reasoning += delta.reasoning;
          try {
            opts.onDelta?.({ reasoning: delta.reasoning });
          } catch {
            // Same reason.
          }
        }
        for (const d of (delta.tool_calls as ToolCallDelta[] | undefined) ?? []) {
          mergeToolCallDelta(calls, d);
        }
      }
    }
  }

  const tool_calls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c);
  return {
    message: {
      role: "assistant",
      content: content || null,
      ...(tool_calls.length > 0 ? { tool_calls } : {}),
    },
    finish_reason: finish,
    provider,
    usage,
    reasoning: reasoning || undefined,
  };
}
