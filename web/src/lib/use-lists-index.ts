/**
 * What `/lists` fetches, for whichever screen is asking.
 *
 * Two screens want it -- `/lists` draws all of it and a ranked `/browse` prints exactly one
 * completion -- and they want it on identical terms: paint from cache immediately, fetch
 * once, and say nothing at all if the fetch fails. That last part is why this is a hook
 * rather than two `useEffect`s: every section it feeds is an ADDITION to a page that already
 * renders, so a failure must leave the page alone rather than raise an error state. Two
 * copies of that judgement would eventually become one page that shows a banner.
 *
 * The request itself is deduped and cached in `./api`, so mounting both screens in one
 * session costs one call.
 */

import { useEffect, useState } from "react";
import { cachedListsIndex, getListsIndex, type ListsIndex, NO_LISTS_INDEX } from "./api";

export function useListsIndex(): ListsIndex {
  const [index, setIndex] = useState<ListsIndex>(() => cachedListsIndex() ?? NO_LISTS_INDEX);

  useEffect(() => {
    let stale = false;
    getListsIndex()
      .then((next) => {
        if (!stale) setIndex(next);
      })
      // Deliberately silent: see the note above. There is no state for "we could not count".
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, []);

  return index;
}
