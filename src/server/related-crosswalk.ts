/**
 * Which of OUR titles a "more like this" entry actually names.
 *
 * THE PROBLEM IS THAT A TMDB ID DOES NOT SAY WHOSE ID SPACE IT IS IN. Movie ids and TV ids
 * are two independent sequences that both start at 1 and collide freely -- TMDB 1399 is
 * *Game of Thrones* on the TV side and a wholly different title on the movie side -- and
 * both spaces are written into the one `tmdb` key of the `externalIds` facet:
 * `src/plugins/servarr/radarr.ts` contributes a movie id, `src/plugins/servarr/skyhook.ts`
 * a TV id. Matching a recommendation on the bare number therefore drew a plausible-looking
 * card for the wrong title, with no error and no log, and which of the two won was whichever
 * row the unordered scan visited last.
 *
 * THE SPACE IS RECOVERED FROM THE KIND, on both sides of the match:
 *
 *   - the ASKING side is the entity whose page this is. A film's recommendations arrive
 *     from `api.radarr.video` in movie space and a series' from TMDB's `/tv` document in TV
 *     space, so the page's own kind is the space its recommendations are in.
 *   - the ANSWERING side is the kind of the title that stored the `externalIds` row, read
 *     out of our index. A row on a series holds a TV id; a row on a film holds a movie id.
 *
 * WHY NOT NAMESPACE THE STORED VALUE, which is the other obvious fix and the one
 * `PersonCredit.personId` took: `externalIds` is `immutable`, so every row already cached
 * would keep its bare number forever and the reader would need both shapes anyway. This
 * needs no migration and no facet-shape change, and within one id space a TMDB id is unique
 * so the match is exact rather than a heuristic.
 *
 * WHY THE SPACE IS NOT CARRIED ON `RelatedTitle` either: both providers produce
 * recommendations of the entity's own kind, so the field would have exactly one possible
 * value per page today -- the same reason `Language` carries no `kind` discriminator. A
 * provider that genuinely recommends across kinds is the moment to add it, and this is where
 * the assumption would break.
 */

import { type EntityKind, entityKindFor, type RelatedTitle } from "../lib/facets";

/**
 * The two reads a crosswalk needs, named rather than passed as whole subsystems.
 *
 * They come from DIFFERENT DATABASES -- the candidates from the app store's
 * `facet_contribution`, the kind from the title index -- which is exactly why the join
 * cannot happen in SQL and happens here instead. Injected so this file is testable without
 * either of them.
 */
export interface RelatedCrosswalk {
  /** Every tconst we hold an `externalIds` row for, per TMDB id, in no particular order. */
  candidatesFor(tmdbIds: readonly number[]): ReadonlyMap<number, readonly string[]>;
  /** Our index's raw IMDb `titleType` for a tconst, or `null` for one we do not hold. */
  titleTypeOf(tconst: string): string | null;
}

/**
 * One tconst per recommendation, in order, `null` where we cannot name one HONESTLY.
 *
 * `null` is an ordinary answer and the caller drops the entry, which is what keeps the row
 * truthful: a recommendation we hold only in the other id space is a dead end, and a dead
 * end is a better answer than a card that opens somebody else's title.
 *
 * @param kind the kind of the title being viewed, which IS the id space its recommendations
 *   are in -- see the module comment.
 */
export function relatedTconsts(
  related: readonly RelatedTitle[],
  kind: EntityKind,
  crosswalk: RelatedCrosswalk,
): (string | null)[] {
  // The crosswalk is a full scan of `externalIds`, so it is asked once for the whole row and
  // never at all when every entry already carries our id.
  const needed = related.flatMap((r) => (!r.tconst && r.tmdbId ? [r.tmdbId] : []));
  const candidates: ReadonlyMap<number, readonly string[]> =
    needed.length > 0 ? crosswalk.candidatesFor(needed) : new Map();

  return related.map((r) => r.tconst ?? inSpace(candidates.get(r.tmdbId ?? -1), kind, crosswalk));
}

/**
 * The single candidate whose own kind puts it in the asked-for id space, or `null`.
 *
 * AMBIGUITY IS DROPPED, NEVER RESOLVED -- the rule `loadPersonCrosswalk` already applies to
 * a TMDB person id claimed by two people. Two of our titles carrying one id in ONE space is
 * a contradiction upstream, not a choice to make, and picking either would be the coin toss
 * this whole change exists to end. A candidate missing from the index is dropped before the
 * count, so an unindexed title cannot make a good match look ambiguous.
 */
function inSpace(
  candidates: readonly string[] | undefined,
  kind: EntityKind,
  crosswalk: RelatedCrosswalk,
): string | null {
  const matches = (candidates ?? []).filter((tconst) => {
    const titleType = crosswalk.titleTypeOf(tconst);
    return titleType !== null && entityKindFor(titleType) === kind;
  });
  return matches.length === 1 ? (matches[0] ?? null) : null;
}
