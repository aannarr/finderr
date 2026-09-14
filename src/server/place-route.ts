/**
 * `/api/place/:id` -- one filming location and a page of the titles filmed there.
 *
 * Its own module so the parts a caller can get wrong are tested as a caller drives them: an
 * id that is not a Q id, a place we hold nothing for, a `limit` past its bound, a negative
 * offset. `index.ts` hands over the live engine and its `decorate`, so nothing here stands up
 * a store or an index.
 *
 * Local SQLite only: `place` and `title_place` are built into the index from Wikidata, so this
 * asks nothing of anybody. A place we hold no title for, a malformed id and an index built
 * before the stage are all the same 404 -- there is no page here, and the last one fixes itself
 * at the next rebuild.
 *
 * `limit` and `offset` are REFUSED past their bounds with a 400 naming the limit, never clamped
 * -- the fifth rule, and `LIMITS` owns both numbers. A page that silently served 200 rows to a
 * caller who asked for a million would be an answer to a question nobody asked.
 */

import { type Place, type PlaceParts, parsePlaceId } from "../lib/filming-locations";
import { boundedInt, LIMITS, refusalMessage } from "../lib/input-guards";
import type { TitleRow } from "../lib/search";
import { perSession } from "./cache-policy";
import { json } from "./json-response";

/** The page size the browser asks for, and what a request with no `limit` gets. */
export const PLACE_PAGE_DEFAULT = 60;

/** The one engine method this route reads. `SearchEngine` satisfies it. */
export interface PlacePageSource {
  placePage(
    id: number,
    opts: { limit: number; offset: number },
  ): { place: Place; titles: TitleRow[]; total: number; parts: Record<string, PlaceParts> } | null;
}

const notFound = () => json({ error: "unknown place" }, { status: 404 });
const refused = (error: string) => json({ error }, { status: 400 });

export function placeResponse(
  engine: PlacePageSource,
  decorate: (rows: TitleRow[]) => unknown[],
  rawId: string,
  url: URL,
): Response {
  const id = parsePlaceId(rawId);
  if (id === null) return notFound();
  const q = url.searchParams;
  const limit = boundedInt(q.get("limit"), { min: 1, max: LIMITS.pageSize });
  if (!limit.ok) return refused(refusalMessage("limit", limit));
  const offset = boundedInt(q.get("offset"), { min: 0, max: LIMITS.pageOffset });
  if (!offset.ok) return refused(refusalMessage("offset", offset));
  const page = engine.placePage(id, { limit: limit.value ?? PLACE_PAGE_DEFAULT, offset: offset.value ?? 0 });
  if (!page) return notFound();
  return json(
    { place: page.place, titles: decorate(page.titles), total: page.total, parts: page.parts },
    // The index only changes at a rebuild, so this is as cacheable as a browse page.
    { cache: perSession(300) },
  );
}
