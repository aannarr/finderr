/**
 * "Tell me when it lands" -- offered at the one moment somebody would say yes.
 *
 * THE PLACEMENT IS THE FEATURE. Push has been switchable on the account page since it
 * shipped, which is a page nobody visits while waiting for a download: the moment worth
 * asking at is the moment a reader is watching a forty-minute bar move, because that is when
 * "you do not have to keep this open" is an answer to a question they are actually asking.
 * Nothing here is a new subsystem -- `usePush` is the same machine `PushToggle` draws.
 *
 * IT SAYS NOTHING IN EVERY CASE BUT ONE, which is the other half of not being a nag. Already
 * subscribed, no download in flight, a browser that cannot do this, a reader who has said no
 * -- each of those renders nothing at all. `PushToggle` on the account page is where the four
 * unavailable reasons get explained, and explaining them here would put a paragraph about
 * iOS home screens above somebody's downloads.
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
  const { support, subscribed, busy, error, toggle } = usePush();

  // The error outlives `when`: a reader who declined a second ago must be told why nothing
  // happened, even if the download they were watching finished in the meantime.
  if (error) return <p className="text-xs text-danger">{error}</p>;
  if (!when || subscribed || support?.kind !== "available") return null;

  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={busy}
      className="rounded-full border border-line px-3 py-1 text-xs text-muted transition-colors hover:border-accent/50 hover:text-ink disabled:opacity-60"
    >
      {busy ? "One moment…" : "Notify me when it lands"}
    </button>
  );
}
