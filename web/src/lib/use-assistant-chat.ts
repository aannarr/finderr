/**
 * The assistant's state and its one side effect, held ABOVE the panel.
 *
 * The panel is closed far more often than it is open, and a turn takes seconds -- so the
 * conversation cannot live inside a component that unmounts when the panel closes, or
 * closing it mid-answer would drop the answer on the floor. Same split as `useTitleDetail`:
 * the policy is here, the drawing is in the component.
 *
 * The reader's own turn is appended and PAINTED IMMEDIATELY, with an empty assistant bubble
 * beside it, before the request goes out. That empty bubble is the streaming seam: today
 * `text` is filled once when the response lands, and a token stream would append to the
 * same field with no other change to this file or to the panel.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AgentAnswer,
  AgentError,
  type AgentRefusal,
  isTerminalRefusal,
  postAgentChat,
} from "./agent-api";
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
  send: (message: string) => void;
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

  // Restored in an effect rather than in a `useState` initialiser, because the reader is
  // not known on the first render -- `RootLayout` fetches `me` and the id arrives a tick
  // later. Re-running on a changed id is also what swaps conversations when somebody signs
  // out and somebody else signs in without a reload.
  useEffect(() => {
    setConv(readConversation(store, userId));
  }, [store, userId]);

  /**
   * Write through, and adopt what the store actually kept.
   *
   * `writeConversation` returns the PRUNED conversation, so the in-memory copy follows the
   * cap instead of growing past it forever and re-paying for the trim on every turn.
   */
  const commit = useCallback(
    (next: StoredConversation) => {
      setConv(writeConversation(store, userId, next));
    },
    [store, userId],
  );

  // Read by `send`, which is created fresh per render but runs asynchronously -- without
  // this the answer would be folded into whatever the conversation was when the turn began.
  const latest = useRef(conv);
  latest.current = conv;

  const send = useCallback(
    (raw: string) => {
      const message = raw.trim();
      if (!message || busy) return;
      const at = Date.now();
      const answerId = bubbleId();

      const optimistic: StoredConversation = {
        conversationId: latest.current.conversationId,
        messages: [
          ...latest.current.messages,
          { id: bubbleId(), role: "user", text: message, at },
          // The bubble the answer lands in. Empty and `pending`, so the panel can draw
          // "thinking" in the place the text will appear rather than somewhere else.
          { id: answerId, role: "assistant", text: "", at, pending: true },
        ],
      };
      // NOT committed to storage: it holds a `pending` bubble, and `storableMessage` would
      // strip the flag and leave a permanent empty answer if the tab closed mid-turn.
      setConv(optimistic);
      setBusy(true);
      setRefusal(null);

      void postAgentChat(message, latest.current.conversationId ?? undefined)
        .then((answer) => {
          commit({
            conversationId: answer.conversationId,
            messages: optimistic.messages.map((m) =>
              m.id === answerId ? answerBubble(answerId, Date.now(), answer) : m,
            ),
          });
        })
        .catch((e: unknown) => {
          const r: AgentRefusal =
            e instanceof AgentError ? e.refusal : { kind: "error", message: (e as Error).message };
          setRefusal(r);
          if (isTerminalRefusal(r)) onGone?.(r);
          // The failed turn KEEPS the reader's question and marks the answer as failed. A
          // turn that vanishes takes the typing with it, and retyping a paragraph is a
          // worse outcome than a visible failure sitting in the thread.
          commit({
            conversationId: optimistic.conversationId,
            messages: optimistic.messages.map((m) =>
              m.id === answerId
                ? { id: answerId, role: "assistant", text: "", at: Date.now(), error: refusalText(r) }
                : m,
            ),
          });
        })
        .finally(() => setBusy(false));
    },
    [busy, commit, onGone],
  );

  const clear = useCallback(() => {
    clearConversation(store, userId);
    setConv(EMPTY_CONVERSATION);
    setRefusal(null);
  }, [store, userId]);

  return { messages: conv.messages, busy, refusal, send, clear };
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
