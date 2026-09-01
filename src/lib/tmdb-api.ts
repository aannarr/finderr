/**
 * `api.themoviedb.org` -- how this plugin asks, and how it keeps the key out of a log.
 *
 * TMDB v3 takes its credential as a QUERY PARAMETER, which is the whole reason this file
 * exists rather than a bare `getJson` call at each site. A URL built here carries a live
 * secret, so nothing may put one in an error, a log line or a test fixture; `getJson` in
 * `src/lib/plugin-fetch.ts` strips the query from anything it reports, and `TmdbApi` never
 * hands a built URL back to a caller.
 *
 * It lived at `src/plugins/tmdb/api.ts` until the upcoming sync became a second caller.
 * Core must not import out of `src/plugins/`, and two copies of the key-handling above is
 * exactly the duplication that rots, so it moved down here and the plugin imports it.
 */

import { getJson, type PluginFetch } from "./plugin-fetch";

export const TMDB_HOST = "api.themoviedb.org";

/** Every path this plugin uses hangs off the v3 tree. */
const BASE = `https://${TMDB_HOST}/3`;

/** TMDB's own name for the two kinds of thing it holds. Ours are `movie` and `series`. */
export type TmdbMediaType = "movie" | "tv";

/**
 * The `/find` answer, narrowed to the two id lists we read.
 *
 * It also returns person, episode and season matches; an IMDb title id can only ever land
 * in one of these two, so the rest are noise.
 */
interface TmdbFindResult {
  movie_results?: { id: number }[] | null;
  tv_results?: { id: number }[] | null;
}

/**
 * One TMDB account's view of the API, with the key applied and never exposed.
 *
 * The key is passed in rather than read from config here, so every part of this plugin
 * below the top-level file is testable with a fake and the composition root stays the one
 * place that knows where a credential comes from.
 */
export class TmdbApi {
  constructor(
    private readonly fetch: PluginFetch,
    private readonly apiKey: string,
  ) {}

  /**
   * GET a v3 path, or `null` when TMDB says it has nothing.
   *
   * `query` is for the endpoint's own parameters; the key is added here so no caller can
   * forget it and no caller has to hold it.
   */
  get<T>(path: string, query: Record<string, string> = {}): Promise<T | null> {
    const url = new URL(`${BASE}${path}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    url.searchParams.set("api_key", this.apiKey);
    return getJson<T>(this.fetch, url.href);
  }

  /**
   * TMDB's id for an IMDb `tt...`, or null if it does not know the title.
   *
   * An EXACT crosswalk rather than a title search: `/find` is keyed on the external id, so
   * there is no matching to get wrong and no need for the scored fuzzy matcher
   * `rotten-tomatoes` carries. The cost is one call per title ever -- see `resolveTmdbId`,
   * which parks the answer in `c.kv`.
   */
  async findByImdbId(tconst: string, media: TmdbMediaType): Promise<number | null> {
    const found = await this.get<TmdbFindResult>(`/find/${tconst}`, { external_source: "imdb_id" });
    const results = media === "tv" ? found?.tv_results : found?.movie_results;
    return results?.[0]?.id ?? null;
  }

  /**
   * The IMDb id for a TMDB id -- `findByImdbId` run backwards.
   *
   * The upcoming sync needs this direction: `/discover` answers in TMDB ids and every
   * other table in this product is keyed on a `tconst`. Null is a real and common answer
   * rather than an error -- measured 2026-08-31, four of twenty upcoming series and two
   * of forty-one upcoming films have no IMDb id at TMDB at all, mostly Chinese and Korean
   * titles. Those are dropped rather than guessed at.
   */
  async imdbIdOf(tmdbId: number, media: TmdbMediaType): Promise<string | null> {
    const ids = await this.get<{ imdb_id?: string | null }>(`/${media}/${tmdbId}/external_ids`);
    const imdb = ids?.imdb_id?.trim();
    return imdb?.startsWith("tt") ? imdb : null;
  }

  /**
   * One page of what has not come out yet in one region, most popular first.
   *
   * POPULARITY IS THE ONLY USABLE RANKING HERE, and that is the reason this call exists
   * rather than a query over our own index: the IMDb dumps carry `numVotes`, and an
   * unreleased title has none. Measured 2026-08-31, every indexed title dated 2027 or
   * later had exactly zero votes, so ordering our own corpus by votes is arbitrary for
   * precisely the titles this shelf is about.
   *
   * Asking TMDB for date-ascending instead is not the shortcut it looks like: it returns
   * whatever obscure thing is released tomorrow. Popularity chooses WHICH titles to
   * fetch; the shelf then shows them soonest-first. The two orderings do different jobs.
   */
  discoverUpcoming(
    media: TmdbMediaType,
    opts: { region: string; after: string; page?: number },
  ): Promise<TmdbDiscoverPage | null> {
    // The date field is named for the media type; there is no shared alias.
    const gte = media === "tv" ? "first_air_date.gte" : "primary_release_date.gte";
    return this.get<TmdbDiscoverPage>(`/discover/${media}`, {
      [gte]: opts.after,
      sort_by: "popularity.desc",
      region: opts.region,
      page: String(opts.page ?? 1),
    });
  }

  /**
   * What people are actually watching this week, films and series in one ranked list.
   *
   * `all` rather than two calls, because TMDB ranks both against ONE popularity score and
   * splitting it would mean interleaving two lists by a number we would then have to keep.
   * It is one call for twenty titles and it carries `media_type` per result, which is what
   * lets a mixed list be un-mixed where a kind is actually needed.
   *
   * WEEK, NOT DAY, and that is a cost decision rather than a taste one. A shelf is not
   * published until its titles are warm, so trending CHURN sets the warm cost of every
   * refresh; the daily list turns over far faster than the weekly one for a question
   * nobody asks hourly. `time_window` is a path segment, not a parameter.
   *
   * THE POSITION IS THE ANSWER AND IT IS NOT DERIVABLE HERE. Our own corpus carries
   * `numVotes`, which measures all-time notability -- Shawshank is not what is popular
   * this week -- so there is no local query that approximates this and that is the whole
   * reason the call exists.
   */
  trending(window: "day" | "week" = "week"): Promise<TmdbTrendingPage | null> {
    return this.get<TmdbTrendingPage>(`/trending/all/${window}`);
  }
}

/** `/discover` narrowed to the fields the upcoming sync reads. */
export interface TmdbDiscoverPage {
  results?: TmdbDiscoverResult[] | null;
}

export interface TmdbDiscoverResult {
  id: number;
  /** Films carry `title`/`release_date`, series carry `name`/`first_air_date`. */
  title?: string | null;
  name?: string | null;
  release_date?: string | null;
  first_air_date?: string | null;
}

/** `/trending/all` narrowed to what the trending sync reads. Order IS the ranking. */
export interface TmdbTrendingPage {
  results?: TmdbTrendingResult[] | null;
}

export interface TmdbTrendingResult {
  id: number;
  /**
   * `movie` or `tv`. A mixed list is the point, so this is the only thing that says which
   * endpoint an id belongs to -- and the crosswalk needs it, because `/movie/{id}` and
   * `/tv/{id}` are different id spaces that happily collide.
   */
  media_type?: string | null;
}
