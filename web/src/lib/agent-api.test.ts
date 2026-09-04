/**
 * Which refusal each status means, and what the probe reads out of one.
 *
 * `fetch` is stubbed for the whole file rather than injected, because these two functions
 * are the boundary itself -- a `fetchImpl` parameter would exist only for this test and
 * would let the real call site drift from what is asserted here.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { AgentError, isTerminalRefusal, postAgentChat, probeAgent } from "./agent-api";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Answer every request with this status and body, and record what was sent. */
function stub(status: number, body: unknown): { calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return { calls };
}

async function refusalFrom(status: number, body: unknown) {
  stub(status, body);
  try {
    await postAgentChat("hi");
    throw new Error(`expected ${status} to refuse`);
  } catch (e) {
    expect(e).toBeInstanceOf(AgentError);
    return (e as AgentError).refusal;
  }
}

describe("refusals", () => {
  /**
   * 404 is the whole "this deployment has no assistant" story, and it is the only status
   * whose body is never read -- a 404 from a proxy in front of us carries HTML.
   */
  test("404 is absent, and does not need a body to say so", async () => {
    expect(await refusalFrom(404, undefined)).toEqual({ kind: "absent" });
  });

  test("403 is the admin-only beta, and keeps the server's own sentence", async () => {
    expect(await refusalFrom(403, { error: "beta_admin_only", message: "Admins only for now." })).toEqual({
      kind: "forbidden",
      message: "Admins only for now.",
    });
  });

  test("402 carries what is left and when it comes back", async () => {
    expect(
      await refusalFrom(402, {
        error: "over_daily_limit",
        message: "Today's budget is spent.",
        remainingUsd: 0,
        retryAfterSeconds: 720,
      }),
    ).toEqual({
      kind: "over-limit",
      message: "Today's budget is spent.",
      remainingUsd: 0,
      retryAfterSeconds: 720,
    });
  });

  /**
   * A 402 from something that is not our handler has no JSON at all. Defaulting rather than
   * throwing matters because this runs INSIDE the error path -- a `SyntaxError` here would
   * be reported to the reader instead of the refusal that actually happened.
   */
  test("a refusal with no body still produces a refusal, not a parse error", async () => {
    const r = await refusalFrom(402, undefined);
    expect(r.kind).toBe("over-limit");
    expect(r).toMatchObject({ remainingUsd: 0, retryAfterSeconds: 0 });
  });

  test("429 is a wait", async () => {
    expect(await refusalFrom(429, { error: "rate_limited", message: "Slow down." })).toEqual({
      kind: "rate-limited",
      message: "Slow down.",
    });
  });

  test("anything else is a generic error naming the status", async () => {
    const r = await refusalFrom(500, {});
    expect(r).toEqual({ kind: "error", message: "assistant failed: 500" });
  });

  /**
   * Terminal means "remove the launcher". A budget and a rate limit must NOT be terminal --
   * both refill, and hiding the feature for a wait is how a temporary state becomes a
   * permanent one until the next reload.
   */
  test("only absent and forbidden are terminal", () => {
    expect(isTerminalRefusal({ kind: "absent" })).toBe(true);
    expect(isTerminalRefusal({ kind: "forbidden", message: "" })).toBe(true);
    expect(isTerminalRefusal({ kind: "rate-limited", message: "" })).toBe(false);
    expect(
      isTerminalRefusal({ kind: "over-limit", message: "", remainingUsd: 0, retryAfterSeconds: 1 }),
    ).toBe(false);
  });
});

describe("sending a turn", () => {
  test("the first turn sends no conversation id at all, rather than null", async () => {
    const { calls } = stub(200, { conversationId: "c1", answer: "hi" });
    await postAgentChat("hello");
    // The key being ABSENT is what the server reads as "start a new thread"; a null would
    // be a caller claiming to have one. Same rule `requestBody` follows for `seasons`.
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ message: "hello" });
  });

  test("a later turn echoes the id the server gave us", async () => {
    const { calls } = stub(200, { conversationId: "c1", answer: "hi" });
    await postAgentChat("hello", "c1");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ message: "hello", conversationId: "c1" });
  });
});

describe("the probe", () => {
  /**
   * A GET on a POST-only route. 404 is the ONE status that means absent; a route that
   * exists refuses the method instead, and reading 405 as absent would hide a working
   * assistant.
   */
  test("405 means the route is there", async () => {
    stub(405, {});
    expect(await probeAgent()).toBe("available");
  });

  test("404 means it is not", async () => {
    stub(404, {});
    expect(await probeAgent()).toBe("absent");
  });

  test("403 means it is there and not for this reader", async () => {
    stub(403, {});
    expect(await probeAgent()).toBe("forbidden");
  });

  test("200 counts as available -- the point is only that something answered", async () => {
    stub(200, {});
    expect(await probeAgent()).toBe("available");
  });

  /** No launcher on a broken network is a quiet page; one that errors on click is not. */
  test("a network failure reads as absent rather than throwing", async () => {
    // `unknown` first: `fetch` carries a `preconnect` property that a bare arrow does not,
    // and TypeScript is right to say so rather than being told to overlook it.
    globalThis.fetch = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    expect(await probeAgent()).toBe("absent");
  });
});
