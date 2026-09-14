/**
 * `/api/place/:id` as a caller drives it: what reaches the engine, and what comes back.
 *
 * The engine is a recording fake, so what is under test is the route's own rules -- the id
 * guard, the refused bounds and the 404s -- rather than SQLite, which `filming-locations.test.ts` owns.
 */

import { describe, expect, test } from "bun:test";
import type { Place } from "../lib/filming-locations";
import { LIMITS } from "../lib/input-guards";
import type { TitleRow } from "../lib/search";
import { PLACE_PAGE_DEFAULT, type PlacePageSource, placeResponse } from "./place-route";

const ALMERIA: Place = {
  id: "Q10400",
  label: "Almería",
  kind: "area",
  studio: false,
  country: "ES",
  lat: 36.84,
  lon: -2.46,
  titles: 3,
};

function harness(held: number[] = [10400]) {
  const calls: { id: number; limit: number; offset: number }[] = [];
  const engine: PlacePageSource = {
    placePage: (id, opts) => {
      calls.push({ id, ...opts });
      if (!held.includes(id)) return null;
      const titles = [{ tconst: "tt0060196" }, { tconst: "tt0944947" }] as TitleRow[];
      return { place: ALMERIA, titles, total: 3, parts: { tt0944947: { episodes: 2, seasons: 0 } } };
    },
  };
  const decorate = (rows: TitleRow[]) => rows.map((r) => ({ ...r, decorated: true }));
  const get = async (id: string, qs = "") => {
    const res = placeResponse(engine, decorate, id, new URL(`http://x/api/place/${id}${qs}`));
    return { res, body: (await res.json()) as Record<string, unknown> };
  };
  return { calls, get };
}

describe("/api/place/:id", () => {
  test("a held place answers its page, decorated, with the total and the episode counts", async () => {
    const { get, calls } = harness();
    const { res, body } = await get("Q10400");
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ id: 10400, limit: PLACE_PAGE_DEFAULT, offset: 0 }]);
    expect(body.place).toEqual(ALMERIA);
    expect(body.total).toBe(3);
    expect(body.parts).toEqual({ tt0944947: { episodes: 2, seasons: 0 } });
    expect(body.titles).toEqual([
      { tconst: "tt0060196", decorated: true },
      { tconst: "tt0944947", decorated: true },
    ]);
    // Cacheable per session: the index only changes at a rebuild.
    expect(res.headers.get("cache-control")).not.toContain("no-store");
  });

  test("a malformed id is a 404 that never reaches the engine", async () => {
    const { get, calls } = harness();
    for (const bad of ["10400", "Q0", "P915", "Q10400;drop", "Q1234567890123"]) {
      const { res, body } = await get(bad);
      expect(res.status).toBe(404);
      expect(body.error).toBe("unknown place");
    }
    expect(calls).toEqual([]);
  });

  test("a well-formed id we hold nothing for is the same 404", async () => {
    const { get, calls } = harness();
    const { res } = await get("Q65");
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(1);
  });

  test("a limit and offset inside their bounds reach the engine as sent", async () => {
    const { get, calls } = harness();
    await get("Q10400", `?limit=${LIMITS.pageSize}&offset=${LIMITS.pageOffset}`);
    await get("Q10400", "?limit=1&offset=0");
    expect(calls).toEqual([
      { id: 10400, limit: LIMITS.pageSize, offset: LIMITS.pageOffset },
      { id: 10400, limit: 1, offset: 0 },
    ]);
  });

  /*
    REFUSED, not clamped -- the fifth rule. The first version quietly served 200 rows to a
    caller who asked for 100,000, which the round-3 review of 2026-09-14 caught.
  */
  test("past its bound, a limit or offset is a 400 naming the limit, and the engine is never asked", async () => {
    const { get, calls } = harness();
    for (const [qs, message] of [
      [`?limit=${LIMITS.pageSize + 1}`, `limit is out of range (limit ${LIMITS.pageSize})`],
      ["?limit=0", `limit is out of range (limit ${LIMITS.pageSize})`],
      [`?offset=${LIMITS.pageOffset + 1}`, `offset is out of range (limit ${LIMITS.pageOffset})`],
    ] as const) {
      const { res, body } = await get("Q10400", qs);
      expect(res.status).toBe(400);
      expect(body.error).toBe(message);
    }
    expect(calls).toEqual([]);
  });

  test("a limit or offset that is not a plain whole number is refused, not guessed at", async () => {
    const { get, calls } = harness();
    for (const qs of ["?limit=abc", "?offset=-5", "?limit=1e2", "?offset=12.5", "?limit=%2060"]) {
      const { res, body } = await get("Q10400", qs);
      expect(res.status).toBe(400);
      expect(String(body.error)).toContain("wrong type");
    }
    expect(calls).toEqual([]);
  });

  test("a lower-case q is the same place", async () => {
    const { get, calls } = harness();
    const { res } = await get("q10400");
    expect(res.status).toBe(200);
    expect(calls[0]?.id).toBe(10400);
  });
});
