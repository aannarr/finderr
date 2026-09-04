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
}

export interface ChatResponse {
  message: ChatMessage;
  usage: Usage;
  finish_reason: string;
  /** Which upstream actually served it -- OpenRouter routes, so this can differ from `model`. */
  provider?: string;
}

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

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
      messages: opts.messages,
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
