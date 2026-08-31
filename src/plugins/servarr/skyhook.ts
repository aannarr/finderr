/**
 * `skyhook.sonarr.tv` -- the series half of the servarr-metadata plugin.
 *
 * Sonarr's own TVDB mirror, no key and no registration, and it returns strictly more than
 * TVmaze: named seasons, per-episode air dates, actors, the content rating and every
 * external id in one document.
 *
 * It is keyed by TVDB id and knows nothing about `tt...`, so a series costs two calls the
 * first time and one call forever after -- see `resolveTvdbId`.
 */

import { type Episode, type FacetShapes, languageFacet, type Season } from "../../lib/facets";
import { getJson, type PluginFetch } from "../../lib/plugin-fetch";
import type { PluginKv } from "../../lib/plugins";
import { calendarDate, dateRange } from "./upstream";

export const SKYHOOK_HOST = "skyhook.sonarr.tv";

/**
 * The language segment of every skyhook path, and therefore the language of the text it
 * hands back. One owner, so the synopsis cannot claim a language we did not ask for.
 */
const LANGUAGE = "en";

interface SkyhookImage {
  coverType: string;
  url: string;
}

interface SkyhookEpisode {
  seasonNumber: number;
  episodeNumber: number;
  title?: string | null;
  airDate?: string | null;
  overview?: string | null;
  image?: string | null;
}

interface SkyhookSeason {
  seasonNumber: number;
  name?: string | null;
  images?: SkyhookImage[] | null;
}

/** A hit from the search endpoint -- enough to cross an IMDb id to a TVDB one. */
interface SkyhookSearchHit {
  tvdbId: number;
  imdbId?: string | null;
}

export interface SkyhookShow {
  tvdbId: number;
  title: string;
  overview?: string | null;
  imdbId?: string | null;
  tmdbId?: number | null;
  tvMazeId?: number | null;
  tvRageId?: number | null;
  /**
   * The language the show was MADE in, in ISO 639-2 (`eng`) -- not `language`, which is
   * the language of the text in THIS document and is whatever `LANGUAGE` asked for.
   * `languageFacet` folds the code down to the 639-1 form Radarr sends.
   */
  originalLanguage?: string | null;
  malIds?: number[] | null;
  anidbIds?: number[] | null;
  aniListIds?: number[] | null;
  contentRating?: string | null;
  /**
   * IMDb's aggregate, despite sitting on a TVDB record. Declared so its shape is on
   * file and DELIBERATELY not mapped to a facet -- see `seriesFacets`.
   */
  rating?: { count?: number | null; value?: string | number | null } | null;
  actors?: { name: string; character?: string | null; image?: string | null }[] | null;
  seasons?: SkyhookSeason[] | null;
  episodes?: SkyhookEpisode[] | null;
}

/**
 * The IMDb id skyhook does not have, cached in plugin storage forever.
 *
 * `tconst -> tvdbId` is the expensive half of every series lookup and it never changes,
 * so it belongs in `c.kv` rather than in the facet cache: a facet expiring must not buy
 * the search call again. Only successes are stored -- a series skyhook has not indexed
 * yet may well be there next month, and a permanently cached "no" would hide it.
 */
export async function resolveTvdbId(
  fetch: PluginFetch,
  kv: PluginKv,
  tconst: string,
): Promise<number | null> {
  const key = `tvdb:${tconst}`;
  const cached = kv.get(key);
  if (cached) return Number(cached);

  const url = `https://${SKYHOOK_HOST}/v1/tvdb/search/${LANGUAGE}/?term=imdb:${tconst}`;
  const hits = await getJson<SkyhookSearchHit[]>(fetch, url);
  // A term search answers with a LIST, and an `imdb:` term is not promised to be an exact
  // match -- taking `[0]` on faith would attach another show's episodes to this title.
  const exact = hits?.find((hit) => hit.imdbId === tconst);
  if (!exact) return null;

  kv.set(key, String(exact.tvdbId));
  return exact.tvdbId;
}

/** Fetch one series, or `null` if skyhook does not hold that TVDB id. */
export function fetchShow(fetch: PluginFetch, tvdbId: number): Promise<SkyhookShow | null> {
  return getJson<SkyhookShow>(fetch, `https://${SKYHOOK_HOST}/v1/tvdb/shows/${LANGUAGE}/${tvdbId}`);
}

/** Every facet this payload can answer, keyed by facet name. */
export function seriesFacets(show: SkyhookShow): Partial<FacetShapes> {
  const episodes = episodesOf(show);
  const facets: Partial<FacetShapes> = {
    // No `ratings`. `show.rating` is IMDb's aggregate wearing TVDB's name -- see the
    // regression test in `servarr-metadata.test.ts` for the four titles that prove it.
    // We hold that number locally for every indexed title, fresher and with a link.
    cast: castOf(show),
    certification: certificationOf(show),
    seasons: seasonsOf(show, episodes),
    episodes,
    externalIds: externalIdsOf(show),
    language: languageFacet(show.originalLanguage),
    // Neither skyhook nor Sonarr's own lookup carries a TV trailer. An explicitly empty
    // facet says "we looked and there is none", which is a different fact from silence.
    trailer: [],
  };

  if (show.overview) {
    facets.synopsis = { text: show.overview, language: LANGUAGE, source: "tvdb" };
  }
  return facets;
}

/** Billing order is the order skyhook lists them in -- it carries no explicit rank. */
function castOf(show: SkyhookShow): FacetShapes["cast"] {
  return (show.actors ?? []).map((actor, index) => ({
    name: actor.name,
    character: actor.character ?? null,
    order: index,
    // The person id exists only inside the artwork URL; parsing one out of an image path
    // would break the day they change their CDN layout.
    personId: null,
    image: actor.image ?? null,
  }));
}

/**
 * `contentRating` is a single string with no country attached.
 *
 * Every value observed is a US system code (`TV-MA`, `TV-14`), which is what TVDB records,
 * so it is reported as US rather than as a rating from nowhere. A pane showing it beside
 * Radarr's 42 country certifications will therefore group it correctly.
 */
function certificationOf(show: SkyhookShow): FacetShapes["certification"] {
  return show.contentRating ? [{ country: "US", rating: show.contentRating }] : [];
}

function episodesOf(show: SkyhookShow): Episode[] {
  return (show.episodes ?? []).map((ep) => ({
    season: ep.seasonNumber,
    number: ep.episodeNumber,
    title: ep.title ?? null,
    airDate: calendarDate(ep.airDate),
    overview: ep.overview ?? null,
    image: ep.image ?? null,
    // Skyhook carries only a show-level typical runtime. Copying it onto every episode
    // would dress a guess up as a fact.
    runtime: null,
  }));
}

/**
 * Seasons, with the counts and dates derived from the episodes we already hold.
 *
 * Skyhook's season entries carry a number, sometimes a name, and artwork -- no episode
 * count and no dates. Deriving them here costs nothing and means a pane never has to walk
 * the episode list to render a season header.
 */
function seasonsOf(show: SkyhookShow, episodes: Episode[]): Season[] {
  return (show.seasons ?? []).map((season) => {
    const airDates = episodes.filter((e) => e.season === season.seasonNumber).map((e) => e.airDate);
    const { first, last } = dateRange(airDates);
    return {
      number: season.seasonNumber,
      name: season.name ?? null,
      episodeCount: airDates.length,
      premiereDate: first,
      endDate: last,
      image: season.images?.find((i) => i.coverType === "Poster")?.url ?? null,
    };
  });
}

/**
 * Every id space skyhook crosswalks to, in one object.
 *
 * The anime id spaces are lists because a TVDB series can map to several AniDB entries;
 * an empty list is "not an anime" and is left out rather than stored as `[]`.
 */
function externalIdsOf(show: SkyhookShow): FacetShapes["externalIds"] {
  const ids: FacetShapes["externalIds"] = { tvdb: show.tvdbId };
  if (show.imdbId) ids.imdb = show.imdbId;
  if (show.tmdbId) ids.tmdb = show.tmdbId;
  if (show.tvMazeId) ids.tvmaze = show.tvMazeId;
  if (show.tvRageId) ids.tvrage = show.tvRageId;
  for (const [space, values] of [
    ["mal", show.malIds],
    ["anidb", show.anidbIds],
    ["anilist", show.aniListIds],
  ] as const) {
    if (values?.length) ids[space] = values.join(",");
  }
  return ids;
}
