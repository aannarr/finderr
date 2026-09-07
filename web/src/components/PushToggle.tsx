/**
 * "Tell me when it arrives" -- the notification switch, on the account page.
 *
 * Its own component rather than another block in `AccountRoute`, because a settings section
 * has nothing to do with sessions or passkeys. The state machine it draws -- what this
 * browser supports, whether it is subscribed, what went wrong -- is `usePush`, shared with
 * the contextual offer on `/requests`; this file owns only the SETTINGS rendering of it.
 *
 * WHAT IT SAYS WHEN IT CANNOT OFFER THE SWITCH IS THE POINT, and it is why this rendering
 * exists separately from the offer. There are four different reasons notifications may be
 * unavailable and three of them are things the reader can fix -- install the app, undo a
 * refusal in system settings, ask the operator to turn push on. A control that greyed out
 * with no sentence would send all three of them to the same dead end, which on iOS is the
 * majority case: Safari serves push only to an installed app.
 */

import type { PushSupport } from "../lib/push-api";
import { usePush } from "../lib/use-push";
import { AdminCard } from "./admin/AdminCard";
import { ToggleSetting } from "./SettingControls";

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
  const { support, subscribed, busy, error, toggle } = usePush();

  // Nothing at all until the first read finishes. A section that flashes "unsupported" and
  // then becomes a switch is worse than one that appears a moment late.
  if (!support) return null;

  return (
    <AdminCard title="Notifications">
      {/*
        A real switch, through the SAME control the two admin settings use -- a notification
        is on or off for this browser and that is the whole state. It was a text link reading
        "Turn off on this device", which is the shape `ToggleSetting`'s own docstring argues
        against: the words on screen described the state you were NOT in.

        Where push cannot work at all there is nothing to switch, so the sentence stands on
        its own rather than sitting beside a disabled control -- an unavailable feature and a
        feature you have turned off should not look the same.
      */}
      {support.kind === "available" ? (
        <ToggleSetting
          label="Notify this device"
          on={subscribed}
          action={(on) => (on ? "Turn off on this device" : "Turn on for this device")}
          save={async () => {
            await toggle();
          }}
        >
          {subscribed
            ? "This device will be told when something you asked for arrives. One message per request, so a whole season is one notification."
            : "Be told when something you asked for arrives, without keeping finderr open."}
        </ToggleSetting>
      ) : (
        <p className="text-sm text-muted">{UNAVAILABLE[support.kind]}</p>
      )}
      {/*
        `usePush` owns this one rather than the switch: a permission the BROWSER refused never
        reaches the save, so `ToggleSetting`'s own error state would stay empty while nothing
        happened. `busy` is read here for the same reason -- it belongs to the hook.
      */}
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      {busy && <p className="mt-2 text-xs text-muted">One moment…</p>}
    </AdminCard>
  );
}
