/**
 * `/api/place/:id` as a caller drives it: what reaches the engine, and what comes back.
 *
 * The engine is a recording fake, so what is under test is the route's own rules -- the id
 * guard, the clamps and the 404s -- rather than SQLite, which `filming-locations.test.ts` owns.
 */

import { describe, expect, test } from "bun:test";
import type { Place } from "../lib/filming-locations";
import type { TitleRow } from "../lib/search";
import { PLACE_PAGE_DEFAULT, PLACE_PAGE_MAX, type PlacePageSource, placeResponse } from "./place-route";

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
      return { place: ALMERIA, titles, total: 3, episodes: { tt0944947: 2 } };
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
    expect(body.episodes).toEqual({ tt0944947: 2 });
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

  test("limit and offset are clamped rather than trusted, and garbage falls back", async () => {
    const { get, calls } = harness();
    await get("Q10400", "?limit=100000&offset=-5");
    await get("Q10400", "?limit=0&offset=120");
    await get("Q10400", "?limit=abc&offset=abc");
    expect(calls).toEqual([
      { id: 10400, limit: PLACE_PAGE_MAX, offset: 0 },
      { id: 10400, limit: 1, offset: 120 },
      { id: 10400, limit: PLACE_PAGE_DEFAULT, offset: 0 },
    ]);
  });

  test("a lower-case q is the same place", async () => {
    const { get, calls } = harness();
    const { res } = await get("q10400");
    expect(res.status).toBe(200);
    expect(calls[0]?.id).toBe(10400);
  });
});
