/**
 * The facet vocabulary, as the client sees it.
 *
 * TYPES ONLY, and re-exported from exactly one place. The shapes are declared in
 * `src/lib/facets.ts` and the four per-facet statuses in `src/lib/facet-resolver.ts`;
 * `/api/title/:tconst` serves both verbatim. Re-typing them over here would give the
 * wire format two owners, and the second copy is the one nobody updates.
 *
 * `import type` is erased entirely under `verbatimModuleSyntax`, so no server module
 * is pulled into the bundle -- this costs the browser zero bytes.
 *
 * NOT to be confused with `Facets` in `./api`, which is the search filter's bucket
 * COUNTS. Same English word, unrelated concept; the note at the top of
 * `src/lib/facets.ts` says the same thing from the other side.
 */

export type { FacetStatus, ResolvedFacet, ResolvedFacets } from "../../../src/lib/facet-resolver";
export type {
  Availability,
  CastMember,
  Certification,
  Collection,
  CrewMember,
  EntityKind,
  Episode,
  ExternalIds,
  ExternalLink,
  FacetName,
  FacetProblem,
  FacetShapes,
  FailureReason,
  Keyword,
  Language,
  Rating,
  RelatedTitle,
  ReleaseDates,
  Season,
  Synopsis,
  Trailer,
  WatchProviders,
} from "../../../src/lib/facets";
