/**
 * One title's watch state for the reader, read once and re-read when asked.
 *
 * Its own request rather than a field on `/api/title/:tconst`, because that payload is cached
 * for everybody and this is per reader -- the same argument `useTermLinks` makes about country.
 * It is an ADDITION to a page that already renders: until it answers, and if it never does, the
 * header says "Play here" and the rows carry no progress, exactly as before this existed.
 */

import { useCallback, useEffect, useState } from "react";
import { getWatch, type WatchState } from "./watch-api";

export function useWatchState(tconst: string | undefined): { watch: WatchState | null; refresh: () => void } {
  const [watch, setWatch] = useState<WatchState | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!tconst) return;
    // Read on mount and on every refresh; `generation` is what a refresh bumps.
    void generation;
    let live = true;
    void getWatch(tconst).then((next) => {
      // A failed read keeps the last good answer rather than blanking the rows.
      if (live && next) setWatch(next);
    });
    return () => {
      live = false;
    };
  }, [tconst, generation]);

  // A new title starts with nothing, not with the previous title's progress.
  useEffect(() => {
    void tconst;
    setWatch(null);
  }, [tconst]);

  const refresh = useCallback(() => setGeneration((g) => g + 1), []);
  return { watch, refresh };
}
