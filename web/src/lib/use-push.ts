/**
 * The push switch as a state machine, with no opinion about how it is drawn.
 *
 * `PushToggle` on the account page is one rendering of it and `PushOffer` on `/requests` is
 * another, and they are genuinely different screens rather than one screen with a size prop:
 * the account page is a settings SECTION that must explain all four reasons push may be
 * unavailable, while the offer is one quiet line that appears beside a moving download and
 * says nothing at all when there is nothing to offer.
 *
 * What they must never disagree about is the machine underneath -- what this browser
 * supports, whether it is subscribed, what went wrong -- so that lives here and is imported
 * twice. A second component reimplementing `refresh` is how one of them ends up caching a
 * permission the reader has since revoked.
 *
 * NOTHING HERE TOUCHES THE DOM beyond the browser APIs `push-api.ts` already owns. It is a
 * hook rather than a component for exactly that reason: the decisions are about state.
 */

import { useCallback, useEffect, useState } from "react";
import { currentSubscription, disablePush, enablePush, type PushSupport, pushSupport } from "./push-api";

export interface PushControl {
  /**
   * What this browser can do, or null until the first read finishes.
   *
   * NULL IS "NOT YET ANSWERED" and every caller must draw nothing for it. A section that
   * flashes "unsupported" and then becomes a switch is worse than one that appears a moment
   * late, and on iOS the wrong first frame is the majority case.
   */
  support: PushSupport | null;
  /** Is THIS browser subscribed? Per device, never per account -- see `enablePush`. */
  subscribed: boolean;
  /** A toggle is in flight. Callers disable their control rather than queueing a second one. */
  busy: boolean;
  /** What went wrong, or what the reader chose. See `toggle`. */
  error: string | null;
  /** Subscribe if off, unsubscribe if on. A no-op unless `support.kind === "available"`. */
  toggle: () => Promise<void>;
}

export function usePush(): PushControl {
  const [support, setSupport] = useState<PushSupport | null>(null);
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    // Re-read on every pass rather than caching: permission can be revoked in system
    // settings while the app is open, and a control drawn from a stale reading is a button
    // that silently does nothing.
    setSupport(await pushSupport());
    setSubscribed((await currentSubscription()) !== null);
  }, []);

  useEffect(() => {
    void refresh().catch((e) => setError((e as Error).message));
  }, [refresh]);

  const toggle = useCallback(async () => {
    if (support?.kind !== "available") return;
    setBusy(true);
    setError(null);
    try {
      if (subscribed) {
        await disablePush();
      } else if (!(await enablePush(support.publicKey))) {
        // Declining is an ANSWER, not a failure. Saying so plainly is better than an error
        // box about something the reader chose on purpose a second ago.
        setError("You declined notifications. Your browser will not ask again on its own.");
      }
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [support, subscribed, refresh]);

  return { support, subscribed, busy, error, toggle };
}
