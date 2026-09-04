/**
 * The transcript's rules, each one a property of an event SEQUENCE rather than of a frame.
 *
 * These are the decisions a reader cannot check for themselves: whether a second turn's
 * tokens joined the first turn's sentence, whether a tool call that never came back is
 * still spinning, and whether an authoritative empty answer was allowed to erase prose that
 * was already on screen. All three are invisible on a good day and wrong on a bad one.
 */

import { describe, expect, test } from "bun:test";
import type { AgentAnswer } from "./agent-api";
import {
  type AgentEvent,
  abandonTranscript,
  applyAgentEvent,
  emptyTranscript,
  hasProse,
  parseAgentEvent,
  reconcileAnswer,
  settleTranscript,
  streamedText,
  type ToolEntry,
  type Transcript,
} from "./agent-transcript";

/** Fold a whole sequence, the way a live turn does. */
function fold(events: readonly AgentEvent[]): Transcript {
  return events.reduce(applyAgentEvent, emptyTranscript());
}

const tools = (t: Transcript): ToolEntry[] => t.entries.filter((e): e is ToolEntry => e.kind === "tool");

describe("parsing a frame", () => {
  test("a token frame becomes a token event", () => {
    expect(parseAgentEvent({ event: "token", data: '{"text":"hi"}' })).toEqual({ type: "token", text: "hi" });
  });

  test("a tool frame splits on its phase", () => {
    expect(
      parseAgentEvent({
        event: "tool",
        data: '{"id":"c1","name":"list_episodes","phase":"start","args":{"tconst":"tt1"}}',
      }),
    ).toEqual({ type: "tool-start", id: "c1", name: "list_episodes", args: { tconst: "tt1" } });
    expect(
      parseAgentEvent({
        event: "tool",
        data: '{"id":"c1","name":"list_episodes","phase":"end","ms":8,"summary":"24 episodes","error":null}',
      }),
    ).toEqual({
      type: "tool-end",
      id: "c1",
      name: "list_episodes",
      ms: 8,
      summary: "24 episodes",
      error: null,
    });
  });

  /**
   * FORWARD COMPATIBILITY. A server that grows a `citation` event must not take the panel
   * down in a browser holding last week's bundle -- the frame costs itself and nothing else.
   */
  test("an unknown event name is ignored rather than thrown on", () => {
    expect(parseAgentEvent({ event: "citation", data: "{}" })).toBeNull();
  });

  test("a data line that is not JSON costs that frame only", () => {
    expect(parseAgentEvent({ event: "token", data: "not json" })).toBeNull();
  });

  /**
   * An empty delta is not an event. Admitting one would open a "Thinking" block for a model
   * that emits a keep-alive and has nothing to think out loud about.
   */
  test("an empty reasoning delta is not an event", () => {
    expect(parseAgentEvent({ event: "reasoning", data: '{"text":""}' })).toBeNull();
  });
});

describe("prose blocks", () => {
  test("consecutive tokens append to one block", () => {
    const t = fold([
      { type: "token", text: "Here " },
      { type: "token", text: "you go." },
    ]);
    expect(t.entries).toHaveLength(1);
    expect(streamedText(t)).toBe("Here you go.");
  });

  /**
   * THE MULTI-TURN RULE. Turn 2's tokens are a new pass of the loop, not a continuation of
   * turn 1's sentence -- joining them renders the transcript as one run-on paragraph
   * interrupted by machinery.
   */
  test("a new turn opens a new block instead of continuing the sentence", () => {
    const t = fold([
      { type: "token", text: "Let me look." },
      { type: "turn", n: 2 },
      { type: "token", text: "Three films match." },
    ]);
    expect(t.entries).toHaveLength(2);
    expect(t.entries.map((e) => e.turn)).toEqual([1, 2]);
  });

  /** A lookup between two bursts is a seam too: they are prose about different things. */
  test("a tool call between two token bursts splits them", () => {
    const t = fold([
      { type: "token", text: "Checking." },
      { type: "tool-start", id: "c1", name: "find_title", args: { name: "Heat" } },
      { type: "token", text: "Found it." },
    ]);
    expect(t.entries.map((e) => e.kind)).toEqual(["text", "tool", "text"]);
  });

  test("reasoning and visible text never share a block", () => {
    const t = fold([
      { type: "reasoning", text: "thinking" },
      { type: "token", text: "answer" },
    ]);
    expect(t.entries.map((e) => e.kind)).toEqual(["reasoning", "text"]);
  });

  test("every entry gets a distinct key", () => {
    const t = fold([
      { type: "token", text: "a" },
      { type: "tool-start", id: "c1", name: "get_title", args: {} },
      { type: "turn", n: 2 },
      { type: "token", text: "b" },
    ]);
    expect(new Set(t.entries.map((e) => e.key)).size).toBe(t.entries.length);
  });
});

describe("tool calls", () => {
  test("a start then an end is one settled row", () => {
    const t = fold([
      { type: "tool-start", id: "c1", name: "list_episodes", args: { tconst: "tt0944947" } },
      { type: "tool-end", id: "c1", name: "list_episodes", ms: 8, summary: "24 episodes", error: null },
    ]);
    expect(tools(t)).toHaveLength(1);
    expect(tools(t)[0]).toMatchObject({ state: "done", ms: 8, summary: "24 episodes" });
  });

  /** The same tool twice in one turn is ordinary and must not be collapsed into one row. */
  test("two calls to one tool are two rows", () => {
    const t = fold([
      { type: "tool-start", id: "c1", name: "get_title", args: { tconst: "tt1" } },
      { type: "tool-start", id: "c2", name: "get_title", args: { tconst: "tt2" } },
    ]);
    expect(tools(t)).toHaveLength(2);
  });

  /** Opening the panel mid-run, or a lost `start`. A finished row is the honest maximum. */
  test("an end with no start is still recorded", () => {
    const t = fold([
      { type: "tool-end", id: "c9", name: "find_title", ms: 3, summary: "1 match", error: null },
    ]);
    expect(tools(t)).toHaveLength(1);
    expect(tools(t)[0]).toMatchObject({ state: "done", args: {} });
  });

  /**
   * THE ONE THAT MATTERS. A `start` whose `end` never came must stop looking like work in
   * progress the moment the stream ends -- a spinner outliving its request is a lie that
   * nothing on screen can contradict.
   */
  test("a start with no end becomes `unfinished` when the stream dies", () => {
    const t = abandonTranscript(
      fold([{ type: "tool-start", id: "c1", name: "find_connections", args: { from: "tt1", to: "tt2" } }]),
    );
    expect(tools(t)[0].state).toBe("unfinished");
  });

  /** `done` means the run completed, so the call did too -- we merely never saw its frame. */
  test("a start with no end is settled, not abandoned, when `done` arrives", () => {
    const t = settleTranscript(fold([{ type: "tool-start", id: "c1", name: "get_title", args: {} }]), []);
    expect(tools(t)[0].state).toBe("done");
    expect(tools(t)[0].ms).toBeUndefined();
  });
});

describe("settling on `done`", () => {
  test("streamed text entries are dropped, and the machinery is kept", () => {
    const t = settleTranscript(
      fold([
        { type: "reasoning", text: "hm" },
        { type: "token", text: "partial" },
        { type: "tool-start", id: "c1", name: "get_title", args: { tconst: "tt1" } },
        { type: "tool-end", id: "c1", name: "get_title", ms: 4, summary: null, error: null },
      ]),
      [],
    );
    expect(t.entries.map((e) => e.kind)).toEqual(["reasoning", "tool"]);
  });

  /**
   * A server that streams tokens but no tool frames -- and the JSON fallback, which arrives
   * as one synthetic `done`. Its `toolCalls` become the rows nobody streamed.
   */
  test("a stream with no tool frames adopts the answer's toolCalls", () => {
    const t = settleTranscript(fold([{ type: "token", text: "hi" }]), [
      { name: "find_title", args: { name: "Heat" }, ms: 12 },
    ]);
    expect(tools(t)).toHaveLength(1);
    expect(tools(t)[0]).toMatchObject({ name: "find_title", ms: 12, state: "done" });
  });

  /** Both lists are reports of the SAME calls, so merging them would draw every row twice. */
  test("a stream that DID carry tool frames ignores the answer's copy", () => {
    const t = settleTranscript(
      fold([
        { type: "tool-start", id: "c1", name: "find_title", args: {} },
        { type: "tool-end", id: "c1", name: "find_title", ms: 12, summary: "1 match", error: null },
      ]),
      [
        { name: "find_title", args: {}, ms: 12 },
        { name: "get_title", args: {}, ms: 3 },
      ],
    );
    expect(tools(t)).toHaveLength(1);
  });
});

describe("who owns the prose", () => {
  /**
   * THE REGRESSION, found in a browser 2026-09-05 and invisible to every test above it.
   * A bubble has two places prose can live -- the transcript's interleaved `text` entries
   * and the bubble's own settled `text` -- and both were rendered, so every streamed
   * sentence appeared twice. The two copies are identical and each is individually correct,
   * which is why nothing caught it.
   */
  test("a streaming transcript owns it", () => {
    expect(hasProse(fold([{ type: "token", text: "Season 4" }]).entries)).toBe(true);
  });

  /** A settled turn hands the job back to the authoritative answer. */
  test("a settled one does not", () => {
    const t = settleTranscript(
      fold([
        { type: "token", text: "Season 4" },
        { type: "tool-start", id: "c1", name: "get_title", args: {} },
      ]),
      [],
    );
    expect(hasProse(t.entries)).toBe(false);
  });

  /** A turn that DIED keeps its interleaving: there is no authoritative answer to swap in. */
  test("an abandoned one keeps it", () => {
    const t = abandonTranscript(fold([{ type: "token", text: "Season 4 is" }]));
    expect(hasProse(t.entries)).toBe(true);
  });

  test("machinery alone owns nothing", () => {
    expect(hasProse(fold([{ type: "reasoning", text: "hm" }]).entries)).toBe(false);
  });
});

describe("token versus `done`", () => {
  /** `done` is authoritative: a retry or a truncation makes the two differ, and it wins. */
  test("the authoritative answer replaces what streamed", () => {
    expect(reconcileAnswer("half a sen", "The full, revised answer.")).toBe("The full, revised answer.");
  });

  /**
   * THE ONE EXCEPTION, and it is data loss otherwise. A server that streams a paragraph and
   * then sends `{"answer":""}` is reporting a failure of its own; wiping the reader's screen
   * is a worse way to tell them than the incomplete note is.
   */
  test("an EMPTY authoritative answer does not erase prose already on screen", () => {
    expect(reconcileAnswer("Three films match.", "")).toBe("Three films match.");
    expect(reconcileAnswer("Three films match.", "   ")).toBe("Three films match.");
  });

  test("both empty is empty", () => {
    expect(reconcileAnswer("", "")).toBe("");
  });
});

describe("a whole turn, end to end", () => {
  const answer: AgentAnswer = {
    conversationId: "c",
    answer: "Season 2 is the best one.",
    toolCalls: [{ name: "list_episodes", args: { tconst: "tt0944947" }, ms: 8 }],
    requested: [],
    usage: { costUsd: 0.002, ms: 1800 },
  };

  test("builds progressively and then adopts the answer", () => {
    // Mid-flight: the reader is watching prose and a spinner.
    const midway = fold([
      { type: "turn", n: 1 },
      { type: "reasoning", text: "Which season?" },
      { type: "tool-start", id: "c1", name: "list_episodes", args: { tconst: "tt0944947" } },
    ]);
    expect(tools(midway)[0].state).toBe("running");

    const complete = fold([
      { type: "turn", n: 1 },
      { type: "reasoning", text: "Which season?" },
      { type: "tool-start", id: "c1", name: "list_episodes", args: { tconst: "tt0944947" } },
      { type: "tool-end", id: "c1", name: "list_episodes", ms: 8, summary: "24 episodes", error: null },
      { type: "turn", n: 2 },
      { type: "token", text: "Season 2 " },
      { type: "token", text: "is the best one." },
    ]);
    expect(streamedText(complete)).toBe("Season 2 is the best one.");

    const settled = settleTranscript(complete, answer.toolCalls);
    expect(settled.entries.map((e) => e.kind)).toEqual(["reasoning", "tool"]);
    expect(reconcileAnswer(streamedText(complete), answer.answer)).toBe("Season 2 is the best one.");
  });
});
