/**
 * Keywords for a SERIES, which is the half `servarr-metadata` cannot reach.
 *
 * `api.radarr.video` already returns keywords for a film, free and keyless, so this covers
 * only the TV side -- see the `keywords` provider in `../tmdb.ts` for why answering for a
 * film as well would print every chip twice rather than improving anything.
 *
 * TMDB spells the list differently on the two endpoints (`keywords` for a movie, `results`
 * for a show). Only the show form is read here; the day this needs films too, that is the
 * field to add, not a second module.
 */

import type { Keyword } from "../../lib/facets";

interface TmdbKeyword {
  id?: number | null;
  name?: string | null;
}

/**
 * The block as it arrives, which is now only ever nested under a `keywords` key from
 * `append_to_response` -- the dedicated `/tv/{id}/keywords` endpoint is no longer called,
 * because asking for it alongside the detail costs no extra round trip. See `./document`.
 */
export interface TmdbTvKeywordResponse {
  results?: TmdbKeyword[] | null;
}

/**
 * A show's keywords, or `null` when TMDB has no record of it.
 *
 * A show TMDB knows and nobody has tagged comes back as an empty array, which is a real
 * answer and caches as an empty facet.
 */
export function parseSeriesKeywords(res: TmdbTvKeywordResponse | null | undefined): Keyword[] | null {
  if (!res) return null;
  return (res.results ?? []).flatMap(toKeyword);
}

/**
 * Core's `Keyword` carries a STRING id, and a keyword with no name is not a keyword.
 *
 * The id is namespaced with the source, because the chip list is a merged facet: TMDB's
 * `818` and some later provider's `818` are different tags, and an unqualified number
 * would collide as a React key.
 */
function toKeyword(raw: TmdbKeyword): Keyword[] {
  const name = raw.name?.trim();
  if (!name) return [];
  return [{ id: raw.id === null || raw.id === undefined ? "" : `tmdb:${raw.id}`, name }];
}
