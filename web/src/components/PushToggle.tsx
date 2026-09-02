/**
 * "Tell me when it arrives" -- the notification switch, on the account page.
 *
 * Its own component rather than another block in `AccountRoute`, because it owns a small
 * state machine that has nothing to do with sessions or passkeys: what this browser
 * supports, whether this browser is subscribed, and what went wrong. The route draws it and
 * knows none of that.
 *
 * WHAT IT SAYS WHEN IT CANNOT OFFER THE SWITCH IS THE POINT. There are four different
 * reasons notifications may be unavailable and three of them are things the reader can fix
 * -- install the app, undo a refusal in system settings, ask the operator to turn push on.
 * A control that greyed out with no sentence would send all three of them to the same dead
 * end, which on iOS is the majority case: Safari serves push only to an installed app.
 */

import { useCallback, useEffect, useState } from "react";
import { currentSubscription, disablePush, enablePush, type PushSupport, pushSupport } from "../lib/push-api";
import { LINK_BUTTON } from "../lib/ui";

/** What to say when there is no switch to draw. One sentence, and an action where there is one. */
const UNAVAILABLE: Record<Exclude<PushSupport["kind"], "available">, string> = {
  "install-first":
    "Add finderr to your home screen first. On iPhone and iPad, notifications are only delivered to an installed app -- Safari does not offer them to a tab.",
  unsupported: "This browser cannot deliver notifications.",
  denied:
    "Notifications are blocked for this site. Only your browser or system settings can undo that; finderr cannot ask again.",
  "server-off": "This server has notifications switched off.",
};

export function PushToggle() {
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

  const toggle = async () => {
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
  };

  // Nothing at all until the first read finishes. A section that flashes "unsupported" and
  // then becomes a switch is worse than one that appears a moment late.
  if (!support) return null;

  return (
    <section>
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium">Notifications</h2>
        {support.kind === "available" && (
          <button type="button" onClick={toggle} disabled={busy} className={LINK_BUTTON}>
            {busy ? "One moment…" : subscribed ? "Turn off on this device" : "Turn on for this device"}
          </button>
        )}
      </div>
      <p className="mt-2 text-sm text-muted">
        {support.kind !== "available"
          ? UNAVAILABLE[support.kind]
          : subscribed
            ? "This device will be told when something you asked for arrives. One message per request, so a whole season is one notification."
            : "Be told when something you asked for arrives, without keeping finderr open."}
      </p>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </section>
  );
}
