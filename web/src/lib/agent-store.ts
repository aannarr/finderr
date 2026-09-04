/**
 * The assistant conversation, kept across reloads, in `localStorage`.
 *
 * Pure and DOM-free -- every function takes the storage it writes to, the same split
 * `keymap.ts` and `header-scroll.ts` use. That is what lets the cap, the pruning and the
 * quota behaviour be tested against a fake `Storage` with no browser in the room.
 *
 * > [!IMPORTANT] Why `localStorage` and not the IndexedDB path `cache-persistence.ts` owns
 * > That machinery snapshots CACHES: things that may be dropped freely because the network
 * > is the answer and the disk copy only makes the first paint fast. A conversation is the
 * > opposite -- the server does not keep the transcript for us to re-read, so this IS the
 * > record. It is also tiny and read exactly once, at mount, which is what `localStorage`'s
 * > synchronous API is good at and where its being synchronous costs nothing.
 *
 * > [!CAUTION] NOTHING SECRET GOES IN HERE, and that is a standing constraint
 * > It is unencrypted, it survives sign-out unless something clears it, and on a shared
 * > device the next person can read it from the console. What is stored is what was already
 * > on screen: the reader's own questions, the answers, the tool NAMES and their arguments,
 * > and title ids. No session cookie, no agent key, no admin key. A field that ever carries
 * > a credential must be stripped in `storableMessage` before it reaches this file.
 */

import type { AgentEpisode, AgentRequested, AgentTitle, AgentToolCall, AgentUsage } from "./agent-api";
import type { TranscriptEntry } from "./agent-transcript";
import type { FacetProblem } from "./facets";
import type { ResolvedMention } from "./mentions";

/**
 * One bubble.
 *
 * A single shape for both roles rather than a union, because the list renders them
 * together and every rich field is absent on a user turn anyway. `pending` is what makes
 * this streaming-ready: the assistant's bubble is created empty and `text` grows.
 */
export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  /** The prose. Appended to rather than replaced, so a token stream drops straight in. */
  text: string;
  /** Epoch ms, so a restored conversation can still be ordered and dated. */
  at: number;
  /**
   * Still being answered.
   *
   * NEVER persisted -- `storableMessage` drops it. A reload cannot resume a turn, and a
   * bubble restored as `pending` would spin forever against a request nobody is making.
   */
  pending?: boolean;
  /**
   * HOW the answer was arrived at: the reasoning, and every lookup, in the order they
   * happened.
   *
   * Persisted, unlike `pending`, because it is a record rather than a live state -- a reader
   * coming back to a conversation should still be able to see that the answer consulted the
   * index rather than the model's memory, which is the difference between a fact about this
   * library and a plausible sentence. `pruneConversation` is what bounds its size, the same
   * way it bounds everything else here.
   */
  transcript?: TranscriptEntry[];
  /**
   * Resolved ids for THIS answer, so a reload still renders its links.
   *
   * Persisted with the turn rather than re-fetched: they are small (an id, a label, a path),
   * they belong to the text they were resolved against, and asking the server again on every
   * page load to re-link an answer nobody changed would be a request for nothing.
   */
  mentions?: ResolvedMention[];
  /**
   * The stream died before the answer finished.
   *
   * What arrived is kept and the bubble says it is incomplete. **A truncated answer drawn as
   * a finished one is the failure this field exists to prevent** -- the reader has no way to
   * tell a model that stopped mid-sentence from one that had nothing more to say, and only
   * the transport knows which happened.
   */
  incomplete?: boolean;
  toolCalls?: AgentToolCall[];
  requested?: AgentRequested[];
  titles?: AgentTitle[];
  episodes?: AgentEpisode[];
  problems?: FacetProblem[];
  usage?: AgentUsage;
  /** The turn failed. Rendered as a refusal note rather than as an answer. */
  error?: string;
}

export interface StoredConversation {
  /** The server's thread id, echoed back on the next turn. Null before the first answer. */
  conversationId: string | null;
  messages: StoredMessage[];
}

export const EMPTY_CONVERSATION: StoredConversation = { conversationId: null, messages: [] };

/** Just enough of `Storage` to read, write and delete one key -- so a test can fake it. */
export type KeyValueStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * `v1` is in the key so a shape change is a new key rather than a parse guard.
 *
 * The old entry is then orphaned instead of crashing a reader on a field that moved, and
 * `readConversation` treats anything it cannot parse as an empty conversation regardless.
 */
const KEY_PREFIX = "finderr.assistant.v1";

/**
 * One conversation PER READER, on a device several people sign into.
 *
 * Keyed on the user id rather than on a display name: two households have had a "Dad", and
 * a shared iPad is the exact machine this product is used on. A reader we cannot identify
 * gets `anon`, which is correct rather than clever -- an unauthenticated page draws no
 * launcher, so nothing writes there in practice.
 */
export function conversationKey(userId: string | null | undefined): string {
  return `${KEY_PREFIX}.${userId && userId.length > 0 ? userId : "anon"}`;
}

/**
 * The caps, and they are two questions rather than one.
 *
 * MESSAGES bounds what a reader has to scroll and what the panel has to render. BYTES
 * bounds the quota: one answer naming forty titles is worth a hundred short exchanges, so
 * a message count alone would let a handful of rich turns fill the origin's 5 MB.
 *
 * Neither is a measurement, and both are deliberately well under any real limit -- the cost
 * of pruning one turn too early is a reader losing a question from last week.
 */
export const MAX_MESSAGES = 60;
export const MAX_BYTES = 96_000;

/**
 * The message as it goes to disk.
 *
 * Two things are dropped rather than stored: `pending`, because a turn cannot survive a
 * reload, and any rich array that is empty, because `titles: []` on every one of sixty
 * bubbles is pure quota spent on the absence of data.
 */
function storableMessage(m: StoredMessage): StoredMessage {
  const out: StoredMessage = { id: m.id, role: m.role, text: m.text, at: m.at };
  if (m.transcript?.length) out.transcript = m.transcript;
  if (m.incomplete) out.incomplete = true;
  if (m.toolCalls?.length) out.toolCalls = m.toolCalls;
  if (m.requested?.length) out.requested = m.requested;
  if (m.titles?.length) out.titles = m.titles;
  // Small -- an id, a label, a path -- and the answer's links are unrenderable without them.
  // A stored turn whose mentions were dropped renders its brackets raw on the next reload,
  // which is exactly the bug this line was added to fix.
  if (m.mentions?.length) out.mentions = m.mentions;
  if (m.episodes?.length) out.episodes = m.episodes;
  if (m.problems?.length) out.problems = m.problems;
  if (m.usage) out.usage = m.usage;
  if (m.error) out.error = m.error;
  return out;
}

/**
 * Trim to the caps, OLDEST FIRST.
 *
 * Oldest-first because a conversation is read from the bottom: the turn a reader is looking
 * at is the last one, and dropping that to keep a question from Tuesday would be exactly
 * backwards. It can return an empty message list -- a single answer larger than the whole
 * byte cap has nowhere to go, and storing nothing is better than throwing on every write
 * for the rest of the session.
 */
export function pruneConversation(
  conv: StoredConversation,
  limits: { maxMessages?: number; maxBytes?: number } = {},
): StoredConversation {
  const maxMessages = limits.maxMessages ?? MAX_MESSAGES;
  const maxBytes = limits.maxBytes ?? MAX_BYTES;

  let messages = conv.messages.map(storableMessage);
  if (messages.length > maxMessages) messages = messages.slice(messages.length - maxMessages);

  // Re-serialised on each drop rather than by summing per-message sizes: the envelope and
  // the separators are part of what the quota counts, and a running estimate would be wrong
  // by exactly the amount that decides whether a write throws.
  while (messages.length > 0 && serialise({ ...conv, messages }).length > maxBytes) {
    messages = messages.slice(1);
  }
  return { conversationId: conv.conversationId, messages };
}

function serialise(conv: StoredConversation): string {
  return JSON.stringify(conv);
}

/**
 * What is on disk for this reader, or an empty conversation.
 *
 * EVERY failure is the empty conversation and none of them is reported. Reading
 * `localStorage` throws outright in a browser with site data blocked, the value may be junk
 * another tool wrote under a colliding key, and none of that is worth putting an error in
 * front of somebody who opened a chat panel.
 */
export function readConversation(store: KeyValueStore | null, userId: string | null): StoredConversation {
  if (!store) return EMPTY_CONVERSATION;
  try {
    const raw = store.getItem(conversationKey(userId));
    if (!raw) return EMPTY_CONVERSATION;
    const parsed = JSON.parse(raw) as StoredConversation;
    // Shape-checked rather than trusted: `messages` not being an array is the one field
    // whose absence would take the render down instead of drawing nothing.
    if (!parsed || !Array.isArray(parsed.messages)) return EMPTY_CONVERSATION;
    return { conversationId: parsed.conversationId ?? null, messages: parsed.messages };
  } catch {
    return EMPTY_CONVERSATION;
  }
}

/**
 * Write, and never throw.
 *
 * > [!CAUTION] Safari in private mode throws on `setItem`, with the quota reported as zero
 * > It is not a rare configuration and it is not a bug we can detect in advance -- reading
 * > works, writing does not. So a refusal is answered by halving and trying again, and a
 * > store that refuses everything is given up on silently: the panel keeps working from
 * > memory for the session and simply does not survive a reload. A chat that refused to
 * > send because it could not write a log of itself would be the worse failure.
 *
 * > [!IMPORTANT] The retry halves what was just REFUSED, never `MAX_BYTES`
 * > Lowering the cap does nothing to a conversation that was already under it, so a first
 * > version halving `MAX_BYTES` re-offered a byte-identical string to a store that had just
 * > said no -- and reported the whole thing as stored. The real ceiling is somewhere below
 * > the string that failed, so that string is what gets halved. Found by the capped-store
 * > case in `agent-store.test.ts`, which is why that fake has a real limit rather than
 * > throwing unconditionally.
 *
 * Returns what was actually stored, so the caller's in-memory copy can follow the prune
 * instead of drifting above it and re-paying for the trim on every keystroke.
 */
export function writeConversation(
  store: KeyValueStore | null,
  userId: string | null,
  conv: StoredConversation,
): StoredConversation {
  let attempt = pruneConversation(conv);
  if (!store) return attempt;
  const key = conversationKey(userId);

  // Bounded, because a store that throws on an empty string will throw on every string --
  // and an unbounded halving loop inside a keystroke handler is worse than not persisting.
  for (let i = 0; i < 5; i++) {
    const payload = serialise(attempt);
    try {
      store.setItem(key, payload);
      return attempt;
    } catch {
      if (attempt.messages.length === 0) return attempt;
      attempt = pruneConversation(attempt, { maxBytes: Math.floor(payload.length / 2) });
    }
  }
  return attempt;
}

/** Forget this reader's conversation. Behind the panel's own "Clear", and on sign-out. */
export function clearConversation(store: KeyValueStore | null, userId: string | null): void {
  try {
    store?.removeItem(conversationKey(userId));
  } catch {
    // Same rule as the write: a storage that will not co-operate is not worth a dialog.
  }
}

/**
 * `localStorage`, or null where touching it throws.
 *
 * The ACCESS itself throws in a Chrome with third-party site data blocked, before any
 * method is called, so it cannot be reached through a plain `typeof` check at the call
 * site. One accessor, one `try`, and every function above takes the result.
 */
export function browserStore(): KeyValueStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
