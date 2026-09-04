/**
 * The assistant's state and its one side effect, held ABOVE the panel.
 *
 * The panel is closed far more often than it is open, and a turn takes seconds -- so the
 * conversation cannot live inside a component that unmounts when the panel closes, or
 * closing it mid-answer would drop the answer on the floor. Same split as `useTitleDetail`:
 * the policy is here, the drawing is in the component.
 *
 * > [!IMPORTANT] A TURN IS A TRANSCRIPT THAT BUILDS ITSELF, NOT A RESPONSE THAT APPEARS
 * > The agent runs a LOOP -- think, call a tool, read the result, think again -- and until
 * > this file streamed it, all of that was thrown away and the reader watched a spinner for
 * > thirty seconds. Every event is folded into the answer bubble AS IT ARRIVES, so the
 * > bubble's `transcript` and `text` both grow on screen. `agent-transcript.ts` owns the
 * > folding rules and is where a change to them goes.
 * >
 * > **`done` is authoritative.** The tokens are for the live feel; when the final frame
 * > lands, `answer`, `titles`, `episodes`, `requested` and `usage` all come from it and
 * > replace what was accumulated. They CAN differ -- a retry, a truncation -- and `done`
 * > wins, with the one exception `reconcileAnswer` documents.
 *
 * > [!CAUTION] A stream that ends without `done` is INCOMPLETE, and must never look finished
 * > Whatever arrived is kept, the bubble is marked, and the panel says so. A truncated
 * > answer drawn like a finished one is unfalsifiable from the reader's side: a model that
 * > stopped mid-sentence and one that had nothing more to say produce the same screen.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { type AgentAnswer, AgentError, type AgentRefusal, isTerminalRefusal } from "./agent-api";
import {
  browserStore,
  clearConversation,
  EMPTY_CONVERSATION,
  type KeyValueStore,
  readConversation,
  type StoredConversation,
  type StoredMessage,
  writeConversation,
} from "./agent-store";
import { streamAgentChat } from "./agent-stream";
import {
  type AgentEvent,
  abandonTranscript,
  applyAgentEvent,
  emptyTranscript,
  reconcileAnswer,
  settleTranscript,
  streamedText,
  type Transcript,
} from "./agent-transcript";

/**
 * Ids for bubbles, and they are deliberately not `crypto.randomUUID`.
 *
 * A React key needs to be unique within this list and stable across renders; it is never
 * sent anywhere and never compared to a server id. `randomUUID` is also unavailable in the
 * one place this product mostly runs -- a plain-http LAN address is not a secure context.
 *
 * > [!CAUTION] A BARE COUNTER IS NOT ENOUGH, AND THE FAILURE IS DATA LOSS
 * > It was `m1`, `m2`, `m3` from a module-level counter, and that counter restarts at 1 on
 * > every page load while the conversation it is numbering does NOT -- it is read back from
 * > `localStorage`. So the first bubble of a reloaded session was handed the id of a
 * > restored bubble, and `send`'s `messages.map(m => m.id === answerId ? ... : m)` rewrote
 * > BOTH: one turn's answer was replaced by the next turn's, and the reader watched an
 * > answer they had already read turn into an error.
 * >
 * > Caught in a browser on 2026-09-05, not by a test: within one page load the ids are
 * > perfectly unique, so nothing in a single process can see it. The salt is what makes two
 * > page loads two id spaces, and `idsFrom` is what makes that testable -- two factories
 * > stand in for two loads.
 *
 * `Math.random` is fine for this and `randomUUID` would not be an upgrade: the requirement
 * is "does not collide with the last session's", not unguessability.
 */
export function idsFrom(): () => string {
  const salt = Math.random().toString(36).slice(2, 8);
  let n = 0;
  return () => `${salt}-${++n}`;
}

const bubbleId = idsFrom();

/** What the assistant answered, folded into a bubble. */
function answerBubble(id: string, at: number, answer: AgentAnswer): StoredMessage {
  return {
    id,
    role: "assistant",
    text: answer.answer,
    at,
    toolCalls: answer.toolCalls,
    requested: answer.requested,
    titles: answer.titles,
    episodes: answer.episodes,
    problems: answer.problems,
    usage: answer.usage,
  };
}

/**
 * What the reader typed while a turn was still running.
 *
 * NOT a `StoredMessage` and never in `messages`: it has not been sent, so it is not part of
 * the conversation and must not be persisted as if it were. A reload that resurrected a
 * message nobody sent would be a question answered days late, out of context.
 */
export interface QueuedMessage {
  id: string;
  text: string;
}

/** The sentence a turn that died mid-stream gets. */
export const INCOMPLETE_NOTE = "The connection dropped before this answer finished.";

export interface AssistantChat {
  messages: readonly StoredMessage[];
  /** A turn is in flight. The composer disables and the last bubble shows it thinking. */
  busy: boolean;
  /**
   * The last refusal, or null.
   *
   * Held apart from the messages because it is about the SERVICE rather than about a turn:
   * "the budget is spent until 14:20" stays true for the next attempt too, so it belongs
   * above the composer where somebody about to type will see it, not buried up the thread.
   */
  refusal: AgentRefusal | null;
  /** Waiting to be sent, in order. Drawn as pending, each one cancellable. */
  queued: readonly QueuedMessage[];
  /** The drain stopped because a turn failed. Nothing will be sent until it is resumed. */
  queueHalted: boolean;
  send: (message: string) => void;
  cancelQueued: (id: string) => void;
  resumeQueue: () => void;
  clear: () => void;
}

/**
 * `onGone` fires when the server says the feature is not there for this reader -- 404 or
 * 403 arriving on a real turn, which is how a probe that succeeded at boot gets corrected
 * by a deploy or a role change. The launcher removes itself rather than offering a control
 * that can only fail.
 */
export function useAssistantChat(opts: {
  userId: string | null;
  onGone?: (refusal: AgentRefusal) => void;
  /** Injected by the tests. Real callers take the browser's. */
  store?: KeyValueStore | null;
}): AssistantChat {
  const { userId, onGone } = opts;
  // Resolved ONCE rather than per render: `browserStore()` is a `try` around a property
  // access that throws in a browser with site data blocked, and there is no reason to pay
  // for that on every keystroke.
  const storeRef = useRef<KeyValueStore | null | undefined>(opts.store);
  if (storeRef.current === undefined) storeRef.current = browserStore();
  const store = storeRef.current;

  const [conv, setConv] = useState<StoredConversation>(EMPTY_CONVERSATION);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<AgentRefusal | null>(null);
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  const [queueHalted, setQueueHalted] = useState(false);

  // Restored in an effect rather than in a `useState` initialiser, because the reader is
  // not known on the first render -- `RootLayout` fetches `me` and the id arrives a tick
  // later. Re-running on a changed id is also what swaps conversations when somebody signs
  // out and somebody else signs in without a reload.
  useEffect(() => {
    setConv(readConversation(store, userId));
  }, [store, userId]);

  /*
    THE THREE REFS, and each one exists because an async turn outlives the render it started in.

    `queueRef` is what the drain reads -- reading `queued` would hand the continuation the
    array as it was when the turn began. `inFlight` enforces ONE TURN AT A TIME: the server
    threads `conversationId`, so two overlapping posts race one conversation and the second
    one's history is whatever the first had written by then. `generation` is the guard
    against a turn that outlives its own conversation -- `clear()` bumps it, and every
    callback checks it before writing, so a cleared thread cannot be resurrected by an
    answer that was already in flight.
  */
  const queueRef = useRef<QueuedMessage[]>([]);
  const inFlight = useRef(false);
  const generation = useRef(0);
  /** The turn in flight, so `clear` can end it rather than merely disowning it. */
  const abort = useRef<AbortController | null>(null);
  const latest = useRef(conv);
  latest.current = conv;

  const pushQueue = useCallback((entry: QueuedMessage) => {
    queueRef.current = [...queueRef.current, entry];
    setQueued(queueRef.current);
  }, []);

  const shiftQueue = useCallback((): QueuedMessage | undefined => {
    const [head, ...rest] = queueRef.current;
    queueRef.current = rest;
    setQueued(rest);
    return head;
  }, []);

  /**
   * One turn, start to finish.
   *
   * Declared through a ref so the drain at the bottom can call it recursively without the
   * two `useCallback`s having to reference each other, which is a cycle TypeScript cannot
   * see through and React would re-create on every render anyway.
   */
  const runTurnRef = useRef<(message: string) => Promise<void>>(async () => {});

  runTurnRef.current = async (message: string) => {
    const myGeneration = generation.current;
    const alive = () => generation.current === myGeneration;

    /*
      THE TURN IS ABORTABLE, AND `clear()` IS WHY.

      Found in a browser 2026-09-05: clearing the conversation mid-turn bumped the
      generation so the answer could no longer be written, and left the REQUEST running --
      so `inFlight` stayed true for as long as the abandoned stream did. `send` then queued
      every new message behind a turn nobody would ever see, and the panel looked broken
      until the dead stream happened to end. Aborting is what makes the two facts agree:
      the turn is gone, so the socket is gone.
    */
    const ac = new AbortController();
    abort.current = ac;

    inFlight.current = true;
    setBusy(true);
    setRefusal(null);

    const at = Date.now();
    const answerId = bubbleId();
    const conversationId = latest.current.conversationId;
    /*
      The turn owns its OWN message list, in a local, and never reads `latest.current` again.

      Token updates land many times per second and React batches them, so `latest.current`
      lags behind what has been set -- folding each delta into "whatever the last render
      saw" would drop tokens under load. The bubble the answer lands in is created empty and
      `pending`, which is what lets the panel draw "thinking" in the place the text will
      appear rather than somewhere else.
    */
    let messages: StoredMessage[] = [
      ...latest.current.messages,
      { id: bubbleId(), role: "user", text: message, at },
      { id: answerId, role: "assistant", text: "", at, pending: true },
    ];
    // NOT committed to storage: it holds a `pending` bubble, and `storableMessage` would
    // strip the flag and leave a permanent empty answer if the tab closed mid-turn.
    setConv({ conversationId, messages });

    const patch = (fields: Partial<StoredMessage>) => {
      if (!alive()) return;
      messages = messages.map((m) => (m.id === answerId ? { ...m, ...fields } : m));
      setConv({ conversationId, messages });
    };

    let transcript: Transcript = emptyTranscript();
    let settled: AgentAnswer | null = null;
    let failure: string | null = null;

    const onEvent = (e: AgentEvent) => {
      if (!alive()) return;
      if (e.type === "done") {
        settled = e.answer;
        return;
      }
      if (e.type === "error") {
        failure = e.message;
        return;
      }
      transcript = applyAgentEvent(transcript, e);
      // BOTH fields, every event: the transcript is the machinery and `text` is the prose,
      // and the panel decides for itself which of them is worth drawing at this instant.
      patch({ transcript: transcript.entries, text: streamedText(transcript) });
    };

    let refused: AgentRefusal | null = null;
    try {
      await streamAgentChat(message, conversationId ?? undefined, onEvent, { signal: ac.signal });
    } catch (e) {
      refused = e instanceof AgentError ? e.refusal : { kind: "error", message: (e as Error).message };
    }

    // ABANDONED. `clear()` already reset the flags and a NEWER turn may own them by now, so
    // touching `inFlight` or `busy` here would stop a turn that is still running.
    if (!alive()) return;

    const commit = (next: StoredConversation) => {
      setConv(writeConversation(store, userId, next));
    };

    if (settled) {
      // `done` won. The streamed text entries are dropped from the transcript because the
      // authoritative answer replaces them -- see `settleTranscript`.
      const answer: AgentAnswer = settled;
      const kept = settleTranscript(transcript, answer.toolCalls ?? []);
      const bubble = answerBubble(answerId, Date.now(), answer);
      messages = messages.map((m) =>
        m.id === answerId
          ? {
              ...bubble,
              text: reconcileAnswer(streamedText(transcript), answer.answer),
              ...(kept.entries.length > 0 ? { transcript: kept.entries } : {}),
            }
          : m,
      );
      commit({ conversationId: answer.conversationId, messages });
    } else {
      /*
        NOTHING AUTHORITATIVE ARRIVED. Three ways to get here and they are one outcome:
        the request was refused, the server sent an `error` frame, or the stream simply
        stopped. In every case whatever text arrived is KEPT and the bubble is marked
        incomplete -- the reader must be able to tell "it stopped" from "that was the whole
        answer", and only the transport knows which.
      */
      const reason = refused ? refusalText(refused) : (failure ?? INCOMPLETE_NOTE);
      const abandoned = abandonTranscript(transcript);
      const partial = streamedText(transcript);
      messages = messages.map((m) =>
        m.id === answerId
          ? {
              id: answerId,
              role: "assistant" as const,
              text: partial,
              at: Date.now(),
              error: reason,
              incomplete: true,
              ...(abandoned.entries.length > 0 ? { transcript: abandoned.entries } : {}),
            }
          : m,
      );
      commit({ conversationId, messages });
      /*
        ONLY A REFUSAL BECOMES THE STANDING NOTE ABOVE THE COMPOSER.

        The two are different claims. A refusal is about the SERVICE -- a spent budget is
        still spent for the next attempt -- so it belongs where somebody about to type will
        see it. A stream that died, or an `error` frame, is about THAT TURN, and it is
        already written into that turn's bubble; repeating it above the box printed the same
        sentence twice on one screen, which was measured in a browser 2026-09-05 and reads
        as two separate failures rather than one.
      */
      if (refused) {
        setRefusal(refused);
        if (isTerminalRefusal(refused)) onGone?.(refused);
      }
    }

    inFlight.current = false;
    setBusy(false);

    /*
      THE DRAIN, and what a failure does to it.

      A turn that succeeded pulls the next queued message and sends it -- ONE AT A TIME,
      never concurrently, because the server threads `conversationId` and two in flight
      would race one conversation.

      A turn that FAILED stops the drain and leaves the rest pending. Firing four more turns
      at a server that just refused buys four more identical refusals, four more ledger rows
      and, on the budget wall, four more chances to be told the same thing -- and the reader
      has lost nothing, because the messages are still on screen with their own cancel
      buttons. Resuming is one deliberate act: the resume control, or simply sending
      something new, both of which are the reader saying "try again".
    */
    if (settled) {
      const next = shiftQueue();
      if (next) void runTurnRef.current(next.text);
    } else if (queueRef.current.length > 0) {
      setQueueHalted(true);
    }
  };

  const send = useCallback(
    (raw: string) => {
      const message = raw.trim();
      if (!message) return;
      // Queued when anything is ahead of it: a turn in flight, or a queue that is already
      // waiting. Order is the reader's typing order and nothing may reshuffle it.
      if (inFlight.current || queueRef.current.length > 0) {
        pushQueue({ id: bubbleId(), text: message });
        // Sending while halted IS a resume: the reader has looked at the failure and is
        // trying again, and making them press a second control first would be ceremony.
        if (!inFlight.current) {
          setQueueHalted(false);
          const next = shiftQueue();
          if (next) void runTurnRef.current(next.text);
        }
        return;
      }
      void runTurnRef.current(message);
    },
    [pushQueue, shiftQueue],
  );

  const cancelQueued = useCallback((id: string) => {
    queueRef.current = queueRef.current.filter((q) => q.id !== id);
    setQueued(queueRef.current);
    if (queueRef.current.length === 0) setQueueHalted(false);
  }, []);

  const resumeQueue = useCallback(() => {
    if (inFlight.current) return;
    setQueueHalted(false);
    const [head, ...rest] = queueRef.current;
    if (!head) return;
    queueRef.current = rest;
    setQueued(rest);
    void runTurnRef.current(head.text);
  }, []);

  const clear = useCallback(() => {
    // The bump is what stops a turn already in flight from writing its answer into the
    // conversation the reader just erased.
    generation.current += 1;
    // And the abort is what stops it OCCUPYING the panel. Without it `inFlight` stayed true
    // for the life of an abandoned stream, so every message sent afterwards was queued
    // behind a turn nobody would ever see -- see the abort comment in `runTurn`.
    abort.current?.abort();
    abort.current = null;
    inFlight.current = false;
    setBusy(false);
    clearConversation(store, userId);
    queueRef.current = [];
    setQueued([]);
    setQueueHalted(false);
    setConv(EMPTY_CONVERSATION);
    setRefusal(null);
  }, [store, userId]);

  return {
    messages: conv.messages,
    busy,
    refusal,
    queued,
    queueHalted,
    send,
    cancelQueued,
    resumeQueue,
    clear,
  };
}

/**
 * A refusal in one sentence, for the bubble that failed.
 *
 * The server's own `message` is preferred wherever it sends one -- it knows why, and this
 * file guessing at a reason would be a second, worse copy of that. Only the two cases with
 * no message of their own get words from here.
 */
export function refusalText(r: AgentRefusal): string {
  switch (r.kind) {
    case "absent":
      return "The assistant is not set up on this finderr.";
    case "over-limit":
      return r.message || "Today's budget for the assistant is spent.";
    default:
      return r.message;
  }
}
