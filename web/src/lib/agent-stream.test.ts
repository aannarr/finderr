/**
 * The streaming client, against a fake fetch.
 *
 * Two properties are worth defending here and neither is about parsing -- `sse.test.ts` owns
 * that. The first is that events reach the caller AS THEY ARRIVE rather than in one batch at
 * the end, because a client that buffers the whole body is indistinguishable from no
 * streaming at all and every test above it would still pass. The second is the FALLBACK: a
 * browser holding a new bundle can meet a server that has not been upgraded, and that
 * server's plain JSON has to arrive as a single `done`.
 */

import { describe, expect, test } from "bun:test";
import { AgentError } from "./agent-api";
import { streamAgentChat } from "./agent-stream";
import type { AgentEvent } from "./agent-transcript";

/** A `Response` whose body is released one chunk per `release()` call. */
function pacedStream(chunks: readonly string[]): { res: Response; release: () => void } {
  const encoder = new TextEncoder();
  let i = 0;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    res: new Response(body, { headers: { "content-type": "text/event-stream" } }),
    release: () => {
      if (!controller) return;
      if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]));
      if (i >= chunks.length) controller.close();
    },
  };
}

function eventStream(text: string): Response {
  return new Response(text, { headers: { "content-type": "text/event-stream; charset=utf-8" } });
}

describe("a streamed turn", () => {
  test("reports every event, in order", async () => {
    const seen: AgentEvent[] = [];
    await streamAgentChat("hi", undefined, (e) => seen.push(e), {
      fetchImpl: async () =>
        eventStream(
          'event: turn\ndata: {"n":1}\n\n' +
            'event: tool\ndata: {"id":"c1","name":"find_title","phase":"start","args":{"name":"Heat"}}\n\n' +
            'event: tool\ndata: {"id":"c1","name":"find_title","phase":"end","ms":12,"summary":"1 match","error":null}\n\n' +
            'event: token\ndata: {"text":"Heat, 1995."}\n\n' +
            'event: done\ndata: {"conversationId":"c","answer":"Heat, 1995.","toolCalls":[],"requested":[],"usage":{"costUsd":0.001,"ms":900}}\n\n',
        ),
    });
    expect(seen.map((e) => e.type)).toEqual(["turn", "tool-start", "tool-end", "token", "done"]);
  });

  /**
   * THE PROPERTY THE WHOLE FEATURE RESTS ON. If the callback only fires once the body has
   * closed, the panel renders a finished transcript and nothing ever builds on screen --
   * which looks exactly like this file not existing.
   */
  test("delivers events BEFORE the body closes", async () => {
    const seen: AgentEvent[] = [];
    const { res, release } = pacedStream([
      'event: token\ndata: {"text":"one "}\n\n',
      'event: token\ndata: {"text":"two"}\n\n',
    ]);
    const done = streamAgentChat("hi", undefined, (e) => seen.push(e), { fetchImpl: async () => res });

    release();
    // One microtask turn is all the reader gets between packets, and it has to be enough.
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toHaveLength(1);

    release();
    await done;
    expect(seen).toHaveLength(2);
  });

  test("asks for a stream, and threads the conversation id", async () => {
    let init: RequestInit | undefined;
    await streamAgentChat("hi", "conv-7", () => {}, {
      fetchImpl: async (_url, i) => {
        init = i;
        return eventStream("");
      },
    });
    expect((init?.headers as Record<string, string> | undefined)?.Accept).toBe("text/event-stream");
    expect(JSON.parse(String(init?.body))).toEqual({ message: "hi", conversationId: "conv-7" });
  });

  /** Absent rather than null on the first turn: that is what the server reads as "new". */
  test("omits the conversation id entirely on the first turn", async () => {
    let body = "";
    await streamAgentChat("hi", undefined, () => {}, {
      fetchImpl: async (_url, i) => {
        body = String(i?.body);
        return eventStream("");
      },
    });
    expect(JSON.parse(body)).toEqual({ message: "hi" });
  });
});

describe("a server that does not stream", () => {
  /**
   * NOT A SECOND CODE PATH. Today's JSON body IS the `done` payload, so it arrives through
   * the same callback and the caller has one reconciliation rule rather than two.
   */
  test("its JSON answer arrives as a single done event", async () => {
    const seen: AgentEvent[] = [];
    await streamAgentChat("hi", undefined, (e) => seen.push(e), {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            conversationId: "c",
            answer: "Heat, 1995.",
            toolCalls: [],
            requested: [],
            usage: { costUsd: 0, ms: 4 },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: "done" });
  });
});

describe("refusals", () => {
  /** The same discriminated refusals the non-streaming client raises; the panel switches on them. */
  test("a 402 is a budget refusal rather than a generic error", async () => {
    const err = await streamAgentChat("hi", undefined, () => {}, {
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: "over_limit", message: "Spent.", retryAfterSeconds: 60 }), {
          status: 402,
          headers: { "content-type": "application/json" },
        }),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).refusal).toMatchObject({ kind: "over-limit", retryAfterSeconds: 60 });
  });

  test("a 404 removes the feature rather than reporting a failure", async () => {
    const err = await streamAgentChat("hi", undefined, () => {}, {
      fetchImpl: async () => new Response("Not Found", { status: 404 }),
    }).catch((e) => e);
    expect((err as AgentError).refusal).toEqual({ kind: "absent" });
  });

  /** A network that is gone is not a server that said something. */
  test("an unreachable server is one sentence, not a stack", async () => {
    const err = await streamAgentChat("hi", undefined, () => {}, {
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch");
      },
    }).catch((e) => e);
    expect((err as AgentError).refusal).toEqual({ kind: "error", message: "Could not reach finderr." });
  });
});
