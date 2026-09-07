import { useMemo } from "react";
import { browseIntentOf } from "../../../src/lib/browse-intent";
import { describeFilters } from "../../../src/lib/lists";
import { BrowseChip } from "./BrowseChip";

/**
 * The bridge from a question typed into the search box to the grid that answers it.
 *
 * A reader who types "swedish crime drama" is describing a shelf, and the title index has
 * nothing to match it against -- so search returns twenty-five plausible strangers and the
 * reader opens whichever one looks least wrong. `/browse` answers exactly that question and
 * the chips that reach it went unclicked by every user in the first search log, so this puts
 * the destination in the one place they were already looking.
 *
 * It is OFFERED, never applied: the ranked results stay on screen underneath, and the link
 * spells out what it will do -- "best Crime in Swedish from the 2020s" -- so a reader can see
 * that "new" became a decade before they follow it. `browseIntentOf` returns null for
 * anything that might be a title, which is what keeps this off the screen for the ordinary
 * search.
 */
export function BrowseSuggestion({ query }: { query: string }) {
  const intent = useMemo(() => browseIntentOf(query), [query]);
  if (!intent) return null;

  return (
    <p className="mb-4 flex flex-wrap items-center gap-2 text-sm text-muted">
      <span>Looking for a list rather than a title?</span>
      <BrowseChip filters={intent} sort="rank" label={`${describeFilters(intent, true)} →`} />
    </p>
  );
}
