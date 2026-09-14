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

/** The place's own Wikidata page: the source of every fact on ours, and where to correct one. */
export function placeWikidataUrl(place: Pick<Place, "id">): string {
  return `https://www.wikidata.org/wiki/${place.id}`;
}
