import { describe, expect, test } from "bun:test";
import { Cache } from "./cache";

describe("eviction", () => {
  test("the oldest entry goes when the cap is passed", () => {
    const c = new Cache<number>(2);
    c.set("a", 1);
    c.set("b", 2);
    c.set("c", 3);
    expect(c.get("a")).toBeUndefined();
    expect(c.size).toBe(2);
  });

  test("reading an entry makes it the newest, so it survives the next eviction", () => {
    const c = new Cache<number>(2);
    c.set("a", 1);
    c.set("b", 2);
    c.get("a");
    c.set("c", 3);
    // `b` was the least recently USED, not the least recently written.
    expect(c.get("a")).toBe(1);
    expect(c.get("b")).toBeUndefined();
  });
});

/**
 * THE ONE DISTINCTION THIS CLASS EXISTS TO CARRY.
 *
 * Restored entries come from a previous session, so a request may have completed and a
 * film may have arrived since. `get` returns them, because painting last session's header
 * instantly and correcting it a moment later is exactly what a reader on a phone wants.
 * `fresh` refuses them, so the fetch that would have happened still happens.
 *
 * Get this backwards and a title page goes on claiming a film is missing hours after it
 * arrived, with nothing on screen to suggest the page is out of date.
 */
describe("restored entries", () => {
  test("get draws them and fresh refuses them", () => {
    const c = new Cache<string>(10);
    c.restore([["tt1", "last session"]]);
    expect(c.get("tt1")).toBe("last session");
    expect(c.fresh("tt1")).toBeUndefined();
  });

  test("a real response supersedes the restored copy for both", () => {
    const c = new Cache<string>(10);
    c.restore([["tt1", "last session"]]);
    c.set("tt1", "this session");
    expect(c.get("tt1")).toBe("this session");
    expect(c.fresh("tt1")).toBe("this session");
  });

  /**
   * Hydration races the first fetches on a slow start. A response that has already landed
   * is this session's answer, and last session's picture of it must not overwrite one.
   */
  test("restore goes UNDER what is already there", () => {
    const c = new Cache<string>(10);
    c.set("tt1", "this session");
    c.restore([["tt1", "last session"]]);
    expect(c.get("tt1")).toBe("this session");
    expect(c.fresh("tt1")).toBe("this session");
  });

  test("restoring more than the cap trims oldest-first, like set does", () => {
    const c = new Cache<number>(2);
    c.restore([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
    expect(c.size).toBe(2);
    expect(c.get("a")).toBeUndefined();
    expect(c.get("c")).toBe(3);
  });

  test("an evicted key stops being remembered as restored", () => {
    const c = new Cache<number>(1);
    c.restore([["a", 1]]);
    c.set("b", 2);
    // `a` is gone entirely. Re-fetching it must land in the cache as this session's
    // answer -- a leaked flag would make `fresh` refuse a row it had just written.
    c.set("a", 9);
    expect(c.fresh("a")).toBe(9);
  });
});

describe("revision", () => {
  test("it moves on a write and on a clear", () => {
    const c = new Cache<number>(10);
    const start = c.revision;
    c.set("a", 1);
    expect(c.revision).toBeGreaterThan(start);
    const afterSet = c.revision;
    c.clear();
    expect(c.revision).toBeGreaterThan(afterSet);
  });

  /**
   * Restoring must NOT count as a change, or the first flush of every session rewrites the
   * snapshot it has just finished reading -- on every app switch, for a session that did
   * nothing at all.
   */
  test("restoring does not move it", () => {
    const c = new Cache<number>(10);
    const start = c.revision;
    c.restore([["a", 1]]);
    expect(c.revision).toBe(start);
  });

  test("a read does not move it", () => {
    const c = new Cache<number>(10);
    c.set("a", 1);
    const after = c.revision;
    c.get("a");
    c.fresh("a");
    expect(c.revision).toBe(after);
  });
});

describe("entries and values", () => {
  test("entries are least-recently-used first, which is what a bounded snapshot slices", () => {
    const c = new Cache<number>(10);
    c.set("a", 1);
    c.set("b", 2);
    c.get("a");
    expect(c.entries().map(([k]) => k)).toEqual(["b", "a"]);
  });

  test("values walks what is held, in the same order", () => {
    const c = new Cache<number>(10);
    c.set("a", 1);
    c.set("b", 2);
    expect([...c.values()]).toEqual([1, 2]);
  });
});
