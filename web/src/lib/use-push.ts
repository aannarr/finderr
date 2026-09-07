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
 * supports, whether it is subscribed, whether this person has already been asked, what went
 * wrong -- so that lives here and is imported twice. A second component reimplementing
 * `refresh` is how one of them ends up caching a permission the reader has since revoked.
 *
 * > [!IMPORTANT] TWO SCOPES, and confusing them is the bug this file is shaped to prevent
 * > `subscribed` is about THIS BROWSER: it is `PushManager.getSubscription()`, and a new
 * > laptop is honestly not subscribed. `offered` is about THE PERSON: it is a column on
 * > their account, and it stays true on every device they ever sign in from. The offer is
 * > gated on BOTH, which is what makes "ask once, ever" true across devices while leaving
 * > each device able to turn its own notifications on from the account page.
 *
 * NOTHING HERE TOUCHES THE DOM beyond the browser APIs `push-api.ts` already owns. It is a
 * hook rather than a component for exactly that reason: the decisions are about state.
 */

import { useCallback, useEffect, useState } from "react";
import {
  currentSubscription,
  disablePush,
  disablePushEverywhere,
  enablePush,
  markPushOffered,
  type PushSupport,
  pushState,
  pushSupport,
} from "./push-api";

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
  /**
   * Has this PERSON already been asked, on any device? Starts true and relaxes.
   *
   * TRUE UNTIL PROVEN OTHERWISE, deliberately: the first frame of a page must not flash an
   * offer at somebody who settled this months ago. `false` is only ever set from a real
   * answer off the server.
   */
  offered: boolean;
  /**
   * How many devices this ACCOUNT has subscribed, this browser included.
   *
   * The account page draws it, because "turn it off everywhere" is meaningless without it --
   * and because it is the only place a reader ever learns that a phone they no longer own is
   * still on the list.
   */
  devices: number;
  /** A toggle is in flight. Callers disable their control rather than queueing a second one. */
  busy: boolean;
  /** What went wrong, or what the reader chose. See `toggle`. */
  error: string | null;
  /** Subscribe if off, unsubscribe if on. A no-op unless `support.kind === "available"`. */
  toggle: () => Promise<void>;
  /**
   * Turn it off on every device, including ones the reader is not holding.
   *
   * The only control that can reach a phone somebody no longer has -- see
   * `disablePushEverywhere`. Does NOT re-open the offer: an off switch pressed on purpose is
   * not an invitation to ask again.
   */
  disableAll: () => Promise<void>;
  /** "Not now, and do not ask again." Records the answer and closes the offer for good. */
  dismiss: () => Promise<void>;
}

export function usePush(): PushControl {
  const [support, setSupport] = useState<PushSupport | null>(null);
  const [subscribed, setSubscribed] = useState(false);
  const [offered, setOffered] = useState(true);
  const [devices, setDevices] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    // Re-read on every pass rather than caching: permission can be revoked in system
    // settings while the app is open, and a control drawn from a stale reading is a button
    // that silently does nothing.
    setSupport(await pushSupport());
    setSubscribed((await currentSubscription()) !== null);
    const state = await pushState();
    setOffered(state.offered);
    setDevices(state.devices);
  }, []);

  useEffect(() => {
    void refresh().catch((e) => setError((e as Error).message));
  }, [refresh]);

  /**
   * Close the offer, locally and on the server, in that order.
   *
   * The local flag moves FIRST so the offer disappears on the same frame the reader acted
   * on. The write is what makes it true on their next device; losing it costs one more
   * offer, once, which is not worth blocking the interaction for.
   */
  const close = useCallback(async () => {
    setOffered(true);
    await markPushOffered();
  }, []);

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
      // Either way they have now answered the question, so it is never put to them again.
      // `/api/push/subscribe` records the same thing for a success; this covers the refusal,
      // and the two are idempotent because the column is first-write-wins.
      await close();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [support, subscribed, refresh, close]);

  const disableAll = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await disablePushEverywhere();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  return { support, subscribed, offered, devices, busy, error, toggle, disableAll, dismiss: close };
}
