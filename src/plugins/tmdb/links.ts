/**
 * A series' official site -- and deliberately nothing else.
 *
 * The `links` facet is for an address with no id behind it. An IMDb, TMDB, Trakt or TVDB
 * link is a pure function of an id already in `externalIds` and is built at render time by
 * `titleLinks()` from `LINK_SITES`, so contributing one here would store a second copy of a
 * fact we hold and the two would eventually disagree. `homepage` is the opposite case, and
 * it rides the detail document this plugin already fetches, so it costs no call.
 *
 * `api.radarr.video` hands a FILM the same fact as `Homepage`, which is why `linksOf` in
 * `src/plugins/servarr/radarr.ts` reads the same and the two spell `homepage` alike. Neither
 * skyhook nor Sonarr's lookup has it for a series, which is the gap this closes.
 */

import type { ExternalLink } from "../../lib/facets";

/**
 * The show's own site as a one-entry list, or an empty one when TMDB has no address.
 *
 * TMDB sends `""` far more often than it omits the field, so an empty string is the common
 * "no site" answer rather than an edge case.
 *
 * Not validated beyond being non-empty. Whether a string is safe to put in an `href` is the
 * client's question and it has one owner there (`externalHref`); duplicating the rule in
 * every provider is how the two spellings of it drift.
 */
export function parseHomepageLink(homepage: string | null | undefined): ExternalLink[] {
  const url = homepage?.trim();
  return url ? [{ kind: "homepage", url }] : [];
}
