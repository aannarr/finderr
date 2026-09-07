/**
 * The in-flight state a control shares with the server: busy while it works, and the
 * server's own words if it refused.
 *
 * `run` NEVER THROWS. A rejected write is a message beside the control, not an unhandled
 * rejection that takes the page down -- the failure a person needs to see is "that could not
 * be saved", in the place they were looking.
 *
 * Lifted out of `components/SettingControls.tsx` when the shelf-arrangement screen needed the
 * same three fields around three different writes (its first load, a save, and a reset). It is
 * in `lib/` rather than exported from that file because it is not a setting control any more:
 * it knows nothing about labels, inputs or what is being saved, and a hook living inside a
 * component module is a hook the next caller copies rather than imports.
 */

import { useCallback, useState } from "react";

export interface Saving {
  busy: boolean;
  /** The server's refusal, verbatim, or null. Cleared when the next attempt starts. */
  error: string | null;
  run: (work: () => Promise<void>) => void;
}

export function useSaving(): Saving {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
    STABLE ACROSS RENDERS, and that is not a micro-optimisation: a caller that starts its
    first load from an effect has to be able to list `run` as a dependency honestly. A `run`
    rebuilt every render would re-fire that effect on every keystroke of the save it was
    watching. Both setters are stable, so there is nothing for the closure to go stale over.
  */
  const run = useCallback((work: () => Promise<void>): void => {
    setBusy(true);
    setError(null);
    void work()
      .catch((e: unknown) => setError((e as Error).message))
      .finally(() => setBusy(false));
  }, []);

  return { busy, error, run };
}
