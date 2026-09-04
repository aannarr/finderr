/**
 * What the assistant REMEMBERS, and what it is allowed to forget.
 *
 * Until this existed every POST ran a fresh conversation: `conversationId` was threaded into
 * the ledger, the client drew a thread, and the model was handed one lone question with no
 * idea what came before it. So "request the top 3 of those" had no referent for *those*, and
 * the panel looked like a chat while behaving like a search box. Queued messages made it
 * worse rather than better -- they arrive as a sequence that READS like a conversation and
 * was not one.
 *
 * > [!IMPORTANT] ONLY THE HUMAN-VISIBLE TURNS ARE REPLAYED -- NEVER THE TOOL TRAFFIC
 * > A completed turn is stored as the QUESTION and the ANSWER, and the tool calls that
 * > produced it are dropped. That is deliberate and it is the whole reason this stays cheap:
 * > one `list_episodes` result is kilobytes of JSON, and replaying five turns of tool traffic
 * > would put a six-figure token count in front of a model that already has the tools to ask
 * > again. The facts are re-derivable in one call; the conversation is not.
 * >
 * > The cost is real and worth naming: the model cannot see the exact rows it read last turn,
 * > so a follow-up that depends on them makes it look again. That is the correct trade at
 * > these prices -- a lookup is $0.0002 and a bloated context is every turn forever.
 *
 * > [!IMPORTANT] A RELOADED CONVERSATION CONTINUES. IT IS NOT READ-ONLY HISTORY.
 * > The build plan raised this as its one open product question -- *"does a reloaded
 * > conversation continue, or is it read-only history with the next question starting
 * > fresh?"* -- and argued for read-only as the cheapest and most predictable option.
 * >
 * > **aannarr ruled the other way on 2026-09-05: progressive.** *"a conversation should be
 * > PROGRESSIVE.. history lives, and cached/stored in localStorage."* So the transcript the
 * > browser restores and the context the model receives are the SAME conversation, and a
 * > follow-up after a reload refers backwards exactly as one before it would.
 * >
 * > That decision is what makes this file's budget matter. Read-only history costs nothing
 * > per turn; a continuing one is paid for on every subsequent request, which is why
 * > `MAX_HISTORY_TURNS` and `MAX_REPLAYED_CHARS` exist and why the tool traffic is dropped.
 * >
 * > The two halves are NOT one store and must not be confused. `localStorage` is the
 * > browser's copy, for rendering the thread instantly on reload with no round-trip. THIS
 * > table is what the MODEL sees. The client cannot be the source of the model's context --
 * > it is user-controlled input, and a browser that can post its own "history" can put words
 * > in the assistant's mouth and then quote them back as though the assistant had said them.
 *
 * > [!CAUTION] HISTORY IS AN INJECTION SURFACE, WHICH IS WHY IT IS TYPED AND NOT FREE TEXT
 * > Every stored message is one of two roles and nothing else. A stored `system` message
 * > would let anything that ever reached this table rewrite the standing instructions on the
 * > next turn -- and tool output, which is upstream data, has been through here. `toMessages`
 * > emits `user`/`assistant` only, and the system prompt is prepended by the runner from
 * > code. Do not add a role.
 */

import type { ChatMessage } from "./openrouter.js";

/** One stored exchange. The pair is the unit, because half of it is not a turn. */
export interface ConversationTurn {
  /** What the person asked. */
  question: string;
  /** What the assistant finally said. Empty when the run failed before answering. */
  answer: string;
  /** ISO 8601, UTC. Ordering, and the prune's input. */
  at: string;
}

/**
 * How much history rides along.
 *
 * Turns rather than tokens, because a turn is the unit a person thinks in and a count is
 * something an operator can reason about. Twelve is roughly six exchanges each way -- past
 * that a follow-up is almost never referring backwards, and every turn is paid for on EVERY
 * subsequent request.
 */
export const MAX_HISTORY_TURNS = 12;

/**
 * A hard ceiling on how much of any one message is replayed.
 *
 * An answer can be long -- a list of forty episodes with scores -- and a long answer replayed
 * on every later turn is a bill that compounds. Truncating mid-sentence is ugly and honest;
 * the alternative is dropping the turn entirely, which loses the thread the feature exists
 * for. The marker tells the model the text was cut so it does not treat a severed sentence
 * as the whole of what it said.
 */
export const MAX_REPLAYED_CHARS = 4_000;

function clip(text: string): string {
  if (text.length <= MAX_REPLAYED_CHARS) return text;
  return `${text.slice(0, MAX_REPLAYED_CHARS)}\n[…truncated]`;
}

/**
 * The messages to put in front of the model, oldest first, followed by the new question.
 *
 * Pure, and takes the turns it is handed rather than reading a database, so the replay rules
 * are testable without a Store -- the same split `request-quota` and `ai-spend` already use.
 *
 * A turn with an EMPTY ANSWER is dropped rather than replayed. It means the run failed before
 * saying anything, and a `user` message with no assistant reply after it reads to the model as
 * a question it ignored -- which is both false and a pattern worth not teaching it.
 */
export function toMessages(turns: readonly ConversationTurn[], question: string): ChatMessage[] {
  const recent = turns.slice(-MAX_HISTORY_TURNS);
  const out: ChatMessage[] = [];
  for (const t of recent) {
    if (!t.question.trim() || !t.answer.trim()) continue;
    out.push({ role: "user", content: clip(t.question) });
    out.push({ role: "assistant", content: clip(t.answer) });
  }
  out.push({ role: "user", content: question });
  return out;
}

/** Whether a finished run is worth remembering. */
export function isRememberable(question: string, answer: string): boolean {
  return question.trim().length > 0 && answer.trim().length > 0;
}

/** Reads and writes the stored turns. `Store` implements it; see `../store.ts`. */
export interface ConversationStore {
  /** Oldest first. Bounded by the caller's limit, not by the whole history. */
  conversationTurns(userId: string, convId: string, limit: number): ConversationTurn[];
  appendConversationTurn(userId: string, convId: string, turn: ConversationTurn): void;
  /** Forget one conversation. The client's "clear" must reach the server, not only localStorage. */
  clearConversation(userId: string, convId: string): void;
}

/**
 * Load the history for a conversation, ready to hand to the runner.
 *
 * Scoped by USER as well as by conversation id, always. The id is a `crypto.randomUUID()` the
 * CLIENT sends, so it is not a secret and not unguessable in any sense we control -- without
 * the user scope, anyone who learned or guessed an id could replay somebody else's chat into
 * their own model call and read it back in the answer. The scope makes that impossible rather
 * than unlikely.
 */
export function historyFor(store: ConversationStore, userId: string, convId: string): ConversationTurn[] {
  return store.conversationTurns(userId, convId, MAX_HISTORY_TURNS);
}
