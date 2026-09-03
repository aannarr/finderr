/**
 * Cast for a SERIES, with real person ids -- the half `servarr-metadata` cannot reach.
 *
 * Skyhook's `actors[]` is `{name, character, image}` and carries no id in any space; the
 * only id it holds sits inside an artwork URL, which `skyhook.ts` deliberately refuses to
 * parse. So a series' cast has never been linkable except through the title-scoped name
 * join, and 23.2% of all cast entries in the warmed corpus were series cast with no id at
 * all (measured 2026-09-03, 1,198 of 5,157).
 *
 * `aggregate_credits` fixes that and costs no extra call -- it rides the same
 * `append_to_response` the series document already asks for. It is the SERIES form of
 * credits: one entry per person with every role they played across the run, rather than
 * one entry per episode credit.
 *
 * A FILM IS NOT SERVED HERE. `api.radarr.video` already returns a film's cast keylessly,
 * with TMDB person ids on it, so a second copy would buy a call to render every actor
 * twice. Same shape of decision, and the same reason, as `keywords`.
 */

import { type CastMember, tmdbPersonId } from "../../lib/facets";

/** One person, and every role they played across the run. */
interface TmdbAggregateCastCredit {
  id?: number | null;
  name?: string | null;
  /** Billing rank across the whole show. NOT the array's own order -- see `parseSeriesCast`. */
  order?: number | null;
  /** A path, never a URL: `/9CAd7wr8QZyIN0E7nm8v1B6WkGn.jpg`. */
  profile_path?: string | null;
  roles?: { character?: string | null; episode_count?: number | null }[] | null;
}

/**
 * The appended block, narrowed to what this reads.
 *
 * `crew` is deliberately absent. It arrives whether we want it or not -- Game of Thrones
 * carries 348 entries -- and a series' crew is a question nobody has asked for yet, so
 * naming it here would be typing a wish.
 */
export interface TmdbAggregateCreditsResponse {
  cast?: TmdbAggregateCastCredit[] | null;
}

/**
 * How many of the top-billed we keep.
 *
 * `aggregate_credits` is EVERY credited actor across every season -- 587 for Game of
 * Thrones, where skyhook lists 44 -- and the tail is one-line guest parts nobody scrolls
 * to. The row draws thirty (`MAX_CAST` in `web/src/components/TitlePanes.tsx`); this
 * leaves headroom above that so raising it is a client change rather than a cache rebuild.
 *
 * Two costs are what make the tail worth dropping rather than keeping "just in case": the
 * whole list is cached per series (77 KB mapped, against skyhook's 44 entries), and
 * `FacetImageProxy.rewrite` issues a proxy key for EVERY image field on the render path,
 * so 587 entries means 539 hashes and rows written for faces nobody will ever see.
 */
export const MAX_SERIES_CAST = 50;

/**
 * A show's cast, or `null` when the appended block is absent.
 *
 * `null` is "TMDB does not have this show" and resolves the facet empty; a show TMDB knows
 * with nobody credited comes back as an empty array, which is a real answer.
 *
 * SORTED BY BILLING, because the array is not. Measured on `/tv/1399`: the array runs
 * `0,1,5,6,8,10,12,15,11,17,...` and Sean Bean at billing 2 sits at array index 42, so
 * taking the first fifty as they arrive would drop leads and keep bit parts.
 *
 * `imageBase` is `tmdb.imageBase` from config -- the same setting the poster proxy uses,
 * so an operator pointing at a mirror moves headshots with it. `original` matches the size
 * segment `api.radarr.video` puts on the headshots it sends, and `ArtworkService` rewrites
 * that segment to whatever width is actually being served.
 */
export function parseSeriesCast(
  res: TmdbAggregateCreditsResponse | null | undefined,
  imageBase: string,
): CastMember[] | null {
  if (!res) return null;
  return (res.cast ?? [])
    .flatMap((credit) => toCastMember(credit, imageBase))
    .sort((a, b) => a.order - b.order)
    .slice(0, MAX_SERIES_CAST);
}

/** A credit with no name is not a credit; everything else has a defensible empty form. */
function toCastMember(credit: TmdbAggregateCastCredit, imageBase: string): CastMember[] {
  const name = credit.name?.trim();
  if (!name) return [];

  return [
    {
      name,
      character: mainRole(credit),
      // A credit with no billing rank sorts LAST rather than first: `order` is a rank from
      // zero, so any fallback that looks like a number would promote an unranked bit part
      // over the lead. Every entry observed carries one; this is the shape being honest.
      order: credit.order ?? Number.MAX_SAFE_INTEGER,
      personId: typeof credit.id === "number" ? tmdbPersonId(credit.id) : null,
      image: credit.profile_path ? `${imageBase}/original${credit.profile_path}` : null,
    },
  ];
}

/**
 * The role they are actually known for on this show.
 *
 * A person can hold several roles across a run -- 17 of Game of Thrones' 587 do, mostly a
 * character plus a body-double or voice credit -- and `character` is one line under a
 * 96px-wide tile. The most episodes is the honest single answer: it is the part a reader
 * recognises them for, and joining every role would overflow the tile for the one case in
 * thirty-five where the extra roles are footnotes.
 */
function mainRole(credit: TmdbAggregateCastCredit): string | null {
  let best: { character: string; episodes: number } | null = null;
  for (const role of credit.roles ?? []) {
    const character = role.character?.trim();
    if (!character) continue;
    const episodes = role.episode_count ?? 0;
    if (!best || episodes > best.episodes) best = { character, episodes };
  }
  return best?.character ?? null;
}
