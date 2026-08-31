/**
 * TMDB: streaming availability, and the keywords a series cannot get anywhere else.
 *
 * The only plugin in the tree that needs an API key, and the only one that goes dark
 * without one -- `init` registers nothing when `tmdb.apiKey` is unset, so a checkout with
 * no key loads a finderr that simply knows two fewer facts. Nothing else changes.
 *
 * Two facets, chosen because nothing keyless can serve them:
 *
 *   - `watchProviders` is JustWatch's catalogue relayed by TMDB. No Servarr proxy carries
 *     availability and neither does the IMDb corpus, so this facet had no provider at all
 *     until now and resolved empty on every title.
 *   - `keywords` for a SERIES. `api.radarr.video` already returns them for a film.
 *
 * THE KEY IS A SECRET AND TMDB TAKES IT AS A QUERY PARAMETER. It is never logged, never
 * put in an error and never written into a fixture; `./tmdb/api.ts` is the only module
 * that holds it and `getJson` redacts the query string from anything it reports.
 */

import { AsyncCache } from "../lib/async-cache";
import { loadConfig } from "../lib/config";
import type { FacetEntity, FreshnessClass } from "../lib/facets";
import type { PluginContext, PluginExports, PluginKv, PluginMeta } from "../lib/plugins";
import { TMDB_HOST, TmdbApi, type TmdbMediaType } from "./tmdb/api";
import { fetchSeriesKeywords } from "./tmdb/keywords";
import { fetchWatchProviders } from "./tmdb/watch-providers";

export const meta = {
  id: "tmdb",
  entities: ["movie", "series"],
  hosts: [TMDB_HOST],
} as const satisfies PluginMeta;

/**
 * How settled each fact is -- a class, never a duration. Core owns the ladder.
 *
 * `watchProviders` is `volatile`, the one class that ignores the title's age: a 1994 film
 * leaves a streaming service on the same notice as a 2026 one, so the age ladder has
 * nothing useful to say about it. `keywords` is what `servarr-metadata` already claims for
 * the same facet, so a film's chips and a series' chips expire on the same rule.
 */
const FRESHNESS = {
  watchProviders: "volatile",
  keywords: "settled",
} as const satisfies Record<string, FreshnessClass>;

/**
 * GOING DARK IS AN EMPTY `facets` OBJECT, not an early return with nothing registered.
 *
 * Under the declarative surface the RETURNED KEYS are the declaration, so a keyless
 * checkout says so by declaring no facets -- the loader's "registered no providers" path
 * still logs it and the two facets resolve empty exactly as they did before this plugin
 * existed. There is no `meta.provides` to disagree with, which is the point of the shape.
 */
export function init(c: PluginContext): PluginExports {
  const apiKey = loadConfig().tmdb.apiKey;
  if (!apiKey) {
    c.log("no TMDB API key configured -- watchProviders and series keywords stay unanswered");
    return { facets: {} };
  }

  // Scoped to this load rather than to the module, so two registries in one process
  // (which is what the tests are) never see each other's in-flight calls.
  const ids = tmdbIdCache(c.kv);
  // One API per load, closed over by both handlers: `c.fetch` is fixed at init now that a
  // handler is handed the entity alone, so there is nothing left to rebuild per call.
  const api = new TmdbApi(c.fetch, apiKey);

  return {
    facets: {
      watchProviders: async (entity) => {
        const tmdbId = await resolveTmdbId(api, ids, entity);
        if (tmdbId === null) return null;
        const data = await fetchWatchProviders(api, mediaTypeOf(entity), tmdbId);
        return data === null ? null : { data, freshness: FRESHNESS.watchProviders };
      },

      keywords: async (entity) => {
        // A film's keywords already arrive from `servarr-metadata`, keyless. Contributing a
        // second copy would cost a call and render every chip twice -- `keywords` merges as a
        // list and nothing dedupes it -- so the answer for a film is "nothing here", decided
        // before any id is resolved so it costs no call either.
        if (entity.kind !== "series") return null;
        const tmdbId = await resolveTmdbId(api, ids, entity);
        if (tmdbId === null) return null;
        const data = await fetchSeriesKeywords(api, tmdbId);
        return data === null ? null : { data, freshness: FRESHNESS.keywords };
      },
    },
  };
}

/** Core's entity kinds, in TMDB's vocabulary. `episode` never reaches here -- see `meta`. */
function mediaTypeOf(entity: FacetEntity): TmdbMediaType {
  return entity.kind === "series" ? "tv" : "movie";
}

/**
 * TMDB's id for a title, bought once and remembered forever.
 *
 * `tconst -> tmdbId` never changes, so it belongs in `c.kv` rather than in the facet cache:
 * a facet expiring must not buy the `/find` call again. Only successes are stored -- a
 * title TMDB has not indexed yet may well be there next month, and a permanently cached
 * "no" would keep it invisible, which is what `save` declining a `null` is for.
 *
 * The in-flight half coalesces the FIRST view, where both providers start in the resolver's
 * one synchronous burst and would otherwise each buy the same crosswalk. Every view after
 * that is answered by `load` without a call at all.
 *
 * `kv` holds strings, so the two conversions are the whole adapter: a stored id reads back
 * as a number, and an absent one as `undefined` rather than `null` -- `null` is a real
 * answer here and `AsyncCache` reserves `undefined` for "nothing stored".
 */
function tmdbIdCache(kv: PluginKv): AsyncCache<string, number | null> {
  const keyOf = (tconst: string) => `tmdb:${tconst}`;
  return new AsyncCache<string, number | null>({
    load: (tconst) => {
      const cached = kv.get(keyOf(tconst));
      return cached ? Number(cached) : undefined;
    },
    save: (tconst, id) => {
      if (id !== null) kv.set(keyOf(tconst), String(id));
    },
  });
}

/**
 * `servarr-metadata` already resolves this id into the `externalIds` facet, and reading it
 * from there would cost nothing -- but a provider is handed `fetch`, `kv` and `log`, and
 * cannot read another plugin's facet. Crossing that seam is a core change, not a plugin's.
 */
function resolveTmdbId(
  api: TmdbApi,
  ids: AsyncCache<string, number | null>,
  entity: FacetEntity,
): Promise<number | null> {
  return ids.getOrAdd(entity.tconst, (tconst) => api.findByImdbId(tconst, mediaTypeOf(entity)));
}
