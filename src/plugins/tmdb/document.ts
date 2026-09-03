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
 * anything for a film -- the other five all answer `null` on kind before resolving an id,
 * because `api.radarr.video` already serves every one of them for a film, keylessly and with
 * TMDB person ids already on the credits. So a film is one call either way, and the dedicated
 * `/movie/{id}/watch/providers` endpoint returns the offers alone where the appended form
 * would drag the whole movie document along with it. Fewer calls is the goal; a bigger
 * single call is not an improvement.
 */

import type { FacetEntity, FacetShapes } from "../../lib/facets";
import type { TmdbApi } from "../../lib/tmdb-api";
import { parseSeriesCast, type TmdbAggregateCreditsResponse } from "./cast";
import { parseSeriesKeywords, type TmdbTvKeywordResponse } from "./keywords";
import { parseHomepageLink } from "./links";
import { parseSeriesRelated, type TmdbRecommendationsResponse } from "./recommendations";
import { parseSeriesTrailers, type TmdbVideosResponse } from "./videos";
import { fetchWatchProviders, parseWatchProviders, type TmdbWatchProviderResponse } from "./watch-providers";

/** The facets this plugin cuts out of one document. */
export type TmdbDocumentFacet = "watchProviders" | "keywords" | "cast" | "trailer" | "related" | "links";

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
 * The series detail response: the appended blocks, plus the one field read off the document
 * itself.
 *
 * `watch/providers` keeps its slash: TMDB echoes the sub-request's own path as the key, so
 * the property name is not a typo and cannot be tidied into `watchProviders`.
 *
 * `homepage` is not appended and could not be -- it is a plain field on `/tv/{id}`, which
 * this already buys for the appends. That is the whole cost of the `links` facet.
 */
interface TmdbSeriesDocument {
  homepage?: string | null;
  keywords?: TmdbTvKeywordResponse | null;
  aggregate_credits?: TmdbAggregateCreditsResponse | null;
  "watch/providers"?: TmdbWatchProviderResponse | null;
  videos?: TmdbVideosResponse | null;
  recommendations?: TmdbRecommendationsResponse | null;
}

/**
 * What a series document is asked to bring back, as one string.
 *
 * `aggregate_credits` is the SERIES form of credits and joins the others for free: a
 * sub-request costs no round trip, and the round trips are the cost. Exported so the test
 * that pins "a cold series is one call" names the same list this file sends.
 *
 * Adding `videos` and `recommendations` did not add a call, which is why three more facets
 * were worth serving here rather than through their dedicated endpoints -- and `links` is
 * cheaper still, being a field on the document rather than a sub-request at all.
 */
export const SERIES_APPEND = "keywords,watch/providers,aggregate_credits,videos,recommendations";

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
    trailer: parseSeriesTrailers(doc?.videos),
    related: parseSeriesRelated(doc?.recommendations),
    // `links` reads a FIELD rather than a block, so "TMDB has no such show" has to be said
    // here: an absent `homepage` on a document we did get is a real "no site", and the two
    // are the same `undefined` once the field is read off a null document.
    links: doc ? parseHomepageLink(doc.homepage) : null,
  };
}

async function movieDocument(api: TmdbApi, tmdbId: number, opts: TmdbDocumentOptions): Promise<TmdbDocument> {
  // Only `watchProviders` is read for a film -- see the note at the top of this file.
  return {
    watchProviders: await fetchWatchProviders(api, "movie", tmdbId, opts.regions),
    keywords: null,
    cast: null,
    trailer: null,
    related: null,
    links: null,
  };
}
