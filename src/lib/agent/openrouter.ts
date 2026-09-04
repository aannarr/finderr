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
