/**
 * The two links out of a place page. Browser-side, because only the page draws them -- they
 * lived in the server's `filming-locations.ts` until 2026-09-14, which made `PlaceRoute` a VALUE
 * import across the server/browser boundary for two string builders.
 */

import type { Place } from "./api";

/**
 * Where a place is on a map, as an OpenStreetMap link, or null without a coordinate.
 *
 * DERIVED, never stored -- the same rule `titleLinks` follows for every other link out.
 * OpenStreetMap rather than Google: no key, no tracking script, and the link is to a page
 * rather than an embed, so nothing third-party loads on ours. Zoom 14 is a neighbourhood,
 * which is right for a castle and merely a little close for a city.
 */
export function placeMapUrl(place: Pick<Place, "lat" | "lon">): string | null {
  if (place.lat === null || place.lon === null) return null;
  const lat = place.lat.toFixed(5);
  const lon = place.lon.toFixed(5);
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=14/${lat}/${lon}`;
}

/**
 * "Filmed in" an area, "Filmed at" anything else -- the one wording, shared by the place page's
 * heading and an episode row's location line.
 *
 * A studio is "Filmed at Pinewood Studios": nearly every studio's own name already says
 * "Studios", so "Filmed at the studio Pinewood Studios" said it twice.
 */
export function placePrefix(place: Pick<Place, "kind">): string {
  return place.kind === "area" ? "Filmed in" : "Filmed at";
}

/**
 * "1 episode" / "12 episodes" -- the one wording for how many of a series' episodes were filmed
 * at a place, shared by the title pane and the place page so the two cannot say it differently.
 */
export function episodesLabel(n: number): string {
  return n === 1 ? "1 episode" : `${n.toLocaleString()} episodes`;
}

/**
 * What stands behind a series' place, or null when the series named it itself.
 *
 * Episodes win when both are known -- "3 episodes" is the finer grain -- and a place reached only
 * through a season says "1 season" rather than nothing, which read as the show's own home until
 * the round-4 review of 2026-09-14.
 */
export function partsLabel(parts: { episodes: number; seasons: number }): string | null {
  if (parts.episodes > 0) return episodesLabel(parts.episodes);
  if (parts.seasons > 0)
    return parts.seasons === 1 ? "1 season" : `${parts.seasons.toLocaleString()} seasons`;
  return null;
}

/**
 * The country to print under a place's name, or null when it would only repeat the name.
 *
 * A city-state is its own country: `/place/Q334` read "Filmed in Singapore" over a caption
 * reading "Singapore". Compared case- and accent-blind, because the country name comes from
 * `Intl.DisplayNames` in the reader's language and the label from Wikidata's English.
 */
export function countryCaption(label: string, country: string | null): string | null {
  if (!country) return null;
  const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
  return fold(country) === fold(label) ? null : country;
}

/** The place's own Wikidata page: the source of every fact on ours, and where to correct one. */
export function placeWikidataUrl(place: Pick<Place, "id">): string {
  return `https://www.wikidata.org/wiki/${place.id}`;
}
