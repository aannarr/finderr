/**
 * Which of a title's terms go anywhere -- keywords, streaming services, the studio.
 *
 * A hook rather than a block on the title payload, for one reason: the answer depends on
 * the READER'S COUNTRY and the title payload does not. One cached `/api/title/:tconst` body
 * serves everybody, so a per-country field in it would have to be keyed on the session or
 * would quietly serve one reader another country's streaming catalogue.
 *
 * It runs AGAIN when the facets change, and that is the point rather than an accident:
 * `watchProviders` and `keywords` arrive after the page has painted, so the first answer is
 * about a title we knew almost nothing about. The chips render as plain text until then,
 * which is exactly what they were before this existed.
 *
 * SILENT ON FAILURE, the same judgement `useListCompletions` makes: a link is an ADDITION
 * to a row of chips that already renders, so a failed count must leave text behind rather
 * than raise an error state.
 */

import { useEffect, useState } from "react";
import { pickWatchProviders } from "../../../src/lib/watch-services";
import { getTermLinks, type Term } from "./api";
import { preferredCountries } from "./facet-panes";
import type { ResolvedFacets } from "./facets";
import { browserLocales } from "./reader-locale";

/**
 * Which country's offers this title's watch pane is about, or `undefined` for a title with
 * none here.
 *
 * READ FROM THE SAME RULE THE PANE USES, not from `preferredCountries[0]`. The preference
 * list has fallbacks in it, so a Thai reader looking at a film with no Thai offers sees the
 * GB row -- and a count taken for TH would then be counting a different question from the
 * one the tile in front of them asks.
 */
function watchCountryOf(facets: ResolvedFacets | undefined): string | undefined {
  const entries = facets?.watchProviders;
  if (entries?.status !== "ready" || !entries.data) return undefined;
  return pickWatchProviders(entries.data, preferredCountries(browserLocales()))?.country;
}

export function useTermLinks(tconst: string, facets: ResolvedFacets | undefined): Term[] {
  const country = watchCountryOf(facets);
  /*
    The facets themselves are NOT the dependency -- their identity changes on every poll of
    a title that still has a provider outstanding, which would refetch this on a timer. What
    this actually depends on is which terms exist, and those two names are what carry them.
  */
  const facetKey = `${facets?.keywords?.status ?? ""}|${facets?.watchProviders?.status ?? ""}`;
  const [terms, setTerms] = useState<Term[]>([]);

  /*
    DROP THE PREVIOUS TITLE'S ANSWER IN THE SAME RENDER the tconst changes, rather than an
    effect later. The route does not remount between two films, so without this the new
    page draws links measured for the old one for a frame -- and a keyword both films happen
    to share would be linked on a count that is not about it. Adjusting state while
    rendering is React's documented answer to a changed input, and it is what
    `BrowseRoute` and `CollectionRoute` already do for the same reason.
  */
  const [shownFor, setShownFor] = useState(tconst);
  if (shownFor !== tconst) {
    setShownFor(tconst);
    setTerms([]);
  }

  /*
    `facetKey` is a TRIGGER rather than a value the body reads: it is how "the terms this
    title has just changed" is expressed without depending on `facets` itself, whose
    identity changes on every poll of a title with a provider still outstanding.
  */
  // biome-ignore lint/correctness/useExhaustiveDependencies: facetKey is the trigger; see above
  useEffect(() => {
    let stale = false;
    getTermLinks(tconst, country)
      .then((t) => {
        if (!stale) setTerms(t);
      })
      // Deliberately silent: see the note above. There is no state for "we could not count".
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [tconst, country, facetKey]);

  return terms;
}
