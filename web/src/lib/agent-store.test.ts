/**
 * The conversation store: the cap, the prune order, and every way a browser refuses to
 * write.
 *
 * All of it against a fake `Storage`, which is the point of the module taking one -- the
 * two failures worth pinning (Safari private mode throwing on `setItem`, site data blocked
 * so the object cannot be touched at all) cannot be produced in a test runner otherwise,
 * and both of them are silent in production if they are wrong.
 */

import { describe, expect, test } from "bun:test";
import {
  clearConversation,
  conversationKey,
  EMPTY_CONVERSATION,
  type KeyValueStore,
  MAX_MESSAGES,
  pruneConversation,
  readConversation,
  type StoredConversation,
  type StoredMessage,
  writeConversation,
} from "./agent-store";

/** A `Storage` that works, and records what it was asked to hold. */
function fakeStore(initial: Record<string, string> = {}): KeyValueStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
    removeItem: (k) => {
      data.delete(k);
    },
  };
}

/** Safari in private mode: reads fine, throws on every write, whatever the size. */
function refusingStore(): KeyValueStore {
  return {
    getItem: () => null,
    setItem: () => {
      throw new DOMException("QuotaExceededError");
    },
    removeItem: () => {},
  };
}

/** A store with a real ceiling, which is what an origin near its 5 MB actually looks like. */
function cappedStore(limit: number): KeyValueStore & { data: Map<string, string> } {
  const inner = fakeStore();
  return {
    data: inner.data,
    getItem: inner.getItem,
    setItem: (k, v) => {
      if (v.length > limit) throw new DOMException("QuotaExceededError");
      inner.setItem(k, v);
    },
    removeItem: inner.removeItem,
  };
}

function message(over: Partial<StoredMessage> & { id: string }): StoredMessage {
  return { role: "user", text: "hello", at: 1_700_000_000_000, ...over };
}

function conversation(count: number, text = "hello"): StoredConversation {
  return {
    conversationId: "c1",
    messages: Array.from({ length: count }, (_, i) => message({ id: `m${i}`, text: `${text} ${i}` })),
  };
}

describe("the key", () => {
  test("is per reader, so a shared device does not mix two people's threads", () => {
    expect(conversationKey("u_alice")).not.toBe(conversationKey("u_bob"));
  });

  /** An unauthenticated page draws no launcher, so nothing writes here -- but it must not throw. */
  test("falls back to one anonymous key rather than an empty suffix", () => {
    expect(conversationKey(null)).toBe(conversationKey(""));
    expect(conversationKey(null)).toContain("anon");
  });
});

describe("pruning", () => {
  test("drops the OLDEST first, because a thread is read from the bottom", () => {
    const pruned = pruneConversation(conversation(5), { maxMessages: 2 });
    expect(pruned.messages.map((m) => m.id)).toEqual(["m3", "m4"]);
  });

  test("keeps the conversation id, which is not one of the things being capped", () => {
    expect(pruneConversation(conversation(5), { maxMessages: 1 }).conversationId).toBe("c1");
  });

  /**
   * The byte cap is the one that matters, and a message count cannot stand in for it: one
   * answer naming forty titles outweighs a hundred short exchanges.
   */
  test("trims by SIZE as well as by count", () => {
    const fat = {
      conversationId: "c1",
      messages: Array.from({ length: 10 }, (_, i) => message({ id: `m${i}`, text: "x".repeat(500) })),
    };
    const pruned = pruneConversation(fat, { maxBytes: 2000 });
    expect(pruned.messages.length).toBeLessThan(10);
    expect(JSON.stringify(pruned).length).toBeLessThanOrEqual(2000);
    // Still the newest ones.
    expect(pruned.messages.at(-1)?.id).toBe("m9");
  });

  /** One answer bigger than the whole budget: store nothing rather than throw forever. */
  test("can end up empty rather than exceeding the cap", () => {
    const huge = { conversationId: null, messages: [message({ id: "m0", text: "x".repeat(5000) })] };
    expect(pruneConversation(huge, { maxBytes: 100 }).messages).toEqual([]);
  });

  /**
   * `pending` is a claim about a request in flight. A reload cannot resume one, so a bubble
   * restored with the flag would spin against nothing for the rest of the session.
   */
  test("a turn still in flight is never written down as one", () => {
    const conv = {
      conversationId: null,
      messages: [message({ id: "m0", role: "assistant", pending: true })],
    };
    expect(pruneConversation(conv).messages[0].pending).toBeUndefined();
  });

  /** `titles: []` on sixty bubbles is quota spent on the absence of data. */
  test("empty rich arrays are dropped rather than stored", () => {
    const conv = {
      conversationId: null,
      messages: [message({ id: "m0", role: "assistant", titles: [], toolCalls: [], episodes: [] })],
    };
    const stored = pruneConversation(conv).messages[0];
    expect(stored.titles).toBeUndefined();
    expect(stored.toolCalls).toBeUndefined();
    expect(stored.episodes).toBeUndefined();
  });

  test("the default cap is the exported one, so nothing has to guess it", () => {
    expect(pruneConversation(conversation(MAX_MESSAGES + 10)).messages).toHaveLength(MAX_MESSAGES);
  });
});

describe("reading", () => {
  test("an empty store is an empty conversation, not an error", () => {
    expect(readConversation(fakeStore(), "u1")).toEqual(EMPTY_CONVERSATION);
  });

  /**
   * A browser with site data blocked hands us nothing at all. That is the ordinary case for
   * this module, not an exception worth reporting to somebody who opened a chat panel.
   */
  test("no store at all is an empty conversation", () => {
    expect(readConversation(null, "u1")).toEqual(EMPTY_CONVERSATION);
  });

  test("junk under the key is an empty conversation rather than a crash", () => {
    const store = fakeStore({ [conversationKey("u1")]: "not json{{" });
    expect(readConversation(store, "u1")).toEqual(EMPTY_CONVERSATION);
  });

  /** The one field whose wrong shape would take the render down instead of drawing nothing. */
  test("a payload with no message array is an empty conversation", () => {
    const store = fakeStore({ [conversationKey("u1")]: JSON.stringify({ conversationId: "c1" }) });
    expect(readConversation(store, "u1").messages).toEqual([]);
  });

  test("round-trips what was written", () => {
    const store = fakeStore();
    writeConversation(store, "u1", conversation(3));
    expect(readConversation(store, "u1").messages.map((m) => m.id)).toEqual(["m0", "m1", "m2"]);
  });

  test("one reader cannot read another's", () => {
    const store = fakeStore();
    writeConversation(store, "u1", conversation(2));
    expect(readConversation(store, "u2")).toEqual(EMPTY_CONVERSATION);
  });
});

describe("writing into a browser that refuses", () => {
  /**
   * THE FAILURE THIS MODULE EXISTS TO SURVIVE. Safari private mode reports a quota of zero
   * and throws on every `setItem` -- a panel that let that escape would stop working the
   * moment somebody opened a private window.
   */
  test("a store that always throws does not take the caller with it", () => {
    expect(() => writeConversation(refusingStore(), "u1", conversation(3))).not.toThrow();
  });

  test("a null store is simply not written to", () => {
    expect(() => writeConversation(null, "u1", conversation(3))).not.toThrow();
  });

  /** Half of everything, one retry -- and the half has to actually land. */
  test("a quota it cannot fit is retried smaller, and fits", () => {
    const store = cappedStore(1200);
    const fat = {
      conversationId: "c1",
      messages: Array.from({ length: 40 }, (_, i) => message({ id: `m${i}`, text: "x".repeat(60) })),
    };
    const kept = writeConversation(store, "u1", fat);
    expect(store.data.get(conversationKey("u1"))).toBeDefined();
    // What came back is what is on disk, so the caller's copy follows the prune instead of
    // drifting above it and re-paying for the trim on every turn.
    expect(kept.messages.length).toBe(readConversation(store, "u1").messages.length);
  });

  test("what it returns is what was actually kept, capped", () => {
    const kept = writeConversation(fakeStore(), "u1", conversation(MAX_MESSAGES + 5));
    expect(kept.messages).toHaveLength(MAX_MESSAGES);
  });
});

describe("clearing", () => {
  test("removes this reader's thread and leaves everybody else's", () => {
    const store = fakeStore();
    writeConversation(store, "u1", conversation(2));
    writeConversation(store, "u2", conversation(2));
    clearConversation(store, "u1");
    expect(readConversation(store, "u1")).toEqual(EMPTY_CONVERSATION);
    expect(readConversation(store, "u2").messages).toHaveLength(2);
  });

  test("a refusing store is not a reason to throw either", () => {
    expect(() => clearConversation(refusingStore(), "u1")).not.toThrow();
  });
});
