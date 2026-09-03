/**
 * One TMDB call per title, whatever this plugin's facets ask for.
 *
 * THE ROUND TRIPS ARE THE COST, not any one endpoint. Measured 2026-09-01 against a cold
 * data directory: every TMDB call runs 270-450 ms, and a cold SERIES used to make three of
 * them in a row -- `/find`, `/tv/{id}/keywords`, `/tv/{id}/watch/providers` -- with
 * `HostPacer`'s 250 ms floor between each, because they are all one host. The id now comes
 * from the index crosswalk and the rest collapse into one `append_to_response`, so a series
 * costs ONE call however many facets it fills -- `aggregate_credits` joined for free.
 *
 * **A FILM DELIBERATELY DOES NOT USE `append_to_response`.** Only `watchProviders` asks
 * anything for a film -- `keywords` and `cast` both answer `null` on kind before resolving
 * an id, because `api.radarr.video` already serves both for a film, keylessly and with TMDB
 * person ids already on the credits. So a film is one call either way, and the dedicated
 * `/movie/{id}/watch/providers` endpoint returns the offers alone where the appended form
 * would drag the whole movie document along with it. Fewer calls is the goal; a bigger
 * single call is not an improvement.
 */

import type { FacetEntity, FacetShapes } from "../../lib/facets";
import type { TmdbApi } from "../../lib/tmdb-api";
import { parseSeriesCast, type TmdbAggregateCreditsResponse } from "./cast";
import { parseSeriesKeywords, type TmdbTvKeywordResponse } from "./keywords";
import { fetchWatchProviders, parseWatchProviders, type TmdbWatchProviderResponse } from "./watch-providers";

/** The facets this plugin cuts out of one document. */
export type TmdbDocumentFacet = "watchProviders" | "keywords" | "cast";

/**
 * What every provider reads, whichever shape the call came back in.
 *
 * Keyed by FACET NAME and typed from the vocabulary, so a provider can be written once
 * against `TmdbDocument[facet]` instead of once per facet -- and so a shape changing in
 * `src/lib/facets.ts` is a compile error in the parser rather than a second definition
 * here that quietly drifts. `null` is "we have nothing to say", per facet.
 */
export type TmdbDocument = { [F in TmdbDocumentFacet]: FacetShapes[F] | null };

/**
 * The series detail response, narrowed to the three appended blocks.
 *
 * `watch/providers` keeps its slash: TMDB echoes the sub-request's own path as the key, so
 * the property name is not a typo and cannot be tidied into `watchProviders`.
 */
interface TmdbSeriesDocument {
  keywords?: TmdbTvKeywordResponse | null;
  aggregate_credits?: TmdbAggregateCreditsResponse | null;
  "watch/providers"?: TmdbWatchProviderResponse | null;
}

/**
 * What a series document is asked to bring back, as one string.
 *
 * `aggregate_credits` is the SERIES form of credits and joins the other two for free: a
 * sub-request costs no round trip, and the round trips are the cost. Exported so the test
 * that pins "a cold series is one call" names the same list this file sends.
 */
export const SERIES_APPEND = "keywords,watch/providers,aggregate_credits";

/** The operator's settings a parser needs, gathered once at plugin init. */
export interface TmdbDocumentOptions {
  /** `tmdb.imageBase` -- where a headshot path becomes a URL. */
  imageBase: string;
  /**
   * The operator's `tmdb.watchProviderRegions`, undefined in the ordinary case. It narrows
   * what is KEPT rather than what is asked for -- TMDB returns every country whatever we
   * do, and the appended form has no per-country parameter at all, so this is a cache-size
   * lever and never a call-count one.
   */
  regions?: readonly string[];
}

/** A film and a series ask different questions; this is where that split lives. */
export function fetchDocument(
  api: TmdbApi,
  entity: FacetEntity,
  tmdbId: number,
  opts: TmdbDocumentOptions,
): Promise<TmdbDocument> {
  return entity.kind === "series" ? seriesDocument(api, tmdbId, opts) : movieDocument(api, tmdbId, opts);
}

async function seriesDocument(
  api: TmdbApi,
  tmdbId: number,
  opts: TmdbDocumentOptions,
): Promise<TmdbDocument> {
  const doc = await api.get<TmdbSeriesDocument>(`/tv/${tmdbId}`, {
    append_to_response: SERIES_APPEND,
  });
  // A null document is "TMDB does not have this show", which every facet reports as nothing
  // and the resolver caches as empty. An appended block that is absent is the same answer
  // for that one facet, which is what passing `undefined` through the parsers gives.
  return {
    watchProviders: parseWatchProviders(doc?.["watch/providers"], opts.regions),
    keywords: parseSeriesKeywords(doc?.keywords),
    cast: parseSeriesCast(doc?.aggregate_credits, opts.imageBase),
  };
}

async function movieDocument(api: TmdbApi, tmdbId: number, opts: TmdbDocumentOptions): Promise<TmdbDocument> {
  // Neither `keywords` nor `cast` is read for a film -- see the note at the top of this file.
  return {
    watchProviders: await fetchWatchProviders(api, "movie", tmdbId, opts.regions),
    keywords: null,
    cast: null,
  };
}
