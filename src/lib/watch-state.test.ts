/**
 * Watch state, on disk.
 *
 * Pinned: one row per (reader, title, season, episode) however often it is written; readers
 * never see each other's; a film uses the sentinel on disk and null on the way out; history is
 * newest first and pages stably; delete takes one episode or the whole title; the account
 * cascade; and that neither read needs a temp b-tree -- the index shape is the point of the
 * schema, so it is asserted rather than assumed.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { AuthStore, applyAuthSchema } from "./auth-store";
import { NOT_AN_EPISODE } from "./media-file";
import { applyWatchStateSchema, FILM_KEY, FOR_TITLE_SQL, HISTORY_SQL, WatchStateStore } from "./watch-state";

const FILM = "tt0092494";
const SERIES = "tt0944947";

let db: Database;
let auth: AuthStore;
let watch: WatchStateStore;
let ada: string;
let grace: string;

/** Same order and pragma as `Store`'s constructor -- see `watchlist.test.ts` for why both matter. */
beforeEach(() => {
  db = new Database(":memory:");
  db.run("pragma foreign_keys = on");
  applyAuthSchema(db);
  applyWatchStateSchema(db);
  auth = new AuthStore(db);
  watch = new WatchStateStore(db);
  ada = auth.createUser({ displayName: "Ada", role: "user" }).id;
  grace = auth.createUser({ displayName: "Grace", role: "user" }).id;
});

const at = (iso: string) => new Date(iso);
const ep = (season: number, episode: number, positionSec: number, durationSec = 3000) => ({
  season,
  episode,
  positionSec,
  durationSec,
});

describe("upsert", () => {
  test("writing the same key again updates one row", () => {
    watch.upsert(ada, SERIES, ep(1, 1, 60), at("2026-09-15T10:00:00Z"));
    const second = watch.upsert(ada, SERIES, ep(1, 1, 120), at("2026-09-15T10:00:15Z"));
    expect(second.positionSec).toBe(120);
    expect(db.query("select count(*) as n from watch_state").get()).toEqual({ n: 1 });
    expect(watch.get(ada, SERIES, { season: 1, episode: 1 })).toEqual(second);
  });

  test("a film is stored under the sentinel and read back with null season and episode", () => {
    const entry = watch.upsert(ada, FILM, { ...FILM_KEY, positionSec: 42, durationSec: 5400 });
    expect(entry.season).toBeNull();
    expect(entry.episode).toBeNull();
    expect(db.query("select season, episode from watch_state").get()).toEqual({
      season: NOT_AN_EPISODE,
      episode: NOT_AN_EPISODE,
    });
    expect(watch.get(ada, FILM, FILM_KEY)?.positionSec).toBe(42);
  });

  test("finished follows the threshold on both branches, and is recomputed on every write", () => {
    // 50-minute episode: 5% = 150 s.
    expect(watch.upsert(ada, SERIES, ep(1, 1, 3000 - 150)).finished).toBe(true);
    expect(watch.upsert(ada, SERIES, ep(1, 2, 3000 - 151)).finished).toBe(false);
    // 2-hour film: 180 s.
    const film = { ...FILM_KEY, durationSec: 7200 };
    expect(watch.upsert(ada, FILM, { ...film, positionSec: 7200 - 180 }).finished).toBe(true);
    // Restarting a finished film is watching it again.
    expect(watch.upsert(ada, FILM, { ...film, positionSec: 30 }).finished).toBe(false);
  });

  test("season 0 is a real key, distinct from the film sentinel", () => {
    watch.upsert(ada, SERIES, ep(0, 1, 10));
    expect(watch.get(ada, SERIES, FILM_KEY)).toBeNull();
    expect(watch.get(ada, SERIES, { season: 0, episode: 1 })?.season).toBe(0);
  });
});

describe("isolation", () => {
  test("one reader never reads, pages or deletes another's state", () => {
    watch.upsert(ada, SERIES, ep(1, 1, 60));
    expect(watch.forTitle(grace, SERIES)).toEqual([]);
    expect(watch.get(grace, SERIES, { season: 1, episode: 1 })).toBeNull();
    expect(watch.history(grace, { limit: 10, offset: 0 })).toEqual({ entries: [], hasMore: false });
    expect(watch.remove(grace, SERIES)).toBe(0);
    expect(watch.forTitle(ada, SERIES)).toHaveLength(1);
  });

  test("the same key for two readers is two rows", () => {
    watch.upsert(ada, FILM, { ...FILM_KEY, positionSec: 10, durationSec: 100 });
    watch.upsert(grace, FILM, { ...FILM_KEY, positionSec: 90, durationSec: 100 });
    expect(watch.get(ada, FILM, FILM_KEY)?.positionSec).toBe(10);
    expect(watch.get(grace, FILM, FILM_KEY)?.positionSec).toBe(90);
  });

  test("deleting the account deletes its history", () => {
    watch.upsert(ada, FILM, { ...FILM_KEY, positionSec: 10, durationSec: 100 });
    db.run("delete from app_user where id = ?", [ada]);
    expect(db.query("select count(*) as n from watch_state").get()).toEqual({ n: 0 });
  });
});

describe("reads", () => {
  test("forTitle orders by season then episode, whatever the write order", () => {
    watch.upsert(ada, SERIES, ep(2, 1, 1));
    watch.upsert(ada, SERIES, ep(1, 10, 1));
    watch.upsert(ada, SERIES, ep(1, 2, 1));
    expect(watch.forTitle(ada, SERIES).map((e) => [e.season, e.episode])).toEqual([
      [1, 2],
      [1, 10],
      [2, 1],
    ]);
  });

  test("history is newest first and pages without overlap or gaps", () => {
    const base = Date.parse("2026-09-15T00:00:00Z");
    for (let i = 1; i <= 5; i++) watch.upsert(ada, SERIES, ep(1, i, 10), new Date(base + i * 1000));
    const first = watch.history(ada, { limit: 2, offset: 0 });
    const second = watch.history(ada, { limit: 2, offset: 2 });
    const last = watch.history(ada, { limit: 2, offset: 4 });
    expect(first.entries.map((e) => e.episode)).toEqual([5, 4]);
    expect(second.entries.map((e) => e.episode)).toEqual([3, 2]);
    expect(last.entries.map((e) => e.episode)).toEqual([1]);
    expect([first.hasMore, second.hasMore, last.hasMore]).toEqual([true, true, false]);
  });

  test("a rewrite moves an entry back to the top of history", () => {
    watch.upsert(ada, FILM, { ...FILM_KEY, positionSec: 1, durationSec: 100 }, at("2026-09-15T10:00:00Z"));
    watch.upsert(ada, SERIES, ep(1, 1, 1), at("2026-09-15T11:00:00Z"));
    watch.upsert(ada, FILM, { ...FILM_KEY, positionSec: 2, durationSec: 100 }, at("2026-09-15T12:00:00Z"));
    expect(watch.history(ada, { limit: 10, offset: 0 }).entries.map((e) => e.tconst)).toEqual([FILM, SERIES]);
  });

  test("neither read builds a temp b-tree", () => {
    const plan = (sql: string, ...args: (string | number)[]) =>
      (db.query(`explain query plan ${sql}`).all(...args) as { detail: string }[]).map((r) => r.detail);
    const history = plan(HISTORY_SQL, ada, 11, 0);
    const forTitle = plan(FOR_TITLE_SQL, ada, SERIES);
    expect(history.join(" | ")).toContain("ix_watch_state_user_updated");
    expect(forTitle.join(" | ")).toContain("PRIMARY KEY");
    for (const detail of [...history, ...forTitle]) expect(detail).not.toContain("TEMP B-TREE");
  });
});

describe("remove", () => {
  test("one episode, then the whole title", () => {
    watch.upsert(ada, SERIES, ep(1, 1, 1));
    watch.upsert(ada, SERIES, ep(1, 2, 1));
    watch.upsert(ada, SERIES, ep(1, 3, 1));
    expect(watch.remove(ada, SERIES, { season: 1, episode: 2 })).toBe(1);
    expect(watch.forTitle(ada, SERIES).map((e) => e.episode)).toEqual([1, 3]);
    expect(watch.remove(ada, SERIES)).toBe(2);
    expect(watch.forTitle(ada, SERIES)).toEqual([]);
  });
});
