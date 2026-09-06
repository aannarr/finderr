/**
 * TMDB: streaming availability, and the five facts a series cannot get anywhere else.
 *
 * The only plugin in the tree that needs an API key, and therefore the worked example for
 * per-addon configuration: it declares what it needs in `meta.config` and reads the values
 * back through `c.config`, reaching into neither `process.env` nor core's own `loadConfig()`.
 * An addon written outside this repo can do exactly what this one does.
 *
 * The one thing it does that a third-party addon would not: two of its three fields are
 * declared by `src/lib/tmdb-settings.ts` and spread in, because core reads the same key and
 * the same image base. See that file for why there is only one declaration of them.
 *
 * It goes dark without a key -- `init` declares no facets when `apiKey` is unset, so a
 * checkout with no key loads a finderr that simply knows six fewer facts. Nothing else
 * changes, and that stays true however the key is configured.
 *
 * Six facets, chosen because nothing keyless can serve them:
 *
 *   - `watchProviders` is JustWatch's catalogue relayed by TMDB. No Servarr proxy carries
 *     availability and neither does the IMDb corpus, so this facet had no provider at all
 *     until now and resolved empty on every title.
 *   - `keywords` for a SERIES. `api.radarr.video` already returns them for a film.
 *   - `cast` for a SERIES, with person ids. Skyhook's actors carry no id in any space, so
 *     this is the only route to a clickable series cast -- see `./tmdb/cast`.
 *   - `trailer`, `related` and `links` for a SERIES. Radarr's lookup hands a film all three
 *     for free; skyhook answers a series with an empty trailer list and carries neither of
 *     the other two, so these resolved empty on every show -- see `./tmdb/videos`,
 *     `./tmdb/recommendations` and `./tmdb/links`.
 *
 * THE KEY IS A SECRET AND TMDB TAKES IT AS A QUERY PARAMETER. It is never logged, never
 * put in an error and never written into a fixture; `src/lib/tmdb-api.ts` is the only module
 * that holds it and `getJson` redacts the query string from anything it reports. Declaring
 * it `type: "secret"` adds the two guarantees an addon author cannot make for themselves:
 * the admin API never reads it back, and anything a log line would print it in is redacted.
 */

import { AsyncCache } from "../lib/async-cache";
import type { FacetEntity, FreshnessClass } from "../lib/facets";
import type { FacetProvider, PluginContext, PluginExports, PluginKv, PluginMeta } from "../lib/plugins";
import { TMDB_HOST, TmdbApi, type TmdbMediaType } from "../lib/tmdb-api";
import { TMDB_ADDON_ID, TMDB_DEFAULT_IMAGE_BASE, TMDB_SHARED_CONFIG } from "../lib/tmdb-settings";
import { fetchDocument, type TmdbDocument } from "./tmdb/document";

/**
 * What an operator configures, declared rather than read out of `process.env`.
 *
 * Each field keeps the `FINDERR_TMDB_*` variable it already had as its `env` SEED, so an
 * existing deployment behaves identically until somebody saves a value -- see
 * `src/lib/addon-config.ts` for the rule.
 *
 * THE FIRST TWO FIELDS ARE CORE'S, spread in from `src/lib/tmdb-settings.ts` rather than
 * restated. The key and the image base are read by the upcoming-and-trending sync and by the
 * poster proxy as well as by this addon, and one declaration is what makes an override on
 * the admin page move all of them at once. `watchProviderRegions` is this addon's alone and
 * is declared here, which is what an addon written outside this repo does with every field.
 */
export const meta = {
  id: TMDB_ADDON_ID,
  entities: ["movie", "series"],
  hosts: [TMDB_HOST],
  config: [
    ...TMDB_SHARED_CONFIG,
    /*
      DELIBERATELY NOT core's `regions`, and that is the whole reason this setting exists.
      `regions` answers a different question -- "which countries is this instance FOR", for
      the upcoming sync -- and DEFAULTS TO ["US"], so reusing it would trim every existing
      deployment to US-only availability without anybody asking, and a reader outside those
      countries would silently lose the "Where to watch" pane entirely (`pickWatchProviders`
      has no fallback to "whatever country we do have"). Unset means today's behaviour
      exactly, which is what makes it safe to ship to a running instance.
    */
    {
      key: "watchProviderRegions",
      type: "string",
      label: "Watch provider countries",
      description:
        "Comma-separated ISO 3166-1 alpha-2 codes. Empty keeps every country, which is ~25 KB a title.",
      env: "FINDERR_TMDB_WATCH_PROVIDER_REGIONS",
    },
  ],
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
  // Claimed, not effective: `cast` is declared `immutable` in the vocabulary, so core
  // overrides whatever is said here. It is stated anyway so the row is not silently
  // relying on the default, and so the claim is right if that declaration ever changes.
  cast: "settled",
  // The three series-only facets, all `settled`, and each for its own reason rather than
  // by copying the row above it.
  //
  // `trailer` is a fact about a finished production: a show gets its trailer once and the
  // set does not churn afterwards.
  //
  // `links` is an ADDRESS, which is exactly why it is not `immutable` -- a network's show
  // page gets rebuilt or taken down -- but 90 days on a settled show is the right rung and
  // the age ladder gives a running one far less on its own.
  //
  // `related` is the one worth arguing about, because TMDB's recommendation set genuinely
  // moves. It is still `settled`, for two reasons: `servarr-metadata` claims the same class
  // for the same facet on a film, so the same fact expires by the same rule whoever answered
  // it; and a shorter class would re-buy the whole appended document -- cast, keywords,
  // availability and all -- on a schedule nobody needs a "more like this" row to keep.
  trailer: "settled",
  related: "settled",
  links: "settled",
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
  const apiKey = c.config.string("apiKey");
  const imageBase = c.config.string("imageBase") ?? TMDB_DEFAULT_IMAGE_BASE;
  const watchProviderRegions = regionList(c.config.string("watchProviderRegions"));
  if (!apiKey) {
    c.log(
      "no TMDB API key configured -- watchProviders, and a series' keywords, cast, trailer, " +
        "related and links, stay unanswered",
    );
    return { facets: {} };
  }

  // Both scoped to this load rather than to the module, so two registries in one process
  // (which is what the tests are) never see each other's in-flight calls.
  const ids = tmdbIdCache(c.kv);
  const documents = new AsyncCache<string, TmdbDocument>();
  // One API per load, closed over by both handlers: `c.fetch` is fixed at init now that a
  // handler is handed the entity alone, so there is nothing left to rebuild per call.
  const api = new TmdbApi(c.fetch, apiKey);

  /** The id, then the one document. Both halves coalesce across a title's burst. */
  async function documentFor(entity: FacetEntity): Promise<TmdbDocument | null> {
    const tmdbId = await resolveTmdbId(api, ids, entity);
    if (tmdbId === null) return null;
    return documents.getOrAdd(entity.tconst, () =>
      fetchDocument(api, entity, tmdbId, { imageBase, regions: watchProviderRegions }),
    );
  }

  /**
   * A facet cut from the series document, answered for a SERIES and nobody else.
   *
   * Every one of these already arrives for a film from `api.radarr.video`, keyless -- a
   * film's chips, its credits with TMDB person ids already on them, its YouTube trailer id,
   * its recommendations and its `Homepage`. Contributing a second copy would cost a call
   * and put every chip, actor, trailer link and site link on the page twice, because all
   * five merge as lists and nothing downstream can tell one source's entry from another's.
   * So the answer for a film is "nothing here", decided on KIND before any id is resolved
   * and therefore costing no call either.
   */
  function seriesFacet<F extends SeriesOnlyFacet>(facet: F): FacetProvider<F> {
    return async (entity) => {
      if (entity.kind !== "series") return null;
      const data = (await documentFor(entity))?.[facet] ?? null;
      return data === null ? null : { data, freshness: FRESHNESS[facet] };
    };
  }

  return {
    facets: {
      watchProviders: async (entity) => {
        const data = (await documentFor(entity))?.watchProviders ?? null;
        return data === null ? null : { data, freshness: FRESHNESS.watchProviders };
      },

      keywords: seriesFacet("keywords"),
      cast: seriesFacet("cast"),
      trailer: seriesFacet("trailer"),
      related: seriesFacet("related"),
      links: seriesFacet("links"),
    },
  };
}

/**
 * The facets this plugin answers for a series and declines for a film.
 *
 * Derived from `FRESHNESS` rather than typed out again, so adding a row above is the only
 * edit an author has to remember: `watchProviders` is the one facet asked for both kinds,
 * and everything else in the table is by definition series-only.
 */
type SeriesOnlyFacet = Exclude<keyof typeof FRESHNESS, "watchProviders">;

/**
 * The countries setting as `parseWatchProviders` wants it: a list, upper-cased.
 *
 * A config field is a SCALAR, the same trade site settings make -- every one of them has to
 * render as one control -- so the comma-splitting `loadConfig` used to do lives here now.
 * Upper-cased because the codes are matched against TMDB's own ISO 3166-1 alpha-2 keys,
 * which are upper case, and `th` would silently match nothing.
 */
function regionList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const codes = raw
    .split(",")
    .map((code) => code.trim().toUpperCase())
    .filter(Boolean);
  // Undefined and empty mean the same thing to `parseWatchProviders` -- keep every country --
  // and one spelling of that is one fewer thing for a reader of this file to check.
  return codes.length > 0 ? codes : undefined;
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
 * The id, from the cheapest place that has it.
 *
 * THREE SOURCES, IN COST ORDER, and the first is new. `entity.ids` is core telling a
 * provider what it already knows -- the field was declared for exactly this and stood
 * empty until the index grew a bulk crosswalk -- so for most titles this costs one local
 * SQLite lookup the server has already done and no call at all. `c.kv` is what an earlier
 * view of this title bought. `/find` is the fallback, unchanged, and still the only path
 * for a title Wikidata has never heard of.
 *
 * `servarr-metadata` also resolves this id into the `externalIds` facet, and reading it
 * from THERE would still cost nothing -- but a provider is handed `fetch`, `kv` and `log`,
 * and cannot read another plugin's facet. `entity.ids` is not that seam being crossed: it
 * is core's own answer, handed to every provider on equal terms.
 */
function resolveTmdbId(
  api: TmdbApi,
  ids: AsyncCache<string, number | null>,
  entity: FacetEntity,
): Promise<number | null> {
  const known = entity.ids.tmdb;
  if (typeof known === "number") return Promise.resolve(known);
  return ids.getOrAdd(entity.tconst, (tconst) => api.findByImdbId(tconst, mediaTypeOf(entity)));
}
