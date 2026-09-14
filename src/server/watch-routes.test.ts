/**
 * The watch routes, against the real handlers and a real in-memory store.
 *
 * `readerId` is faked from a header so a test names its caller in one word; the store, the
 * guards and the JSON parsing are the real ones. `withAuth` is not in front -- that the routes
 * are private by having been added is `withAuth`'s own suite.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { AuthStore, applyAuthSchema } from "../lib/auth-store";
import { LIMITS } from "../lib/input-guards";
import type { WatchEntry, WatchHistoryPage, WatchState } from "../lib/watch-progress";
import { applyWatchStateSchema, WatchStateStore } from "../lib/watch-state";
import { watchRoutes } from "./watch-routes";

const FILM = "tt0092494";
const SERIES = "tt0944947";

type Handler = (req: never) => Response | Promise<Response>;
let routes: Record<string, Record<string, Handler>>;
let ada: string;
let grace: string;
let clock: number;

beforeEach(() => {
  const db = new Database(":memory:");
  db.run("pragma foreign_keys = on");
  applyAuthSchema(db);
  applyWatchStateSchema(db);
  const auth = new AuthStore(db);
  ada = auth.createUser({ displayName: "Ada", role: "user" }).id;
  grace = auth.createUser({ displayName: "Grace", role: "user" }).id;
  clock = Date.parse("2026-09-15T10:00:00Z");
  routes = watchRoutes({
    store: new WatchStateStore(db),
    readerId: (req) => req.headers.get("x-reader"),
    // Each write a second later, so "most recent" is decided by data rather than a race.
    now: () => {
      clock += 1000;
      return new Date(clock);
    },
  }) as never;
});

function call(
  method: string,
  path: string,
  opts: { as?: string; body?: string; type?: string; tconst?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.as) headers["x-reader"] = opts.as;
  if (opts.type) headers["content-type"] = opts.type;
  const req = Object.assign(new Request(`http://finderr.test${path}`, { method, headers, body: opts.body }), {
    params: { tconst: opts.tconst ?? "" },
  });
  const table = path.startsWith("/api/watch/history") ? "/api/watch/history" : "/api/watch/:tconst";
  return Promise.resolve(routes[table][method](req as never));
}

// `null` means "nobody signed in". NOT `undefined`: that would silently take the `ada` default.
const put = (tconst: string, body: unknown, as: string | null = ada) =>
  call("PUT", `/api/watch/${tconst}`, {
    as: as ?? undefined,
    tconst,
    body: JSON.stringify(body),
    type: "application/json",
  });
const read = async (tconst: string, as: string | null = ada) =>
  (await (await call("GET", `/api/watch/${tconst}`, { as: as ?? undefined, tconst })).json()) as WatchState;
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

describe("write", () => {
  test("PUT stores a film and GET returns it as the resume point", async () => {
    const res = await put(FILM, { positionSec: 600, durationSec: 5400 });
    expect(res.status).toBe(200);
    const stored = (await res.json()) as WatchEntry;
    expect(stored).toMatchObject({
      tconst: FILM,
      season: null,
      episode: null,
      positionSec: 600,
      finished: false,
    });
    expect(await read(FILM)).toEqual({ resume: stored, episodes: [] });
  });

  test("POST with a text/plain body -- what sendBeacon sends -- is the same write", async () => {
    const res = await call("POST", `/api/watch/${SERIES}`, {
      as: ada,
      tconst: SERIES,
      type: "text/plain;charset=UTF-8",
      body: JSON.stringify({ season: 1, episode: 3, positionSec: 2990, durationSec: 3000 }),
    });
    expect(res.status).toBe(200);
    const state = await read(SERIES);
    expect(state.episodes).toHaveLength(1);
    expect(state.resume).toMatchObject({ season: 1, episode: 3, finished: true });
  });

  test("a series returns every episode, and the resume point is the most recently updated", async () => {
    await put(SERIES, { season: 1, episode: 2, positionSec: 100, durationSec: 3000 });
    await put(SERIES, { season: 1, episode: 1, positionSec: 100, durationSec: 3000 });
    await put(SERIES, { season: 2, episode: 1, positionSec: 100, durationSec: 3000 });
    await put(SERIES, { season: 1, episode: 2, positionSec: 200, durationSec: 3000 });
    const state = await read(SERIES);
    expect(state.episodes.map((e) => [e.season, e.episode])).toEqual([
      [1, 1],
      [1, 2],
      [2, 1],
    ]);
    expect(state.resume).toMatchObject({ season: 1, episode: 2, positionSec: 200 });
  });

  test("a caller with no user writes nothing and reads empty", async () => {
    const res = await put(FILM, { positionSec: 600, durationSec: 5400 }, null);
    expect(res.status).toBe(204);
    expect(await read(FILM, null)).toEqual({ resume: null, episodes: [] });
    expect(await read(FILM, ada)).toEqual({ resume: null, episodes: [] });
    const beacon = await call("POST", `/api/watch/${FILM}`, {
      tconst: FILM,
      body: JSON.stringify({ positionSec: 1, durationSec: 2 }),
    });
    expect(beacon.status).toBe(204);
    const del = await call("DELETE", `/api/watch/${FILM}`, { tconst: FILM });
    expect(del.status).toBe(204);
    const history = await call("GET", "/api/watch/history");
    expect(await history.json()).toEqual({ entries: [], hasMore: false });
  });
});

describe("every bound is refused with a 400 naming it", () => {
  const cases: [string, unknown, string][] = [
    ["season without episode", { season: 1, positionSec: 1, durationSec: 10 }, "together"],
    ["episode without season", { episode: 1, positionSec: 1, durationSec: 10 }, "together"],
    [
      "season past its limit",
      { season: LIMITS.seasonNumber + 1, episode: 1, positionSec: 1, durationSec: 10 },
      `season is out of range (limit ${LIMITS.seasonNumber})`,
    ],
    [
      "episode past its limit",
      { season: 1, episode: LIMITS.episodeNumber + 1, positionSec: 1, durationSec: 10 },
      `episode is out of range (limit ${LIMITS.episodeNumber})`,
    ],
    [
      "a fractional episode",
      { season: 1, episode: 1.5, positionSec: 1, durationSec: 10 },
      "episode has the wrong type",
    ],
    [
      "a negative season",
      { season: -1, episode: 1, positionSec: 1, durationSec: 10 },
      "season is out of range",
    ],
    ["a negative position", { positionSec: -1, durationSec: 10 }, "positionSec is out of range"],
    ["a position as a string", { positionSec: "12", durationSec: 10 }, "positionSec has the wrong type"],
    ["no position", { durationSec: 10 }, "positionSec is required"],
    ["no duration", { positionSec: 1 }, "durationSec is required"],
    ["a zero duration", { positionSec: 0, durationSec: 0 }, "durationSec is required"],
    [
      "a duration past 24 h",
      { positionSec: 1, durationSec: LIMITS.watchSeconds + 1 },
      `durationSec is out of range (limit ${LIMITS.watchSeconds})`,
    ],
    [
      "a position past the end by more than the overshoot",
      { positionSec: 100 + LIMITS.watchOvershootSec + 1, durationSec: 100 },
      `limit ${LIMITS.watchOvershootSec}s over`,
    ],
    ["an array body", [1, 2], "body must be a JSON object"],
  ];
  for (const [name, body, message] of cases) {
    test(name, async () => {
      const res = await put(SERIES, body);
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toContain(message);
    });
  }

  test("a position inside the overshoot is accepted and reads as finished", async () => {
    const res = await put(FILM, { positionSec: 100 + LIMITS.watchOvershootSec, durationSec: 100 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as WatchEntry).finished).toBe(true);
  });

  test("a body that is not JSON", async () => {
    const res = await call("PUT", `/api/watch/${FILM}`, { as: ada, tconst: FILM, body: "{nope" });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("body must be JSON");
  });

  test("a body past its limit", async () => {
    const body = JSON.stringify({ positionSec: 1, durationSec: 10, pad: "x".repeat(LIMITS.watchBody) });
    const res = await call("PUT", `/api/watch/${FILM}`, { as: ada, tconst: FILM, body });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe(`body is too long (limit ${LIMITS.watchBody})`);
  });

  test("a tconst that is not an IMDb id, on every method", async () => {
    for (const bad of ["history", "tt1", "nm0000138", `tt${"1".repeat(LIMITS.id)}`, "tt0092494/../x"]) {
      for (const method of ["GET", "PUT", "POST", "DELETE"]) {
        const res = await call(method, `/api/watch/x`, {
          as: ada,
          tconst: bad,
          body: method.startsWith("P") ? "{}" : undefined,
        });
        expect(res.status).toBe(400);
      }
    }
  });

  test("history limit and offset", async () => {
    for (const q of [
      "limit=0",
      `limit=${LIMITS.pageSize + 1}`,
      `offset=${LIMITS.pageOffset + 1}`,
      "limit=-1",
      "offset=abc",
    ]) {
      const res = await call("GET", `/api/watch/history?${q}`, { as: ada });
      expect(res.status).toBe(400);
    }
    const ok = await call("GET", `/api/watch/history?limit=${LIMITS.pageSize}&offset=${LIMITS.pageOffset}`, {
      as: ada,
    });
    expect(ok.status).toBe(200);
  });

  test("delete with half a key, or a key out of range", async () => {
    for (const q of [
      "season=1",
      "episode=1",
      `season=1&episode=${LIMITS.episodeNumber + 1}`,
      "season=x&episode=1",
    ]) {
      const res = await call("DELETE", `/api/watch/${SERIES}?${q}`, { as: ada, tconst: SERIES });
      expect(res.status).toBe(400);
    }
  });
});

describe("isolation between readers", () => {
  test("Grace cannot read, page or delete what Ada wrote", async () => {
    await put(SERIES, { season: 1, episode: 1, positionSec: 100, durationSec: 3000 }, ada);
    expect(await read(SERIES, grace)).toEqual({ resume: null, episodes: [] });
    const history = (await (
      await call("GET", "/api/watch/history", { as: grace })
    ).json()) as WatchHistoryPage;
    expect(history.entries).toEqual([]);
    const del = await call("DELETE", `/api/watch/${SERIES}`, { as: grace, tconst: SERIES });
    expect(await del.json()).toEqual({ removed: 0 });
    expect((await read(SERIES, ada)).episodes).toHaveLength(1);
  });
});

describe("history and delete", () => {
  test("history is newest first and pages", async () => {
    await put(FILM, { positionSec: 1, durationSec: 100 });
    await put(SERIES, { season: 1, episode: 1, positionSec: 1, durationSec: 100 });
    await put(SERIES, { season: 1, episode: 2, positionSec: 1, durationSec: 100 });
    const page = (await (
      await call("GET", "/api/watch/history?limit=2", { as: ada })
    ).json()) as WatchHistoryPage;
    expect(page.entries.map((e) => [e.tconst, e.episode])).toEqual([
      [SERIES, 2],
      [SERIES, 1],
    ]);
    expect(page.hasMore).toBe(true);
    const rest = (await (
      await call("GET", "/api/watch/history?limit=2&offset=2", { as: ada })
    ).json()) as WatchHistoryPage;
    expect(rest).toMatchObject({ hasMore: false, entries: [{ tconst: FILM, season: null }] });
  });

  test("delete one episode, then the whole title", async () => {
    await put(SERIES, { season: 1, episode: 1, positionSec: 1, durationSec: 100 });
    await put(SERIES, { season: 1, episode: 2, positionSec: 1, durationSec: 100 });
    const one = await call("DELETE", `/api/watch/${SERIES}?season=1&episode=1`, { as: ada, tconst: SERIES });
    expect(await one.json()).toEqual({ removed: 1 });
    expect((await read(SERIES)).episodes.map((e) => e.episode)).toEqual([2]);
    const all = await call("DELETE", `/api/watch/${SERIES}`, { as: ada, tconst: SERIES });
    expect(await all.json()).toEqual({ removed: 1 });
    expect(await read(SERIES)).toEqual({ resume: null, episodes: [] });
  });
});
