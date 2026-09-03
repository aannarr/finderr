/**
 * "More like this" for a SERIES -- the `related` facet's only provider on the TV side.
 *
 * `api.radarr.video` returns `Recommendations` for a film, so `servarr-metadata` already
 * answers this facet for a film; neither skyhook nor Sonarr's lookup carries anything of
 * the kind, so a series resolved it empty until this.
 *
 * THE TCONST IS LEFT NULL AND THE TMDB ID IS CARRIED, exactly as `relatedOf` in
 * `src/plugins/servarr/radarr.ts` does it. That is not a shortcut: `RelatedTitle.tmdbId`
 * exists for this, and the crosswalk is done once at RENDER time in `relatedRows`
 * (`src/server/index.ts`) against `externalIds` rows we already hold locally -- no upstream
 * call at all. Resolving each recommendation here instead would be one `/find` per entry on
 * a page nobody has clicked through from yet, which is the sweep the one-click-deep rule
 * forbids and the reason the film path does not do it either.
 */

import type { RelatedTitle } from "../../lib/facets";

/** One recommendation, narrowed to the two fields core's `RelatedTitle` can use. */
interface TmdbRecommendation {
  id?: number | null;
  name?: string | null;
}

/**
 * The block as it arrives, nested under a `recommendations` key from `append_to_response`.
 *
 * A paged envelope; only the first page is read, which is the twenty TMDB ranks highest.
 * The dedicated `/tv/{id}/recommendations` endpoint returns the same body and is never
 * called -- a sub-request on the detail document costs no round trip. See `./document`.
 */
export interface TmdbRecommendationsResponse {
  results?: TmdbRecommendation[] | null;
}

/**
 * What TMDB says this show is like, or `null` when it has no record of the show.
 *
 * A show TMDB knows and has nothing to recommend beside comes back as an empty array, which
 * is a real answer and caches as an empty facet.
 */
export function parseSeriesRelated(
  res: TmdbRecommendationsResponse | null | undefined,
): RelatedTitle[] | null {
  if (!res) return null;
  return (res.results ?? []).flatMap(toRelated);
}

/**
 * A recommendation core can hold, or nothing when there is no way to reach the title.
 *
 * An entry with no TMDB id can never be crosswalked to a `tconst` and would render as a
 * card with nowhere to go, so it is dropped rather than kept as an unlinkable title string
 * -- which is the dead end `RelatedTitle.tmdbId` was added to end.
 */
function toRelated(raw: TmdbRecommendation): RelatedTitle[] {
  const title = raw.name?.trim();
  if (!title || typeof raw.id !== "number") return [];
  // `reason` is the word `radarr.ts` uses for the same fact from the same upstream idea of
  // it, so the two providers' contributions read alike where they merge into one list.
  return [{ tconst: null, title, reason: "recommended", tmdbId: raw.id }];
}
