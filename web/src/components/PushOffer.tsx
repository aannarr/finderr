/**
 * "Tell me when it lands" -- offered at the one moment somebody would say yes, and offered
 * ONCE.
 *
 * THE PLACEMENT IS THE FEATURE. Push has been switchable on the account page since it
 * shipped, which is a page nobody visits while waiting for a download: the moment worth
 * asking at is the moment a reader is watching a forty-minute bar move, because that is when
 * "you do not have to keep this open" is an answer to a question they are actually asking.
 * Nothing here is a new subsystem -- `usePush` is the same machine `PushToggle` draws.
 *
 * > [!IMPORTANT] ONCE PER PERSON, NOT ONCE PER PAGE VIEW -- aannarr, 2026-09-07
 * > *"make sure we NEVER repeat -- so once only"*. `offered` is a column on the ACCOUNT, so
 * > answering it on a phone silences it on a laptop, and it is set by every answer there is:
 * > subscribing, declining the browser's prompt, or pressing "No thanks" here. There is
 * > deliberately no way back to this offer -- `PushToggle` on the account page is where a
 * > decision gets changed, and it is always there.
 *
 * IT SAYS NOTHING IN EVERY CASE BUT ONE, which is the other half of not being a nag. Already
 * subscribed, already asked, no download in flight, a browser that cannot do this, a reader
 * who has said no -- each of those renders nothing at all. `PushToggle` on the account page
 * is where the four unavailable reasons get explained, and explaining them here would put a
 * paragraph about iOS home screens above somebody's downloads.
 *
 * A REFUSAL IS SHOWN and is the one thing that survives a false `when`. The browser will not
 * ask twice on its own, so a reader who taps this and then declines at the system prompt is
 * owed the sentence saying so -- silently reverting to the offer would read as a dead button.
 */

import { usePush } from "../lib/use-push";

export function PushOffer({
  /**
   * Is there something worth being told about? The CALLER decides, because what counts as
   * "in flight" is the request list's rule (`hasWorkInFlight`) and not this component's.
   */
  when,
}: {
  when: boolean;
}) {
  const { support, subscribed, offered, busy, error, toggle, dismiss } = usePush();

  // The error outlives `when`: a reader who declined a second ago must be told why nothing
  // happened, even if the download they were watching finished in the meantime.
  if (error) return <p className="text-xs text-danger">{error}</p>;
  if (!when || subscribed || offered || support?.kind !== "available") return null;

  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={busy}
        className="rounded-full border border-line px-3 py-1 text-xs text-muted transition-colors hover:border-accent/50 hover:text-ink disabled:opacity-60"
      >
        {busy ? "One moment…" : "Notify me when it lands"}
      </button>
      {/*
        THE WAY TO SAY NO WITHOUT ANSWERING A SYSTEM PROMPT, and it must be here rather than
        implied by ignoring the offer. Without it the only way to stop being asked is to open
        the browser's permission dialog and refuse -- which is a heavier, scarier and more
        permanent act than the question deserves, and it is the reason "no thanks" is the
        word rather than "not now": pressing it is final, and the label should not suggest
        otherwise.
      */}
      {!busy && (
        <button
          type="button"
          onClick={() => void dismiss()}
          className="text-xs text-muted underline decoration-line underline-offset-2 transition-colors hover:text-ink"
        >
          No thanks
        </button>
      )}
    </span>
  );
}
