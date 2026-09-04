/**
 * SSE framing, and every way a network can split it.
 *
 * The whole file exists because a chunk boundary lands wherever the network decided, and a
 * `split("\n\n")` parser is correct against every hand-written fixture and wrong the first
 * time an answer arrives in two packets. So the cases here are deliberately about the
 * SPLITS rather than about the payloads.
 */

import { describe, expect, test } from "bun:test";
import { createSseParser, sseFrames } from "./sse";

/** Feed the whole string in one go. */
function frames(text: string) {
  const p = createSseParser();
  return [...p.push(text), ...p.flush()];
}

describe("one frame at a time", () => {
  test("event and data become a frame at the blank line", () => {
    expect(frames('event: token\ndata: {"text":"hi"}\n\n')).toEqual([
      { event: "token", data: '{"text":"hi"}' },
    ]);
  });

  /** The spec strips ONE leading space after the colon, and only one. */
  test("`data:x` and `data: x` are the same frame", () => {
    expect(frames("event: a\ndata:x\n\n")[0].data).toBe("x");
    expect(frames("event: a\ndata:  x\n\n")[0].data).toBe(" x");
  });

  /** Repeated `data:` lines JOIN. Keeping only the last is the classic truncation bug. */
  test("multiple data lines join with newlines", () => {
    expect(frames("event: a\ndata: one\ndata: two\n\n")[0].data).toBe("one\ntwo");
  });

  /** A heartbeat holds a proxy open and is not an event. */
  test("a comment line is not data", () => {
    expect(frames(": keep-alive\n\nevent: a\ndata: x\n\n")).toEqual([{ event: "a", data: "x" }]);
  });

  test("no event field means the spec's default name", () => {
    expect(frames("data: x\n\n")[0].event).toBe("message");
  });
});

describe("chunk boundaries", () => {
  /** THE REASON THIS IS A STATE MACHINE. Split anywhere, get the same frames. */
  test("a frame split across three chunks reassembles", () => {
    const p = createSseParser();
    const out = [...p.push("event: to"), ...p.push('ken\ndata: {"te'), ...p.push('xt":"hello"}\n\n')];
    expect(out).toEqual([{ event: "token", data: '{"text":"hello"}' }]);
  });

  /**
   * A `\r\n` split across two chunks must not read as a blank line and dispatch the frame
   * early, in the middle of its own data.
   */
  test("a CRLF split across two chunks is one terminator", () => {
    const p = createSseParser();
    const out = [...p.push("event: a\r\ndata: x\r"), ...p.push("\n\r\n")];
    expect(out).toEqual([{ event: "a", data: "x" }]);
  });

  test("two frames in one chunk both come out, in order", () => {
    expect(frames("event: turn\ndata: 1\n\nevent: turn\ndata: 2\n\n")).toEqual([
      { event: "turn", data: "1" },
      { event: "turn", data: "2" },
    ]);
  });
});

describe("the end of the stream", () => {
  /**
   * THE FRAME THAT MATTERS MOST IS THE LAST ONE. A server that closes the socket straight
   * after `event: done` sends no trailing blank line, and dropping that frame would lose
   * the authoritative answer of every turn.
   */
  test("a final frame with no trailing blank line still arrives, on flush", () => {
    const p = createSseParser();
    expect(p.push("event: done\ndata: {}")).toEqual([]);
    expect(p.flush()).toEqual([{ event: "done", data: "{}" }]);
  });

  test("flushing an empty parser yields nothing", () => {
    expect(createSseParser().flush()).toEqual([]);
  });
});

describe("reading a Response", () => {
  function streamOf(chunks: readonly string[]): Response {
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        start(c) {
          for (const s of chunks) c.enqueue(encoder.encode(s));
          c.close();
        },
      }),
    );
  }

  test("yields the frames the body carried", async () => {
    const out = [];
    for await (const f of sseFrames(streamOf(["event: turn\ndata: ", '{"n":1}\n\n']))) out.push(f);
    expect(out).toEqual([{ event: "turn", data: '{"n":1}' }]);
  });

  /** A 204, and every faked `Response` in a test. Empty is a state, not an error. */
  test("a body-less response yields nothing rather than throwing", async () => {
    const out = [];
    for await (const f of sseFrames(new Response(null, { status: 204 }))) out.push(f);
    expect(out).toEqual([]);
  });
});
