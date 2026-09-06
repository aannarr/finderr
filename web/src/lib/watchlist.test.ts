/**
 * The session's copy of the list: what it fetches, what it publishes, and what it puts back.
 *
 * `fetch` is stubbed for the whole file rather than injected, on the same reasoning
 * `agent-api.test.ts` states: this module IS the boundary, and a `fetchImpl` parameter would
 * exist only for this test while the real call site drifted away from what is asserted here.
 *
 * The three properties worth pinning are the ones a reader would notice: a save shows up
 * immediately, a save that FAILS is taken back rather than left lying, and one load answers
 * every caller.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Title } from "./api";
import { loadWatchlist, resetWatchlist, saveTitle, unsaveTitle } from "./watchlist";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  resetWatchlist();
});

/** Only the fields this module reads. The rest of a `Title` never leaves the server's word. */
function title(tconst: string, name: string): Title {
  return { tconst, title: name } as Title;
}

interface Call {
  url: string;
  method: string;
}

/** Answer every call with `status`, and record what was asked. */
function stub(status: number, body: unknown): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    return Promise.resolve(
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
    );
  }) as typeof fetch;
  return calls;
}

describe("loading", () => {
  test("one fetch answers every concurrent caller", async () => {
    const calls = stub(200, { titles: [title("tt1", "Alien")] });
    const [a, b] = await Promise.all([loadWatchlist(), loadWatchlist()]);
    expect(calls).toHaveLength(1);
    expect(a).toBe(b);
    expect(a.map((t) => t.tconst)).toEqual(["tt1"]);
  });

  test("a loaded list is not fetched twice", async () => {
    const calls = stub(200, { titles: [] });
    await loadWatchlist();
    await loadWatchlist();
    expect(calls).toHaveLength(1);
  });

  /**
   * A watchlist that will not load must not take the page down with it. The reader came here
   * to search; an empty list and a bookmark that offers to save is the graceful version, and
   * the failure is one they cannot act on anyway.
   */
  test("a failed load reads as an empty list rather than throwing", async () => {
    stub(500, { error: "nope" });
    expect(await loadWatchlist()).toEqual([]);
  });
});

describe("saving", () => {
  test("a save shows up before the server has answered, and asks the right thing", async () => {
    stub(200, { titles: [] });
    await loadWatchlist();

    const calls = stub(200, { saved: true });
    const pending = saveTitle(title("tt2", "Solaris"));
    // The list already has it -- that is what makes the button feel instant.
    expect((await loadWatchlist()).map((t) => t.tconst)).toEqual(["tt2"]);
    await pending;
    expect(calls).toEqual([{ url: "/api/watchlist", method: "POST" }]);
  });

  test("newest save first, matching the order the server returns", async () => {
    stub(200, { titles: [title("tt1", "Alien")] });
    await loadWatchlist();
    stub(200, { saved: true });
    await saveTitle(title("tt2", "Solaris"));
    expect((await loadWatchlist()).map((t) => t.tconst)).toEqual(["tt2", "tt1"]);
  });

  test("saving something already saved asks the server nothing", async () => {
    stub(200, { titles: [title("tt1", "Alien")] });
    await loadWatchlist();
    const calls = stub(200, { saved: false });
    await saveTitle(title("tt1", "Alien"));
    expect(calls).toEqual([]);
  });

  /**
   * The rollback is the whole reason the optimism is safe. Without it a refused save leaves a
   * filled bookmark and a row on a page, both describing something the server never stored.
   */
  test("a refused save is taken back, in the server's own words", async () => {
    stub(200, { titles: [] });
    await loadWatchlist();

    stub(401, { error: "sign in to keep a watchlist" });
    // Awaited, so the rollback has run by the time the list is read below.
    await expect(saveTitle(title("tt2", "Solaris"))).rejects.toThrow("sign in to keep a watchlist");
    expect((await loadWatchlist()).map((t) => t.tconst)).toEqual([]);
  });
});

describe("removing", () => {
  test("a removal is gone at once and asks the right thing", async () => {
    stub(200, { titles: [title("tt1", "Alien"), title("tt2", "Solaris")] });
    await loadWatchlist();

    const calls = stub(200, { removed: true });
    await unsaveTitle("tt1");
    expect((await loadWatchlist()).map((t) => t.tconst)).toEqual(["tt2"]);
    expect(calls).toEqual([{ url: "/api/watchlist/tt1", method: "DELETE" }]);
  });

  test("a refused removal puts the title back where it was", async () => {
    stub(200, { titles: [title("tt1", "Alien"), title("tt2", "Solaris")] });
    await loadWatchlist();

    stub(500, { error: "database is locked" });
    await expect(unsaveTitle("tt1")).rejects.toThrow("database is locked");
    expect((await loadWatchlist()).map((t) => t.tconst)).toEqual(["tt1", "tt2"]);
  });

  test("removing something that is not on the list asks the server nothing", async () => {
    stub(200, { titles: [] });
    await loadWatchlist();
    const calls = stub(200, { removed: false });
    await unsaveTitle("tt9");
    expect(calls).toEqual([]);
  });
});

/**
 * The race is small and real: the shell starts the load on mount, and a reader who saves
 * before it answers would otherwise have the save overwritten by a response computed before
 * the row existed -- leaving the bookmark empty for the rest of the session about a title the
 * server has. A load that lands in a changed world publishes nothing.
 */
describe("a save that beats the first load home", () => {
  test("the stale response does not erase it", async () => {
    // The load is held open until this test says so, which is the only way to put a save
    // strictly between the request going out and the answer coming back.
    const load = Promise.withResolvers<Response>();
    // Routed on the METHOD, not the path: the load and the save are the same URL, and a
    // stub that told them apart by path would hand the POST the load's held promise.
    globalThis.fetch = ((_url: string, init?: RequestInit) =>
      (init?.method ?? "GET") === "GET"
        ? load.promise
        : Promise.resolve(new Response(JSON.stringify({ saved: true }), { status: 200 }))) as typeof fetch;

    const loading = loadWatchlist();
    await saveTitle(title("tt2", "Solaris"));
    // The server answers the ORIGINAL question, from before the save existed.
    load.resolve(new Response(JSON.stringify({ titles: [] }), { status: 200 }));
    await loading;

    // Nothing was published, so the list is unloaded again rather than wrongly empty -- and
    // the next read fetches the truth.
    stub(200, { titles: [title("tt2", "Solaris")] });
    expect((await loadWatchlist()).map((t) => t.tconst)).toEqual(["tt2"]);
  });
});
