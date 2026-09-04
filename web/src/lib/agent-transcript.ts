/**
 * THE TURN, AS A TRANSCRIPT: the streamed event vocabulary and the thing it assembles into.
 *
 * The assistant does not answer once. It runs a loop -- it thinks, calls a tool, reads the
 * result, thinks again, calls another -- and until this file existed every bit of that was
 * thrown away and the reader watched a spinner for thirty seconds. aannarr, 2026-09-05:
 * *"not `hey` ==============> `single response to one turn`.. that's not cool!"* So the
 * shape rendered is the ORDER THINGS HAPPENED IN, built as it arrives, rather than one
 * bubble that appears at the end.
 *
 * Pure and DOM-free, like `assistant-view.ts` beside it: an event sequence in, a transcript
 * out. Everything here that can be wrong -- what happens on a `tool` start with no `end`,
 * what a second turn's tokens do to the first turn's paragraph, whether `done` may erase a
 * visible answer -- is decidable from a plain array, and each one is pinned by a test.
 *
 * > [!IMPORTANT] `done` IS AUTHORITATIVE, AND THAT IS NOT THE SAME AS "done overwrites"
 * > Tokens exist for the live feel; the `done` frame carries the truth, and the two CAN
 * > differ (a retry, a truncation, a model that revised itself). So `done` wins -- with one
 * > exception, in `reconcileAnswer`: an EMPTY authoritative answer does not get to erase
 * > prose the reader already watched arrive. That is data loss wearing authority's clothes,
 * > and it costs one branch to refuse it.
 */

import type { AgentAnswer, AgentToolCall } from "./agent-api";
import type { SseFrame } from "./sse";

// --- the wire vocabulary ---------------------------------------------------

/**
 * One thing the server said while working.
 *
 * A discriminated union rather than the raw `{event, data}` pair, because every consumer
 * switches on it and a string comparison against `"tool"` plus a nested `phase` check is
 * two decisions where one will do.
 */
export type AgentEvent =
  /** A new pass of the loop. Turn 2's tokens are a NEW BLOCK, not a continued sentence. */
  | { type: "turn"; n: number }
  /**
   * The model's own thinking, incremental.
   *
   * OPTIONAL AND USUALLY ABSENT -- only some models emit it, and a deployment that never
   * sees one is working correctly. Nothing may draw an empty "Thinking" block on the
   * strength of the event existing in this union.
   */
  | { type: "reasoning"; text: string }
  /** Visible assistant text, incremental. */
  | { type: "token"; text: string }
  | { type: "tool-start"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool-end"; id: string; name: string; ms: number; summary: string | null; error: string | null }
  /** The full answer, in today's non-streaming shape. Authoritative. */
  | { type: "done"; answer: AgentAnswer }
  | { type: "error"; message: string };

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asNullableString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * A frame, as the event it means -- or `null`.
 *
 * `null` for anything this build does not understand, and that is FORWARD COMPATIBILITY
 * rather than leniency: a server that grows a `citation` event must not take the panel down
 * in a browser holding a cached bundle from last week. Same rule an unknown plugin group
 * follows on the server, for the same reason.
 *
 * Every field is read defensively. This is a parser over a network payload, and one
 * `data:` line that is not the JSON we expected must cost that frame and nothing else.
 */
export function parseAgentEvent(frame: SseFrame): AgentEvent | null {
  let body: unknown;
  try {
    body = JSON.parse(frame.data);
  } catch {
    return null;
  }
  const d = asRecord(body);
  switch (frame.event) {
    case "turn": {
      const n = typeof d.n === "number" && Number.isFinite(d.n) ? Math.trunc(d.n) : 0;
      return n > 0 ? { type: "turn", n } : null;
    }
    case "reasoning": {
      const text = asString(d.text);
      // An empty delta is not an event. Admitting one would open a reasoning block for a
      // model that emits a keep-alive and has nothing to think out loud about.
      return text ? { type: "reasoning", text } : null;
    }
    case "token": {
      const text = asString(d.text);
      return text ? { type: "token", text } : null;
    }
    case "tool": {
      const id = asString(d.id);
      const name = asString(d.name);
      if (!id || !name) return null;
      if (d.phase === "start") return { type: "tool-start", id, name, args: asRecord(d.args) };
      if (d.phase === "end") {
        return {
          type: "tool-end",
          id,
          name,
          ms: typeof d.ms === "number" && Number.isFinite(d.ms) ? d.ms : 0,
          summary: asNullableString(d.summary),
          error: asNullableString(d.error),
        };
      }
      return null;
    }
    case "done":
      // The whole of today's `ChatResponse`, unchanged. The client already renders from the
      // structured fields, so the streaming path adds no second shape to keep in step.
      return { type: "done", answer: body as AgentAnswer };
    case "error":
      return { type: "error", message: asString(d.message) || "The assistant could not answer." };
    default:
      return null;
  }
}

// --- what it assembles into ------------------------------------------------

/** A tool call, from the moment it was announced to whatever became of it. */
export interface ToolEntry {
  kind: "tool";
  /** React's key. Sequence-derived, so a server repeating a call id cannot collide. */
  key: string;
  turn: number;
  /** The server's id, which is what a later `end` frame is matched against. */
  callId: string;
  name: string;
  args: Record<string, unknown>;
  /**
   * `unfinished` is the one worth having.
   *
   * A `start` whose `end` never came, because the run died. Drawing it as `running` forever
   * is a spinner that outlives the request it is reporting on -- so the stream ending is
   * what converts every survivor, and the renderer says "did not finish" rather than
   * animating.
   */
  state: "running" | "done" | "unfinished";
  ms?: number;
  /** What came back, in the server's words: "24 episodes", "no match". */
  summary?: string | null;
  error?: string | null;
}

/** Prose, either the model's thinking or its visible answer. */
export interface ProseEntry {
  kind: "reasoning" | "text";
  key: string;
  turn: number;
  text: string;
}

export type TranscriptEntry = ToolEntry | ProseEntry;

export interface Transcript {
  /** Which pass of the loop is running. Every entry opened from here carries it. */
  turn: number;
  /** Monotonic, only ever used to name entries. */
  seq: number;
  entries: TranscriptEntry[];
}

export function emptyTranscript(): Transcript {
  return { turn: 1, seq: 0, entries: [] };
}

export function isEmptyTranscript(t: Transcript | undefined): boolean {
  return !t || t.entries.length === 0;
}

/**
 * Fold one event in. Immutable, because this is React state and a mutated array does not
 * re-render.
 *
 * `done` and `error` are deliberately NOT handled here: they end the turn rather than adding
 * to it, and the reconciliation they trigger belongs to the caller that also owns the
 * bubble's text, its usage and its cards. Passing one in is a no-op rather than a throw.
 */
export function applyAgentEvent(t: Transcript, e: AgentEvent): Transcript {
  switch (e.type) {
    case "turn":
      // Nothing is appended. A turn marker is not an entry -- entries CARRY the turn, which
      // is what makes "turn 2's tokens open a new block" fall out of the append rule below
      // instead of needing a second rule about markers.
      return e.n === t.turn ? t : { ...t, turn: e.n };

    case "reasoning":
      return appendProse(t, "reasoning", e.text);

    case "token":
      return appendProse(t, "text", e.text);

    case "tool-start": {
      // A repeated id is treated as a NEW call rather than deduplicated: the same tool
      // called twice in one turn is ordinary, and a server reusing an id is a server bug we
      // would be hiding by collapsing two real calls into one row.
      const key = `e${t.seq + 1}`;
      const entry: ToolEntry = {
        kind: "tool",
        key,
        turn: t.turn,
        callId: e.id,
        name: e.name,
        args: e.args,
        state: "running",
      };
      return { ...t, seq: t.seq + 1, entries: [...t.entries, entry] };
    }

    case "tool-end": {
      // Matched from the END backwards, so a repeated id closes the most recent open call.
      const i = lastIndex(t.entries, (x) => x.kind === "tool" && x.callId === e.id && x.state === "running");
      if (i === -1) {
        /*
          AN `end` WITH NO `start` IS STILL A FACT, so it is recorded rather than dropped.

          It is what a reader sees when the panel was opened mid-run, or when a `start`
          frame was lost. Inventing nothing would leave the transcript claiming the model
          answered out of thin air; a finished row with no arguments is the honest maximum.
        */
        const key = `e${t.seq + 1}`;
        const entry: ToolEntry = {
          kind: "tool",
          key,
          turn: t.turn,
          callId: e.id,
          name: e.name,
          args: {},
          state: "done",
          ms: e.ms,
          summary: e.summary,
          error: e.error,
        };
        return { ...t, seq: t.seq + 1, entries: [...t.entries, entry] };
      }
      const entries = t.entries.slice();
      entries[i] = {
        ...(entries[i] as ToolEntry),
        state: "done",
        ms: e.ms,
        summary: e.summary,
        error: e.error,
      };
      return { ...t, entries };
    }

    default:
      return t;
  }
}

/**
 * Append a delta to the open block of this kind and turn, or open a new one.
 *
 * THE WHOLE MULTI-TURN RULE IS THIS ONE CONDITION. A delta joins the last entry only when
 * that entry is the same kind AND the same turn AND is still the last thing in the
 * transcript -- so a tool call between two token bursts splits them, and so does a new turn.
 * Without the split, turn 2's first word lands on the end of turn 1's sentence and the whole
 * transcript reads as one run-on paragraph interrupted by machinery.
 */
function appendProse(t: Transcript, kind: "reasoning" | "text", text: string): Transcript {
  const last = t.entries[t.entries.length - 1];
  if (last && last.kind === kind && last.turn === t.turn) {
    const entries = t.entries.slice();
    entries[entries.length - 1] = { ...(last as ProseEntry), text: last.text + text };
    return { ...t, entries };
  }
  const key = `e${t.seq + 1}`;
  return { ...t, seq: t.seq + 1, entries: [...t.entries, { kind, key, turn: t.turn, text }] };
}

function lastIndex<T>(xs: readonly T[], pred: (x: T) => boolean): number {
  for (let i = xs.length - 1; i >= 0; i--) if (pred(xs[i])) return i;
  return -1;
}

/** Everything the model has said out loud so far, turns joined as separate paragraphs. */
export function streamedText(t: Transcript): string {
  return t.entries
    .filter((e): e is ProseEntry => e.kind === "text")
    .map((e) => e.text)
    .join("\n\n")
    .trim();
}

/** Is anything still in flight? Drives the "working" affordance and nothing else. */
export function hasRunningTool(t: Transcript): boolean {
  return t.entries.some((e) => e.kind === "tool" && e.state === "running");
}

/**
 * DOES THE TRANSCRIPT OWN THE PROSE?
 *
 * The one rule that stops an answer being drawn twice. A bubble has two places prose can
 * live -- the transcript's `text` entries, which are interleaved between the lookups in the
 * order everything happened, and the bubble's own `text` field, which is the settled answer.
 * Both were rendered, and mid-stream that printed every sentence on screen twice; measured
 * in a browser 2026-09-05 and invisible in every test, because the two copies are identical
 * and each one is individually correct.
 *
 * So the transcript wins whenever it has any prose of its own, which is exactly the two
 * states where interleaving is what a reader wants: mid-stream, and after a turn that died.
 * `settleTranscript` empties them on a completed turn, which is what hands the job back to
 * the authoritative `text`.
 */
export function hasProse(entries: readonly TranscriptEntry[]): boolean {
  return entries.some((e) => e.kind === "text");
}

// --- ending the turn -------------------------------------------------------

/**
 * The turn completed: adopt `done` as the record of what happened.
 *
 * Two things happen and both are decisions rather than housekeeping.
 *
 * **Text entries are DROPPED.** `done.answer` is the authoritative prose and the bubble
 * renders it; leaving the streamed blocks in the transcript would draw the answer twice,
 * once as it arrived and once as it finally read. What survives is the part `done` does not
 * carry -- the reasoning and the lookups, in the order they happened, which is the whole
 * point of keeping a transcript at all.
 *
 * **A tool still `running` is marked `done`, not `unfinished`.** The run finished, so that
 * call finished too and we merely never saw its frame. Its duration stays absent rather
 * than being guessed at from the turn's total.
 *
 * `toolCalls` from the answer is the FALLBACK, used only when the stream recorded no tool
 * entries at all -- a server that streams tokens but not tool frames, or a fallback JSON
 * response synthesised into one `done`. Merging the two lists in the normal case would
 * double every row, because they are two reports of the same calls.
 */
export function settleTranscript(t: Transcript, toolCalls: readonly AgentToolCall[]): Transcript {
  const kept = t.entries.filter((e) => e.kind !== "text");
  const hasTools = kept.some((e) => e.kind === "tool");
  const entries: TranscriptEntry[] = kept.map((e) =>
    e.kind === "tool" && e.state === "running" ? { ...e, state: "done" as const } : e,
  );
  let seq = t.seq;
  if (!hasTools) {
    for (const c of toolCalls) {
      seq += 1;
      entries.push({
        kind: "tool",
        key: `e${seq}`,
        turn: t.turn,
        callId: `settled-${seq}`,
        name: c.name,
        args: c.args,
        state: "done",
        ms: c.ms,
        summary: null,
        error: null,
      });
    }
  }
  return { ...t, seq, entries };
}

/**
 * The stream died. Keep everything, and stop pretending anything is still working.
 *
 * The text entries are KEPT here, unlike `settleTranscript` -- there is no authoritative
 * answer to replace them with, and what arrived is all the reader is going to get, in the
 * places between the lookups where it arrived. `hasProse` is what stops the bubble drawing
 * it a second time. The bubble marks itself incomplete beside it; a truncated answer drawn
 * as a finished one is the failure this exists to prevent.
 */
export function abandonTranscript(t: Transcript): Transcript {
  return {
    ...t,
    entries: t.entries.map((e) =>
      e.kind === "tool" && e.state === "running" ? { ...e, state: "unfinished" } : e,
    ),
  };
}

/**
 * The answer, after `done`.
 *
 * `done` wins, because the tokens were for the live feel and this is the truth. The one
 * exception: an authoritative answer that is EMPTY does not erase prose the reader already
 * watched arrive. A server that streams text and then sends `{"answer":""}` is reporting a
 * failure of its own, and the reader losing a paragraph off their screen is a worse way to
 * be told about it than the incomplete note is.
 */
export function reconcileAnswer(streamed: string, authoritative: string): string {
  const settled = authoritative.trim();
  return settled.length > 0 ? settled : streamed.trim();
}
