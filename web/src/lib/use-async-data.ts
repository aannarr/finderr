/**
 * Load something from the server, keep the refusal, and offer a way to do it again.
 *
 * The admin screens are four views of one database and every one of them has the same three
 * states -- loading, a refusal worth reading, and data. Written out per route that was four
 * copies of the same `useState`/`useEffect` pair, and the part that must not drift is the
 * ERROR RULE: a server refusal is shown verbatim, because on this surface the refusals are
 * real answers ("that is the last admin") rather than noise to flatten into "something went
 * wrong".
 *
 * Deliberately NOT a cache and NOT a query library. Nothing here is polled, nothing is shared
 * between routes, and every one of these pages is opened deliberately by one person who wants
 * the state as of now -- so a fetch on mount is the whole requirement.
 */

import { useCallback, useEffect, useState } from "react";

export interface AsyncData<T> {
  /** Null until the first load lands. `error` says whether it is still coming or never will. */
  data: T | null;
  error: string | null;
  /** Fetch again. Nothing calls this on a timer; it is what a mutation does when it lands. */
  reload: () => Promise<void>;
  /**
   * Run something that CHANGES the server, then reload.
   *
   * The pairing is the point: a page that mutated without reloading would go on drawing the
   * state it had before, which on an admin screen reads as the action having failed.
   */
  act: (fn: () => Promise<unknown>) => Promise<void>;
}

/**
 * `load` must be stable -- a `useCallback`, or a module-level function -- because it is what
 * decides when the effect runs again. On a route with a parameter that is the point: the
 * user page passes `useCallback(() => getAdminUser(id), [id])`, so navigating from one
 * person to another refetches.
 */
export function useAsyncData<T>(load: () => Promise<T>): AsyncData<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setData(await load());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [load]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      setError(null);
      try {
        await fn();
      } catch (e) {
        /*
          Shown verbatim, and NOT followed by a reload.

          A refused change left the server exactly where it was, so there is nothing new to
          fetch -- and a reload here would overwrite the refusal with `null` on its way to
          re-drawing the same rows, which is the message disappearing the instant it is
          worth reading.
        */
        setError((e as Error).message);
        return;
      }
      await reload();
    },
    [reload],
  );

  return { data, error, reload, act };
}
