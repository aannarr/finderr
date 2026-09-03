/**
 * A trailer for a SERIES, which no keyless source in this product's reach carries.
 *
 * `api.radarr.video` hands a film its `YoutubeTrailerId` for free, so `servarr-metadata`
 * already answers this facet for a film -- and skyhook explicitly answers a series with an
 * empty list, because neither it nor Sonarr's own lookup has one. TMDB does.
 *
 * THE FACET CARRIES `{site, key}` AND NO URL. `trailerLinks()` in
 * `web/src/lib/facet-panes.ts` builds the address from a table keyed on the site id, and a
 * site missing from that table yields no link rather than a guessed one -- so the site is
 * spelled the way that table spells it (`youtube`, lower case, as `radarr.ts` emits it) and
 * TMDB's `YouTube` is folded down here rather than at the reader.
 */

import type { Trailer } from "../../lib/facets";

/** One video as TMDB describes it, narrowed to the four fields core's `Trailer` holds. */
interface TmdbVideo {
  site?: string | null;
  key?: string | null;
  name?: string | null;
  type?: string | null;
}

/**
 * The block as it arrives, nested under a `videos` key from `append_to_response`.
 *
 * The dedicated `/tv/{id}/videos` endpoint returns the same body, but is never called: a
 * sub-request on the detail document costs no round trip. See `./document`.
 */
export interface TmdbVideosResponse {
  results?: TmdbVideo[] | null;
}

/**
 * The video types this facet is ABOUT, best first.
 *
 * TMDB files seven kinds of clip under one endpoint -- Game of Thrones alone answers with
 * behind-the-scenes shorts, a featurette and its opening credits. Those are not trailers,
 * and contributing them would put "Opening Credits" in a pane labelled Trailers, so the
 * facet keeps the two types that answer "show me what this looks like".
 *
 * The ORDER is the ranking, and it is the reason this is an array rather than a set: a
 * teaser is a lesser trailer, so a show whose teaser happens to arrive first still leads
 * with the real thing.
 */
const TRAILER_TYPES: readonly string[] = ["Trailer", "Teaser"];

/**
 * A show's trailers, or `null` when TMDB has no record of it.
 *
 * A show TMDB knows with nothing filmed for it yet comes back as an empty array, which is a
 * real answer and caches as an empty facet.
 */
export function parseSeriesTrailers(res: TmdbVideosResponse | null | undefined): Trailer[] | null {
  if (!res) return null;
  // `sort` is stable in every runtime this ships on, so trailers keep the order TMDB sent
  // them among themselves and only the teasers move.
  return (res.results ?? [])
    .flatMap(ranked)
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.trailer);
}

/**
 * One video as core holds it plus where it sorts, or nothing when this facet is not about it.
 *
 * The rank is computed HERE rather than in the comparator so that "is this a trailer at
 * all" and "which trailer comes first" are one lookup with one answer -- a second one in
 * `sort` would be the same table read twice and could disagree with this one.
 *
 * A missing site or key is unopenable whatever the client does with it, and a type outside
 * `TRAILER_TYPES` belongs to a different question than the one this facet asks.
 */
function ranked(raw: TmdbVideo): { rank: number; trailer: Trailer }[] {
  const site = raw.site?.trim().toLowerCase();
  const key = raw.key?.trim();
  // An untyped video reads as `""`, which is in no rank and so is dropped by the same test
  // that drops a featurette. Every survivor therefore has a real kind to carry.
  const kind = raw.type?.trim() ?? "";
  const rank = TRAILER_TYPES.indexOf(kind);
  if (!site || !key || rank < 0) return [];
  return [{ rank, trailer: { site, key, name: raw.name?.trim() || null, kind } }];
}
