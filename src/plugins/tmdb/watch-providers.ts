/**
 * Where a title can be streamed, rented or bought -- the "Currently Streaming On" row.
 *
 * TMDB relays JustWatch's catalogue, which is the only source in this product's reach that
 * has it: no Servarr proxy carries availability, and neither does the IMDb corpus.
 *
 * EVERY COUNTRY IS KEPT BY DEFAULT, all hundred-odd of them, and the reader's one is
 * picked in the browser. The facet cache holds one answer per title for every reader, so
 * choosing a region here means choosing it for everybody -- which is why `tmdb
 * .watchProviderRegions` exists, is UNSET by default, and is the only thing that narrows
 * this. The `certification` facet works exactly this way for the same reason. A country's
 * three lists are a few short names, so the whole set is ~25 KB of highly repetitive JSON.
 *
 * The narrowing is an operator's call and never a default, because `pickWatchProviders`
 * has no fallback to "whatever country we do have" -- so a country trimmed out here is a
 * reader in that country losing the pane, not seeing a slightly worse one.
 */

import type { WatchProviders } from "../../lib/facets";
import type { TmdbApi, TmdbMediaType } from "../../lib/tmdb-api";

/** One service as TMDB names it. `display_priority` is the order it already arrives in. */
interface TmdbOffer {
  provider_name?: string | null;
}

/**
 * One country's offers.
 *
 * `free` and `ads` are real buckets TMDB fills for Tubi, Pluto and the like. Core's shape
 * has three lists and they fold into `flatrate`, because the question a reader is asking
 * is "can I watch this without paying for this title", and all three answer yes. Dropping
 * them instead would hide the free services entirely, which is the worse of the two lies.
 */
interface TmdbCountryOffers {
  link?: string | null;
  flatrate?: TmdbOffer[] | null;
  free?: TmdbOffer[] | null;
  ads?: TmdbOffer[] | null;
  rent?: TmdbOffer[] | null;
  buy?: TmdbOffer[] | null;
}

/**
 * Exported because it arrives two ways: on its own from `/{media}/{id}/watch/providers`,
 * and nested under a `watch/providers` key when a series asks for it through
 * `append_to_response`. Same body either way, so the same parser reads both.
 */
export interface TmdbWatchProviderResponse {
  results?: Record<string, TmdbCountryOffers> | null;
}

/**
 * The one address availability comes with -- TMDB's own watch page for this country.
 *
 * Kept because it is the ONLY link in the payload: there is no per-offer URL anywhere in
 * `watch/providers`, so this is what a tile can be clicked through to. It is also what
 * TMDB's terms have in mind when they ask that the catalogue be credited to JustWatch.
 * Absolute `https:` only, so the client's `externalHref` guard never meets a surprise.
 */
function linkOf(raw: unknown): string | null {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    return new URL(raw).protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Availability for one title in every country TMDB knows about.
 *
 * `null` means TMDB has no record of the title at all, which caches as an empty facet. A
 * title TMDB knows and JustWatch has no offers for comes back as an empty ARRAY -- also a
 * real answer, and the resolver caches it the same way.
 */
export async function fetchWatchProviders(
  api: TmdbApi,
  media: TmdbMediaType,
  tmdbId: number,
  regions?: readonly string[],
): Promise<WatchProviders[] | null> {
  return parseWatchProviders(
    await api.get<TmdbWatchProviderResponse>(`/${media}/${tmdbId}/watch/providers`),
    regions,
  );
}

/** The parse half, so an appended `watch/providers` block reads through the same rules. */
export function parseWatchProviders(
  res: TmdbWatchProviderResponse | null | undefined,
  regions?: readonly string[],
): WatchProviders[] | null {
  if (!res) return null;
  return countriesOf(res.results ?? {}, regions);
}

/**
 * Every country that offers the title somewhere, in a stable (alphabetical) order.
 *
 * `regions` narrows it when an operator has configured one; UNDEFINED AND EMPTY BOTH MEAN
 * KEEP EVERYTHING, which is not the same rule twice. Undefined is "nobody configured
 * this"; empty is what an env var of `""` or `" , "` parses down to, and reading that as
 * "keep no countries" would empty the facet for every title on a typo rather than failing
 * where somebody would see it.
 */
function countriesOf(
  results: Record<string, TmdbCountryOffers>,
  regions?: readonly string[],
): WatchProviders[] {
  const keep = regions && regions.length > 0 ? new Set(regions.map((r) => r.toUpperCase())) : null;
  return Object.keys(results)
    .sort()
    .flatMap((country) => {
      if (keep && !keep.has(country.toUpperCase())) return [];
      const offers = results[country];
      if (!offers) return [];
      const entry: WatchProviders = {
        country,
        flatrate: namesOf(offers.flatrate, offers.free, offers.ads),
        rent: namesOf(offers.rent),
        buy: namesOf(offers.buy),
        link: linkOf(offers.link),
      };
      // TMDB returns a country key with a `link` and no offers at all. That is not an
      // answer to "where can I watch this", so it is not a row.
      const empty = entry.flatrate.length + entry.rent.length + entry.buy.length === 0;
      return empty ? [] : [entry];
    });
}

/**
 * The service names from one or more buckets, deduped, in the order TMDB sent them.
 *
 * Names are passed through verbatim: TMDB's vocabulary is what the pane's mark lookup is
 * written against, and a service we have no mark for still has to print a name a reader
 * recognises. Deduping matters because a service can appear in both `flatrate` and `ads`.
 */
function namesOf(...buckets: (TmdbOffer[] | null | undefined)[]): string[] {
  const names = buckets
    .flatMap((bucket) => bucket ?? [])
    .map((offer) => offer.provider_name)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
  return [...new Set(names)];
}
