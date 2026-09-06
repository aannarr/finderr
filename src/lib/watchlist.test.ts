/**
 * The private list, on disk.
 *
 * Three properties are worth pinning and the rest is SQL doing its job: saving twice is one
 * row, the list comes back newest first, and one reader can never see another's. The fourth
 * is the cascade -- a list that outlived its owner would be somebody's private reading kept
 * on a machine after their account was deleted, which is the failure `on delete cascade`
 * exists to make impossible rather than remembered.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { AuthStore, applyAuthSchema } from "./auth-store";
import { applyWatchlistSchema, WatchlistStore } from "./watchlist";

/**
 * The two schemas in the order `Store`'s constructor applies them, with the pragma it sets.
 *
 * `foreign_keys` is NOT optional and neither is the ORDER: with the pragma off every cascade
 * is a comment, and with the schemas swapped the foreign key resolves to a table that does
 * not exist yet. Both mistakes pass a test that opens the databases separately.
 */
function open(): { auth: AuthStore; watchlist: WatchlistStore } {
  const db = new Database(":memory:");
  db.run("pragma foreign_keys = on");
  applyAuthSchema(db);
  applyWatchlistSchema(db);
  return { auth: new AuthStore(db), watchlist: new WatchlistStore(db) };
}

let auth: AuthStore;
let watchlist: WatchlistStore;
let ada: string;
let grace: string;

beforeEach(() => {
  ({ auth, watchlist } = open());
  ada = auth.createUser({ displayName: "Ada", role: "user" }).id;
  grace = auth.createUser({ displayName: "Grace", role: "user" }).id;
});

/** Saved at a pinned moment, so the ordering assertions describe the data and not the clock. */
function saveAt(userId: string, tconst: string, iso: string): boolean {
  return watchlist.add(userId, tconst, new Date(iso));
}

describe("saving", () => {
  test("a saved title is on the list, and saving it again changes nothing", () => {
    expect(saveAt(ada, "tt0111161", "2026-09-01T10:00:00.000Z")).toBe(true);
    // The second save reports false -- that is how a caller tells "saved" from "already
    // saved" without a read of its own -- and leaves one row with its original stamp.
    expect(saveAt(ada, "tt0111161", "2026-09-02T10:00:00.000Z")).toBe(false);
    expect(watchlist.list(ada)).toEqual([{ tconst: "tt0111161", added_at: "2026-09-01T10:00:00.000Z" }]);
  });

  test("the list is newest save first", () => {
    saveAt(ada, "tt0000001", "2026-09-01T10:00:00.000Z");
    saveAt(ada, "tt0000003", "2026-09-03T10:00:00.000Z");
    saveAt(ada, "tt0000002", "2026-09-02T10:00:00.000Z");
    expect(watchlist.list(ada).map((e) => e.tconst)).toEqual(["tt0000003", "tt0000002", "tt0000001"]);
  });

  test("two readers saving the same film keep two independent lists", () => {
    saveAt(ada, "tt0111161", "2026-09-01T10:00:00.000Z");
    saveAt(grace, "tt0111161", "2026-09-01T11:00:00.000Z");
    watchlist.remove(ada, "tt0111161");
    expect(watchlist.list(ada)).toEqual([]);
    expect(watchlist.list(grace).map((e) => e.tconst)).toEqual(["tt0111161"]);
  });
});

describe("removing", () => {
  test("removing reports whether there was anything to remove", () => {
    saveAt(ada, "tt0111161", "2026-09-01T10:00:00.000Z");
    expect(watchlist.remove(ada, "tt0111161")).toBe(true);
    expect(watchlist.remove(ada, "tt0111161")).toBe(false);
  });

  test("one reader cannot remove another's save", () => {
    saveAt(grace, "tt0111161", "2026-09-01T10:00:00.000Z");
    expect(watchlist.remove(ada, "tt0111161")).toBe(false);
    expect(watchlist.list(grace)).toHaveLength(1);
  });
});

describe("the account it belongs to", () => {
  test("a deleted user takes their whole list with them", () => {
    saveAt(ada, "tt0111161", "2026-09-01T10:00:00.000Z");
    saveAt(grace, "tt0068646", "2026-09-01T10:00:00.000Z");
    auth.deleteUser(ada);
    expect(watchlist.list(ada)).toEqual([]);
    expect(watchlist.stats()).toEqual({ rows: 1, readers: 1 });
  });

  test("a title can only be saved by an account that exists", () => {
    expect(() => watchlist.add("nobody", "tt0111161")).toThrow();
  });
});

describe("stats", () => {
  test("counts rows and readers, and names neither", () => {
    expect(watchlist.stats()).toEqual({ rows: 0, readers: 0 });
    saveAt(ada, "tt0000001", "2026-09-01T10:00:00.000Z");
    saveAt(ada, "tt0000002", "2026-09-01T10:00:01.000Z");
    saveAt(grace, "tt0000001", "2026-09-01T10:00:02.000Z");
    expect(watchlist.stats()).toEqual({ rows: 3, readers: 2 });
  });
});
