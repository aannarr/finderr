/**
 * `api.themoviedb.org` -- how this plugin asks, and how it keeps the key out of a log.
 *
 * TMDB v3 takes its credential as a QUERY PARAMETER, which is the whole reason this file
 * exists rather than a bare `getJson` call at each site. A URL built here carries a live
 * secret, so nothing may put one in an error, a log line or a test fixture; `getJson` in
 * `src/lib/plugin-fetch.ts` strips the query from anything it reports, and `TmdbApi` never
 * hands a built URL back to a caller.
 *
 * These files are NOT plugins. The loader globs `*.ts` in `src/plugins/` and `Bun.Glob`'s
 * `*` does not cross a `/`, so a module in this subdirectory is never load-attempted.
 */

import { getJson, type PluginFetch } from "../../lib/plugin-fetch";

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
}
