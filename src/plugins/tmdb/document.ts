/**
 * One TMDB call per title, whatever this plugin's two facets ask for.
 *
 * THE ROUND TRIPS ARE THE COST, not any one endpoint. Measured 2026-09-01 against a cold
 * data directory: every TMDB call runs 270-450 ms, and a cold SERIES used to make three of
 * them in a row -- `/find`, `/tv/{id}/keywords`, `/tv/{id}/watch/providers` -- with
 * `HostPacer`'s 250 ms floor between each, because they are all one host. The id now comes
 * from the index crosswalk and the other two collapse into one `append_to_response`, so a
 * series costs ONE call where it cost three.
 *
 * **A FILM DELIBERATELY DOES NOT USE `append_to_response`.** Only `watchProviders` asks
 * anything for a film -- the `keywords` provider answers `null` on kind before resolving
 * an id, because `api.radarr.video` already serves a film's keywords keylessly. So a film
 * is one call either way, and the dedicated `/movie/{id}/watch/providers` endpoint returns
 * the offers alone where the appended form would drag the whole movie document along with
 * it. Fewer calls is the goal; a bigger single call is not an improvement.
 */

import type { FacetEntity, Keyword, WatchProviders } from "../../lib/facets";
import type { TmdbApi } from "../../lib/tmdb-api";
import { parseSeriesKeywords, type TmdbTvKeywordResponse } from "./keywords";
import { fetchWatchProviders, parseWatchProviders, type TmdbWatchProviderResponse } from "./watch-providers";

/** What both providers read, whichever shape the call came back in. */
export interface TmdbDocument {
  watchProviders: WatchProviders[] | null;
  keywords: Keyword[] | null;
}

/**
 * The series detail response, narrowed to the two appended blocks.
 *
 * `watch/providers` keeps its slash: TMDB echoes the sub-request's own path as the key, so
 * the property name is not a typo and cannot be tidied into `watchProviders`.
 */
interface TmdbSeriesDocument {
  keywords?: TmdbTvKeywordResponse | null;
  "watch/providers"?: TmdbWatchProviderResponse | null;
}

/** A film and a series ask different questions; this is where that split lives. */
export function fetchDocument(api: TmdbApi, entity: FacetEntity, tmdbId: number): Promise<TmdbDocument> {
  return entity.kind === "series" ? seriesDocument(api, tmdbId) : movieDocument(api, tmdbId);
}

async function seriesDocument(api: TmdbApi, tmdbId: number): Promise<TmdbDocument> {
  const doc = await api.get<TmdbSeriesDocument>(`/tv/${tmdbId}`, {
    append_to_response: "keywords,watch/providers",
  });
  // A null document is "TMDB does not have this show", which both facets report as nothing
  // and the resolver caches as empty. An appended block that is absent is the same answer
  // for that one facet, which is what passing `undefined` through the parsers gives.
  return {
    watchProviders: parseWatchProviders(doc?.["watch/providers"]),
    keywords: parseSeriesKeywords(doc?.keywords),
  };
}

async function movieDocument(api: TmdbApi, tmdbId: number): Promise<TmdbDocument> {
  // `keywords` is never read for a film -- see the note at the top of this file.
  return { watchProviders: await fetchWatchProviders(api, "movie", tmdbId), keywords: null };
}
