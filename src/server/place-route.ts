/**
 * `/api/place/:id` -- one filming location and a page of the titles filmed there.
 *
 * Its own module so the parts a caller can get wrong are tested as a caller drives them: an
 * id that is not a Q id, a place we hold nothing for, a `limit` of a million, a negative
 * offset. `index.ts` hands over the live engine and its `decorate`, so nothing here stands up
 * a store or an index.
 *
 * Local SQLite only: `place` and `title_place` are built into the index from Wikidata, so this
 * asks nothing of anybody. A place we hold no title for, a malformed id and an index built
 * before the stage are all the same 404 -- there is no page here, and the last one fixes itself
 * at the next rebuild.
 */

import { type Place, parsePlaceId } from "../lib/filming-locations";
import { clampInt } from "../lib/input-guards";
import type { TitleRow } from "../lib/search";
import { perSession } from "./cache-policy";
import { json } from "./json-response";

/** The page size the browser asks for, and what a request with no `limit` gets. */
export const PLACE_PAGE_DEFAULT = 60;
/** The most one request may take. Refused past it by clamping, the rule `/api/person` follows. */
export const PLACE_PAGE_MAX = 200;
/** Far past the longest place on any build (Los Angeles, 1,374 titles on 2026-09-14). */
export const PLACE_OFFSET_MAX = 1_000_000;

/** The one engine method this route reads. `SearchEngine` satisfies it. */
export interface PlacePageSource {
  placePage(
    id: number,
    opts: { limit: number; offset: number },
  ): { place: Place; titles: TitleRow[]; total: number; episodes: Record<string, number> } | null;
}

const notFound = () => json({ error: "unknown place" }, { status: 404 });

export function placeResponse(
  engine: PlacePageSource,
  decorate: (rows: TitleRow[]) => unknown[],
  rawId: string,
  url: URL,
): Response {
  const id = parsePlaceId(rawId);
  if (id === null) return notFound();
  const q = url.searchParams;
  const limit =
    clampInt(q.get("limit"), { min: 1, max: PLACE_PAGE_MAX, fallback: PLACE_PAGE_DEFAULT }) ??
    PLACE_PAGE_DEFAULT;
  const offset = clampInt(q.get("offset"), { min: 0, max: PLACE_OFFSET_MAX, fallback: 0 }) ?? 0;
  const page = engine.placePage(id, { limit, offset });
  if (!page) return notFound();
  return json(
    { place: page.place, titles: decorate(page.titles), total: page.total, episodes: page.episodes },
    // The index only changes at a rebuild, so this is as cacheable as a browse page.
    { cache: perSession(300) },
  );
}
