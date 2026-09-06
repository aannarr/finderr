/**
 * WHO THE ASSISTANT EXISTS FOR, asked at the probe.
 *
 * The probe is what decides whether a launcher is drawn at all, so it is the one place a
 * change of audience is visible without spending a model call. THREE rules meet here and only
 * two are about the reader: the DEPLOYMENT gate (no key, no feature, for everybody), the
 * AUDIENCE (every signed-in account, since 2026-09-05) and the per-account switch an admin
 * flips on `/admin/users/:id`.
 *
 * It was `role !== "admin"` until that date -- an admin-only beta, deliberately with no
 * switch to widen it. aannarr: *"make assistant available to all users if key etc are set."*
 * These tests exist because the widening is a DELETION, and a deletion leaves nothing behind
 * for a reader to notice: without them, re-adding a role check would look like tightening a
 * gap rather than reverting a decision. The per-account switch is what a role check would be
 * a bad imitation of, so it is pinned here beside it.
 */

import { describe, expect, test } from "bun:test";
import type { Principal, Role, User } from "../lib/auth";
import { makeChatProbe, surfaced } from "./agent-chat";

const deps = (over: { key?: string; models?: string[] } = {}) =>
  ({
    cfg: {
      ai: {
        openrouterApiKey: over.key ?? "sk-test",
        models: over.models ?? ["meta/muse-spark-1.3-contributor"],
      },
    },
  }) as unknown as Parameters<typeof makeChatProbe>[0];

/**
 * A real `User`, not a two-field stand-in cast to one.
 *
 * The cast that stood here hid `assistantAllowed` from the compiler, so the field the probe
 * now reads arrived as `undefined` -- which is falsy, so every test would have measured "no
 * launcher" and called it the audience rule. A stand-in is only safe while nothing new is
 * ever read off it.
 */
const principal = (role: Role, over: Partial<User> = {}): Principal => {
  const user: User = {
    id: "u1",
    displayName: "Ada",
    role,
    plexId: null,
    plexUsername: null,
    createdAt: "2026-09-05T00:00:00.000Z",
    lastSeenAt: null,
    disabledAt: null,
    quotaPerDay: null,
    assistantAllowed: true,
    ...over,
  };
  return { kind: "session", user, role };
};

const GET = new Request("http://x/api/agent/chat");

describe("the assistant probe", () => {
  test("an ordinary account is told the assistant is available", async () => {
    const res = makeChatProbe(deps())(GET, principal("user"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ available: true });
  });

  test("an admin gets the identical answer -- the role decides nothing here", async () => {
    const res = makeChatProbe(deps())(GET, principal("admin"));
    expect(res.status).toBe(200);
  });

  /**
   * The refusal that used to exist. A 403 removes the launcher for this reader specifically
   * (`isTerminalRefusal` in the client), so a stray role check would not error -- it would
   * quietly hide the feature from everybody who is not an admin, which is exactly the state
   * being undone.
   */
  test("nothing answers 403 any more, whatever the role", () => {
    for (const role of ["user", "admin"] as const) {
      expect(makeChatProbe(deps())(GET, principal(role)).status).not.toBe(403);
    }
  });

  test("but an anonymous caller is still told nothing exists", () => {
    // 404 rather than 401: a surface you may not use does not announce itself. Same rule the
    // admin API follows.
    expect(makeChatProbe(deps())(GET, null).status).toBe(404);
  });

  test("and a deployment with no key has no assistant, for anybody", () => {
    // THE ONE GATE THAT SURVIVED. "If key etc are set" is the whole condition now.
    expect(makeChatProbe(deps({ key: "" }))(GET, principal("admin")).status).toBe(404);
    expect(makeChatProbe(deps({ models: [] }))(GET, principal("user")).status).toBe(404);
  });

  /**
   * The per-account switch, which is what an admin actually reaches for.
   *
   * 404 and not 403: the client treats a 403 as terminal for this reader too, but 404 is what
   * every other unavailable-here surface answers, and the two must not drift apart -- see the
   * route's header. What is pinned is that the switch is read at all, and that a ROLE cannot
   * stand in for it: an admin with it off gets nothing either.
   */
  test("an account an admin switched off has no assistant, whatever its role", () => {
    for (const role of ["user", "admin"] as const) {
      const off = principal(role, { assistantAllowed: false });
      expect(makeChatProbe(deps())(GET, off).status).toBe(404);
    }
  });
});

/**
 * WHICH CARDS THE PANEL DRAWS, AND IN WHAT ORDER.
 *
 * The reported run, 2026-09-06: asked "is there an Adrenochrome movie?", the agent searched
 * the misspelling, searched it again loosely, then searched the correct spelling. Every card
 * the reader could see came from the middle call -- the one the agent itself had discarded --
 * so the prose named two films that were not on screen while five unrelated ones were.
 */
describe("the cards beside an answer", () => {
  const call = (name: string, ids: string[], args: Record<string, unknown> = {}) => ({
    name,
    args,
    ms: 1,
    bytes: 1,
    evidence: { ids, relations: [] },
  });

  const run = (toolCalls: unknown[], answer: string) =>
    ({
      answer,
      turns: 1,
      toolCalls,
      ms: 1,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
    }) as unknown as Parameters<typeof surfaced>[0];

  // Every id resolves, so nothing here is testing the index -- only the ordering.
  const engine = {
    byTconst: (tconst: string) => ({ tconst, title: `T-${tconst}`, year: 2000, kind: "movie" }),
    episodesOf: () => [],
  } as unknown as Parameters<typeof surfaced>[1];
  const store = { getArtwork: () => undefined } as unknown as Parameters<typeof surfaced>[2];

  const JUNK = ["tt1731141", "tt0060107", "tt0870984", "tt1553656", "tt0213327"];

  test("a title the answer names outranks a discarded search's results", () => {
    const r = surfaced(
      run(
        [call("find_title", []), call("find_title", JUNK), call("find_title", ["tt2273648", "tt3628688"])],
        "Yes, there is Adrenochrome [tt2273648], and a follow-up Adrenochrome II [tt3628688].",
      ),
      engine,
      store,
      "Yes, there is Adrenochrome [tt2273648], and a follow-up Adrenochrome II [tt3628688].",
    );
    // The two the reader was told about are the two the reader sees first.
    expect(r.titles.slice(0, 2).map((t) => t.tconst)).toEqual(["tt2273648", "tt3628688"]);
    // And the discarded search is still THERE -- it is evidence, just not the answer.
    expect(r.titles).toHaveLength(7);
  });

  test("an answer that names nothing keeps plain evidence order", () => {
    const r = surfaced(
      run([call("find_title", JUNK)], "I could not find that."),
      engine,
      store,
      "I could not find that.",
    );
    expect(r.titles.map((t) => t.tconst)).toEqual(JUNK);
  });

  test("the cap is applied after the ordering, so a named title is never truncated away", () => {
    // 24 unrelated ids ahead of the one the answer is about: under the old order-then-cap the
    // named title fell off the end of the list entirely.
    const many = Array.from({ length: 30 }, (_, i) => `tt900${String(i).padStart(4, "0")}`);
    const r = surfaced(
      run([call("find_title", many), call("find_title", ["tt2273648"])], "It is Adrenochrome [tt2273648]."),
      engine,
      store,
      "It is Adrenochrome [tt2273648].",
    );
    expect(r.titles[0]?.tconst).toBe("tt2273648");
  });
});
