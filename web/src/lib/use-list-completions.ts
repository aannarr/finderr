/**
 * "How much of each list do I own", for whichever screen is asking.
 *
 * Two screens want it -- `/lists` prints twenty-six at once and a ranked `/browse` prints
 * exactly one -- and they want it on identical terms: paint from cache immediately, fetch
 * once, and say nothing at all if the fetch fails. That last part is why this is a hook
 * rather than two `useEffect`s: a completion count is an ADDITION to a page that already
 * renders, so a failure must leave the page alone rather than raise an error state. Two
 * copies of that judgement would eventually become one page that shows a banner.
 *
 * The request itself is deduped and cached in `./api`, so mounting both screens in one
 * session costs one call.
 */

import { useEffect, useState } from "react";
import { cachedListCompletions, getListCompletions, type ListCompletions } from "./api";

export function useListCompletions(): ListCompletions {
  const [completions, setCompletions] = useState<ListCompletions>(() => cachedListCompletions() ?? {});

  useEffect(() => {
    let stale = false;
    getListCompletions()
      .then((c) => {
        if (!stale) setCompletions(c);
      })
      // Deliberately silent: see the note above. There is no state for "we could not count".
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, []);

  return completions;
}
