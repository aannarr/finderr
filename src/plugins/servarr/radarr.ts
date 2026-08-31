/**
 * `api.radarr.video` -- the movie half of the servarr-metadata plugin.
 *
 * Radarr hosts this proxy for every Radarr instance in the world and it needs no key, no
 * registration and no account. Seerr uses it for one number, the IMDb score; it returns
 * the entire film, which is most of the "needs a TMDB key" column of the metadata epic.
 *
 * One document in, ten facets out. The types below describe only the fields some facet
 * actually reads -- the payload is 71 KB and typing all of it would be typing a wish.
 */

import type { CastMember, Certification, FacetShapes, Rating } from "../../lib/facets";
import { getJson, type PluginFetch } from "../../lib/plugin-fetch";
import { calendarDate } from "./upstream";

export const RADARR_HOST = "api.radarr.video";

/** An artwork entry. `CoverType` is `Poster`, `Fanart`, `Headshot`, ... */
interface RadarrImage {
  CoverType: string;
  Url: string;
}

/** A cast or crew credit. `Job`/`Department` are present on crew only. */
interface RadarrCredit {
  Name: string;
  Order?: number;
  Character?: string | null;
  Job?: string | null;
  Department?: string | null;
  TmdbId?: number | null;
  Images?: RadarrImage[] | null;
}

interface RadarrRating {
  Value: number;
  Count: number;
}

export interface RadarrMovie {
  TmdbId: number;
  ImdbId: string | null;
  Title: string;
  Overview: string | null;
  OriginalLanguage: string | null;
  Year: number | null;
  Premier: string | null;
  InCinema: string | null;
  PhysicalRelease: string | null;
  DigitalRelease: string | null;
  MovieRatings: Record<string, RadarrRating> | null;
  Keywords: string[] | null;
  Recommendations: { TmdbId: number; Title: string }[] | null;
  Credits: { Cast?: RadarrCredit[] | null; Crew?: RadarrCredit[] | null } | null;
  YoutubeTrailerId: string | null;
  /** The film's own site, when it still has one. Frequently a studio campaign page. */
  Homepage: string | null;
  Certifications: { Country: string; Certification: string }[] | null;
  Collection: {
    TmdbId: number;
    Name: string;
    Parts: { ImdbId?: string | null; Title: string }[] | null;
  } | null;
}

/**
 * How to read each rating source: what the number is out of, and whose opinion it is.
 *
 * Every entry in `MovieRatings` claims `Type: "User"`, including Metacritic and Rotten
 * Tomatoes, which are critic aggregates -- so the payload's own `Type` is unusable and
 * the kind is declared here instead. A source missing from this table is SKIPPED rather
 * than guessed: rendering an 86 as 86/10 because we assumed the wrong scale is worse than
 * not rendering it, and a new source appearing upstream should be looked at by a human.
 */
const RATING_SOURCES: Record<string, { outOf: number; kind: Rating["kind"] }> = {
  Tmdb: { outOf: 10, kind: "user" },
  Imdb: { outOf: 10, kind: "user" },
  Trakt: { outOf: 10, kind: "user" },
  Metacritic: { outOf: 100, kind: "critics" },
  RottenTomatoes: { outOf: 100, kind: "critics" },
};

/**
 * Fetch one film, or `null` if this proxy has never heard of it.
 *
 * The endpoint answers with an ARRAY of one movie, not the movie -- every field list
 * written about this API describes `payload[0]`, and reading the array as an object gets
 * `undefined` out of every field without erroring anywhere.
 */
export async function fetchMovie(fetch: PluginFetch, tconst: string): Promise<RadarrMovie | null> {
  const found = await getJson<RadarrMovie[]>(fetch, `https://${RADARR_HOST}/v1/movie/imdb/${tconst}`);
  return found?.[0] ?? null;
}

/** A collection with its members. Only this endpoint populates `Parts`. */
export interface RadarrCollection {
  TmdbId: number;
  Name: string;
  Parts: { TmdbId: number; ImdbId: string | null; Title: string; Year: number | null }[] | null;
}

/**
 * The members of a collection, keylessly.
 *
 * **`Parts` is always null on `/movie/imdb/{tconst}`** -- a film's own payload names its
 * collection and never lists the siblings. This endpoint is the one that fills them in,
 * and it hands back each part's `ImdbId` directly, which is the whole reason collections
 * cost one extra call rather than a TMDB key plus a per-member id crosswalk.
 *
 * `null` for a collection the proxy does not know, which is an empty pane rather than an
 * error: a film can name a collection that has no other released members.
 */
export async function fetchCollection(fetch: PluginFetch, tmdbId: number): Promise<RadarrCollection | null> {
  return getJson<RadarrCollection>(fetch, `https://${RADARR_HOST}/v1/movie/collection/${tmdbId}`);
}

/**
 * Every facet this payload can answer, keyed by facet name.
 *
 * A facet absent from the returned object means "this film has none of that", which the
 * plugin turns into an explicitly empty facet rather than silence.
 */
export function movieFacets(movie: RadarrMovie): Partial<FacetShapes> {
  const facets: Partial<FacetShapes> = {
    ratings: ratingsOf(movie),
    cast: castOf(movie),
    crew: crewOf(movie),
    certification: certificationsOf(movie),
    trailer: trailerOf(movie),
    keywords: keywordsOf(movie),
    related: relatedOf(movie),
    releaseDates: {
      // `Premier` is the world premiere and `InCinema` the general theatrical release;
      // the first is the only date some festival films have.
      cinema: calendarDate(movie.InCinema ?? movie.Premier),
      physical: calendarDate(movie.PhysicalRelease),
      digital: calendarDate(movie.DigitalRelease),
    },
    externalIds: externalIdsOf(movie),
    links: linksOf(movie),
  };

  if (movie.Overview) {
    facets.synopsis = {
      text: movie.Overview,
      language: movie.OriginalLanguage ?? "en",
      // This proxy is a TMDB mirror -- TMDB ids throughout, artwork on image.tmdb.org --
      // so TMDB, not Radarr, is who wrote the words.
      source: "tmdb",
    };
  }
  if (movie.Collection) facets.collection = collectionOf(movie.Collection);

  return facets;
}

function ratingsOf(movie: RadarrMovie): Rating[] {
  return Object.entries(movie.MovieRatings ?? {}).flatMap(([source, rating]) => {
    const scale = RATING_SOURCES[source];
    if (!scale || typeof rating?.Value !== "number") return [];
    return [
      {
        source,
        kind: scale.kind,
        value: rating.Value,
        outOf: scale.outOf,
        // Metacritic and Rotten Tomatoes arrive with `Count: 0`, meaning "not told"
        // rather than "nobody voted". Omitting it renders no vote count at all, which is
        // the truth; sending 0 would render "0 votes".
        ...(rating.Count > 0 ? { count: rating.Count } : {}),
      },
    ];
  });
}

function castOf(movie: RadarrMovie): CastMember[] {
  return (movie.Credits?.Cast ?? []).map((credit, index) => ({
    name: credit.Name,
    character: credit.Character ?? null,
    order: credit.Order ?? index,
    personId: personId(credit),
    image: headshot(credit),
  }));
}

function crewOf(movie: RadarrMovie): FacetShapes["crew"] {
  return (movie.Credits?.Crew ?? []).flatMap((credit) =>
    credit.Job
      ? [
          {
            name: credit.Name,
            job: credit.Job,
            department: credit.Department ?? null,
            personId: personId(credit),
            image: headshot(credit),
          },
        ]
      : [],
  );
}

/** TMDB person ids, namespaced -- a bare `525` would not say whose id space it is in. */
function personId(credit: RadarrCredit): string | null {
  return credit.TmdbId ? `tmdb:${credit.TmdbId}` : null;
}

function headshot(credit: RadarrCredit): string | null {
  return credit.Images?.find((i) => i.CoverType === "Headshot")?.Url ?? null;
}

function certificationsOf(movie: RadarrMovie): Certification[] {
  return (movie.Certifications ?? []).map((c) => ({ country: c.Country, rating: c.Certification }));
}

function trailerOf(movie: RadarrMovie): FacetShapes["trailer"] {
  if (!movie.YoutubeTrailerId) return [];
  return [{ site: "youtube", key: movie.YoutubeTrailerId, name: null, kind: "Trailer" }];
}

/**
 * Keywords arrive as bare strings, so the word IS the id.
 *
 * That is a real identifier rather than a placeholder: two films tagged `heist` should
 * land on the same keyword page, and the string is what makes that work without an id
 * space we do not have.
 */
function keywordsOf(movie: RadarrMovie): FacetShapes["keywords"] {
  return (movie.Keywords ?? []).map((name) => ({ id: name, name }));
}

/**
 * Recommendations, keeping the id they arrived with.
 *
 * `tconst` stays null here because this endpoint identifies recommendations by TMDB id
 * and we index by IMDb -- but the TMDB id is CARRIED rather than dropped, which is the
 * difference between "not resolved yet" and "can never be resolved". It was dropped
 * originally, leaving a list of bare titles that no amount of later work could link.
 *
 * Resolving it is deliberately not this function's job: `api.radarr.video/v1/movie/{id}`
 * answers the crosswalk keylessly, but calling it for all ten recommendations while
 * building one title's facets would multiply our load on Servarr's infrastructure by ten
 * on a page nobody has clicked through from yet.
 */
function relatedOf(movie: RadarrMovie): FacetShapes["related"] {
  return (movie.Recommendations ?? []).map((r) => ({
    tconst: null,
    title: r.Title,
    reason: "recommended",
    tmdbId: r.TmdbId ?? null,
  }));
}

/**
 * The collection as the FILM's own payload describes it: a name, and no members.
 *
 * `Parts` is always null here. `fetchCollection` is the endpoint that fills them in, and
 * `collectionWithParts` below merges the two.
 */
function collectionOf(collection: NonNullable<RadarrMovie["Collection"]>): FacetShapes["collection"] {
  return {
    id: `tmdb:${collection.TmdbId}`,
    name: collection.Name,
    parts: (collection.Parts ?? []).map((p) => ({ tconst: p.ImdbId ?? null, title: p.Title })),
  };
}

/**
 * The collection, with the members the second call supplies.
 *
 * `self` is dropped: the pane says "other movies in this collection", and a card linking
 * to the page you are already on is a dead end wearing a poster. Doing it here rather
 * than in the component means the FACET means what it says -- a client that renders the
 * list somewhere else gets the same honest answer.
 *
 * A part with no `ImdbId` is kept with a null tconst rather than discarded, so a caller
 * can still count the collection correctly; it is the RENDERER that drops what it cannot
 * link, because whether an unlinkable entry is worth showing depends on the surface.
 */
export function collectionWithParts(
  base: FacetShapes["collection"],
  full: RadarrCollection | null,
  selfTconst: string,
): FacetShapes["collection"] {
  if (!full?.Parts) return base;
  return {
    ...base,
    parts: full.Parts.filter((p) => p.ImdbId !== selfTconst).map((p) => ({
      tconst: p.ImdbId ?? null,
      title: p.Title,
    })),
  };
}

/**
 * The film's own site, and deliberately nothing else.
 *
 * The `links` facet is for addresses no id space can express. An IMDb, TMDB or Trakt link
 * is a pure function of an id already in `externalIds` and is built at render time, so
 * contributing one here would store a second copy of a fact we hold -- and the two would
 * eventually disagree. `Homepage` is the opposite case: an address with no id behind it,
 * riding a document this plugin already fetches, so it costs no call at all.
 *
 * Not validated beyond being non-empty. Whether a string is safe to put in an `href` is the
 * client's question and it has one owner there (`externalHref`); duplicating the rule in
 * every provider is how the two spellings of it drift.
 */
function linksOf(movie: RadarrMovie): FacetShapes["links"] {
  const homepage = movie.Homepage?.trim();
  return homepage ? [{ kind: "homepage", url: homepage }] : [];
}

function externalIdsOf(movie: RadarrMovie): FacetShapes["externalIds"] {
  const ids: FacetShapes["externalIds"] = { tmdb: movie.TmdbId };
  if (movie.ImdbId) ids.imdb = movie.ImdbId;
  return ids;
}
