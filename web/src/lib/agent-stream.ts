/**
 * One turn, streamed -- and the same turn, un-streamed, through the identical callback.
 *
 * Its own file rather than a function in `agent-api.ts` because the two would import each
 * other: the wire shapes live there, the event vocabulary lives in `agent-transcript.ts`,
 * and this is the only thing that needs both. A value cycle between two modules works right
 * up until a bundler splits them differently.
 *
 * > [!IMPORTANT] THE NON-STREAMING PATH IS NOT A SECOND CODE PATH, IT IS ONE SYNTHETIC EVENT
 * > `POST /api/agent/chat` serves SSE only when asked with `Accept: text/event-stream`, and
 * > answers plain JSON otherwise -- so a browser holding a new bundle can meet a server that
 * > has not been upgraded, and must not break. That case is detected from the response's own
 * > `Content-Type` and turned into a single `done` event, which is exactly what a streamed
 * > turn ends with. The caller therefore has ONE reconciliation rule rather than two, and
 * > the fallback is exercised by every test that does not bother to fake a stream.
 */

import { type AgentAnswer, AgentError, CHAT_PATH, refusalOf } from "./agent-api";
import { type AgentEvent, parseAgentEvent } from "./agent-transcript";
import { sseFrames } from "./sse";

/** The fetch to use. Injected by the tests; real callers get the browser's. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Send a message and report everything the server says while answering.
 *
 * `onEvent` is called synchronously as each frame is parsed, so React sees a state update
 * per token rather than one at the end -- which is the entire feature. It resolves when the
 * stream closes; **it does NOT promise that a `done` arrived**, and the caller has to notice
 * that for itself. A stream that ends without one is a turn that died mid-answer, and the
 * bubble says so instead of quietly looking finished.
 */
export async function streamAgentChat(
  message: string,
  conversationId: string | undefined,
  onEvent: (e: AgentEvent) => void,
  opts: { signal?: AbortSignal; fetchImpl?: FetchLike } = {},
): Promise<void> {
  const doFetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  let res: Response;
  try {
    res = await doFetch(CHAT_PATH, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // The whole opt-in. Without it the server answers today's JSON, which is the
        // fallback below rather than an error.
        Accept: "text/event-stream",
      },
      // Absent rather than null on the first turn, the same rule `postAgentChat` follows:
      // "the key is not there" is what the server reads as "this is a new conversation".
      body: JSON.stringify(conversationId ? { message, conversationId } : { message }),
      signal: opts.signal,
    });
  } catch (e) {
    // An abort is the caller's own doing and must not be reported as a server failure.
    if ((e as Error).name === "AbortError") throw e;
    throw new AgentError({ kind: "error", message: "Could not reach finderr." });
  }

  if (!res.ok) throw new AgentError(await refusalOf(res));

  if (!isEventStream(res)) {
    // The server did not upgrade, or something in front of us rewrote the response. Its
    // body is today's `ChatResponse`, which IS the `done` payload.
    const answer = (await res.json()) as AgentAnswer;
    onEvent({ type: "done", answer });
    return;
  }

  for await (const frame of sseFrames(res)) {
    const event = parseAgentEvent(frame);
    // `null` is an event this build does not understand. Ignored rather than thrown on --
    // see `parseAgentEvent`, which is the owner of that forward-compatibility rule.
    if (event) onEvent(event);
  }
}

/**
 * Is this actually a stream?
 *
 * Read from `Content-Type` and never from the status: a proxy that buffers the whole body
 * still labels it, and a server that ignored the `Accept` header labels it `application/json`.
 * The parameter is tolerated (`text/event-stream; charset=utf-8`) because a server is
 * entitled to send one and an exact match would silently take every such deployment down
 * the fallback path -- which works, and would look exactly like streaming being broken.
 */
function isEventStream(res: Response): boolean {
  return (res.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream");
}
