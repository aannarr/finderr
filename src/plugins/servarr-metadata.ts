/**
 * Servarr metadata: cast, crew, seasons, episodes and ratings, with no API key anywhere.
 *
 * Radarr and Sonarr each host a public proxy for their own clients -- `api.radarr.video`
 * and `skyhook.sonarr.tv` -- and neither needs a key, an account or a registration. One
 * call to either returns almost everything a detail page wants, which is why this one
 * plugin is the default provider for thirteen facets while every other plugin adds a
 * detail to what it already said.
 *
 * ETIQUETTE, AND IT IS NOT OPTIONAL. This is somebody else's infrastructure, paid for by
 * them, intended for Radarr and Sonarr clients. We are a third party on it. Three things
 * keep it available and all three are enforced rather than remembered:
 *
 *   - ONE call per title, not one per facet. See `documentFacets` -- thirteen providers
 *     share a single fetch.
 *   - `cast`, `crew`, `collection` and `externalIds` are `immutable` and never re-fetched,
 *     so most of this payload is bought once in the product's lifetime.
 *   - An honest User-Agent, a timeout and per-host pacing come from `c.fetch`, which is
 *     the only way out of a plugin.
 *
 * Never batch-crawl them. Resolve on view and on shelf pre-warm, one click deep.
 */

import type { FacetEntity, FacetShapes, FreshnessClass } from "../lib/facets";
import type { FacetProvider, PluginContext, PluginExports, PluginMeta } from "../lib/plugins";
import {
  collectionWithParts,
  fetchCollection,
  fetchMovie,
  movieFacets,
  RADARR_HOST,
  type RadarrCollection,
} from "./servarr/radarr";
import { fetchShow, resolveTvdbId, SKYHOOK_HOST, seriesFacets } from "./servarr/skyhook";

export const meta = {
  id: "servarr-metadata",
  entities: ["movie", "series"],
  hosts: [RADARR_HOST, SKYHOOK_HOST],
} as const satisfies PluginMeta;

/**
 * How settled each kind of fact is, and -- since the surface became declarative -- also
 * the list of what this plugin provides. A class, never a duration; core owns the ladder.
 *
 * These thirteen are cut from ONE upstream document and differ only in how long they keep,
 * so a table plus a loop says that better than thirteen near-identical object entries
 * would. The keys of what `init` returns are still the declaration; they are just computed
 * from here rather than typed out twice.
 *
 * The `immutable` four are also declared immutable in the facet vocabulary and would be
 * cached forever regardless; saying so here as well is the plugin agreeing rather than
 * relying on it. `ratings` moves because vote counts do, and `seasons`/`episodes` because
 * a running show gains an episode every week.
 */
const FRESHNESS = {
  synopsis: "settled",
  ratings: "moving",
  cast: "immutable",
  crew: "immutable",
  certification: "settled",
  trailer: "settled",
  releaseDates: "recent",
  keywords: "settled",
  collection: "immutable",
  related: "settled",
  seasons: "recent",
  episodes: "recent",
  externalIds: "immutable",
  // Not `immutable` beside `externalIds`, though the two arrive together: an id cannot
  // change and an address can. A film's site is a studio campaign page that gets rebuilt or
  // taken down, so this rides the age ladder like everything else.
  links: "settled",
} as const satisfies Record<string, FreshnessClass>;

type ProvidedFacet = keyof typeof FRESHNESS;

export function init(c: PluginContext): PluginExports {
  // One shared document per title, scoped to this load rather than to the module, so two
  // registries in one process (which is what the tests are) never see each other's calls.
  const inFlight = new Map<string, Promise<Partial<FacetShapes>>>();

  // Built through a loose record because the key is only known at runtime -- the same
  // shape `FacetResolver.read` uses, and for the same reason. The mapped type is what the
  // LOADER sees, which is where the per-facet typing earns its keep.
  const facets: Record<string, FacetProvider> = {};

  for (const facet of Object.keys(FRESHNESS) as ProvidedFacet[]) {
    facets[facet] = async (entity) => {
      const document = await documentFacets(inFlight, c, entity);
      const data = document[facet];
      // Absent means the upstream document had nothing of that kind, which is a real
      // answer and caches as an empty facet. It is not the same as a failure: a fetch
      // that goes wrong throws out of here and is recorded as one.
      return data === undefined ? null : { data, freshness: FRESHNESS[facet] };
    };
  }

  return { facets: facets as PluginExports["facets"] };
}

/**
 * The upstream document for one title, fetched at most once however many facets ask.
 *
 * Thirteen providers are registered and the resolver starts all of them for a title in
 * the same synchronous burst, so without this each view would buy thirteen copies of a
 * 71 KB payload from somebody else's free proxy. The entry is dropped as soon as the call
 * settles: this coalesces one burst, and the facet cache -- not a second cache here --
 * is what stops the next view asking at all.
 *
 * The same shape as `ImageCache` and `ArtworkResolver`, deliberately: an in-flight map
 * keyed by the thing being fetched, cleared in `finally`.
 */
function documentFacets(
  inFlight: Map<string, Promise<Partial<FacetShapes>>>,
  ctx: PluginContext,
  entity: FacetEntity,
): Promise<Partial<FacetShapes>> {
  const existing = inFlight.get(entity.tconst);
  if (existing) return existing;

  const task = fetchDocument(ctx, entity).finally(() => inFlight.delete(entity.tconst));
  inFlight.set(entity.tconst, task);
  return task;
}

/**
 * Ask the endpoint that knows about this kind of title.
 *
 * An empty object means the title is genuinely not in their database. A transport failure
 * throws instead, and the difference matters: the resolver caches an empty answer for
 * weeks and a failure for ten minutes, so a 502 during a deploy must never look like
 * "this film has no cast".
 *
 * `episode` entities never reach here -- the plugin declares `movie` and `series`, and
 * the registry only asks a plugin about the kinds it declared.
 */
function fetchDocument(ctx: PluginContext, entity: FacetEntity): Promise<Partial<FacetShapes>> {
  return entity.kind === "series" ? seriesDocument(ctx, entity) : movieDocument(ctx, entity);
}

/**
 * In-flight collection fetches, keyed by COLLECTION rather than by title.
 *
 * Separate from the document map above and keyed differently on purpose: opening The
 * Matrix and then Reloaded asks for the same collection twice, and the four films in a
 * collection warming together would otherwise buy four copies of one document. Keyed by
 * title it would coalesce nothing.
 */
const collectionsInFlight = new Map<number, Promise<RadarrCollection | null>>();

function collectionOnce(ctx: PluginContext, tmdbId: number): Promise<RadarrCollection | null> {
  const existing = collectionsInFlight.get(tmdbId);
  if (existing) return existing;
  const task = fetchCollection(ctx.fetch, tmdbId).finally(() => collectionsInFlight.delete(tmdbId));
  collectionsInFlight.set(tmdbId, task);
  return task;
}

async function movieDocument(ctx: PluginContext, entity: FacetEntity): Promise<Partial<FacetShapes>> {
  const movie = await fetchMovie(ctx.fetch, entity.tconst);
  if (!movie) return {};
  const facets = movieFacets(movie);

  /*
    ONE extra call, and only for a film that actually belongs to a collection -- which is
    a small minority of them. `/movie/imdb/{tconst}` names the collection and always
    sends `Parts: null`, so this is the only way to learn the siblings.

    Deliberately not a per-member fan-out: the parts arrive carrying their own `ImdbId`,
    so there is no id crosswalk to do. That is what keeps this one click deep rather than
    a burst onto Servarr's infrastructure.

    A failure here must not lose the other twelve facets, so the collection falls back to
    the name-only version the film's own payload already gave us.
  */
  if (facets.collection && movie.Collection) {
    const full = await collectionOnce(ctx, movie.Collection.TmdbId).catch(() => null);
    facets.collection = collectionWithParts(facets.collection, full, entity.tconst);
  }

  /*
    `related` is deliberately NOT resolved here.

    Recommendations arrive as TMDB ids and we index by IMDb, so it is tempting to look
    each one up -- and that costs ELEVEN calls to api.radarr.video for one film instead of
    one, on the render path, multiplied by the 221-title pre-warm. That is a sweep wearing
    a different name, against Servarr's own infrastructure, and the rule is one click deep.

    Caching each id permanently does not rescue it: the first view of every title still
    pays the burst, and the pre-warm makes "first view" the common case.

    The collection above is the shape that works -- ONE call returns every member with its
    ImdbId already attached. `related` has no such endpoint, so the crosswalk happens where
    it is free: the server maps these TMDB ids against `externalIds` rows we already hold.
  */
  return facets;
}

/** Two calls the first time a series is seen, one every time after -- see `resolveTvdbId`. */
async function seriesDocument(ctx: PluginContext, entity: FacetEntity): Promise<Partial<FacetShapes>> {
  const tvdbId = await resolveTvdbId(ctx.fetch, ctx.kv, entity.tconst);
  if (tvdbId === null) return {};
  const show = await fetchShow(ctx.fetch, tvdbId);
  return show ? seriesFacets(show) : {};
}
