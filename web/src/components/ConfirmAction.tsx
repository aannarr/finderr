/**
 * A destructive verb that takes two clicks: press it, then say yes.
 *
 * > [!IMPORTANT] The confirmation is INLINE, and it is not `window.confirm`
 * > A native dialog cannot be styled, cannot be dismissed by keyboard the way the rest of
 * > this app can, is suppressible by the browser, and is invisible to a test -- jsdom does
 * > not implement it. Swapping the button for its own "Remove? Yes / Cancel" pair costs one
 * > piece of state and makes the guard a thing that can be asserted.
 *
 * Lifted out of `WithdrawControl`, which had this exact shape and was about to be copied six
 * times onto the admin user page. What differs between those seven is the WORDING and the
 * work, so both are props; the state machine, the busy lock and where the error lands are
 * the same in every one of them, and were the part that would have drifted.
 *
 * The failure is shown BESIDE the control rather than raised as a toast, because it is a
 * fact about this one action -- "that is the last admin" -- and the reader is looking
 * straight at it.
 */

import { type ReactNode, useState } from "react";
import { Button } from "./ui/button";

export function ConfirmAction({
  label,
  question,
  confirmLabel,
  busyLabel,
  cancelLabel = "Cancel",
  onConfirm,
  danger = false,
  children,
}: {
  /** The verb, as it reads before anybody has pressed anything: "Remove", "Revoke". */
  label: string;
  /** What is asked once they have: "Remove this account?" */
  question: string;
  /** The way OUT of the question, and it repeats the verb: "Yes, remove". */
  confirmLabel: string;
  /** While the work is in flight. Present tense: "Removing…". */
  busyLabel: string;
  cancelLabel?: string;
  /** Rejecting shows the message and returns to the unasked state, so it can be retried. */
  onConfirm: () => Promise<void>;
  /**
   * Draw the resting verb in the danger colour.
   *
   * For the one action per screen that DESTROYS something. Colouring all of them would
   * make none of them stand out -- a row of red is the same wall of identical buttons the
   * confirmation exists to break up.
   */
  danger?: boolean;
  /** Anything to sit beside the resting verb, such as what the action last produced. */
  children?: ReactNode;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      /*
        BACK TO THE RESTING VERB EITHER WAY, and on SUCCESS it is not cosmetic.

        Several of these controls flip their label once the work lands -- "Disable this
        account" becomes "Enable this account". Left in the asking state, the button that
        was under the cursor a moment ago now reads "Yes, enable": a primed confirmation for
        the OPPOSITE action, one click from undoing what just happened, with nothing asking
        first. That is the unconfirmed click these controls exist to remove, reintroduced by
        the control itself. Measured in a browser, 2026-09-06.
      */
      setAsking(false);
      setBusy(false);
    }
  };

  /*
    THE QUESTION IS A PANEL, not a sentence wedged between two links.

    It was three inline items on one baseline, which put "Remove this account for good?" in
    the same visual weight as the word beside it and left the confirming verb looking exactly
    like the cancel. Boxing the asked state is what makes a screenshot of it legible: the page
    behind is unchanged, one region has changed, and the two answers are told apart by shape
    rather than by reading them. `danger` tints the box as well as the verb, so the one action
    that destroys something announces itself before it is read.
  */
  if (asking) {
    return (
      <div
        className={`flex flex-col gap-2 rounded-lg border p-3 ${
          danger ? "border-danger/40 bg-danger/5" : "border-line bg-surface-2/40"
        }`}
      >
        <p className="text-sm text-ink">{question}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant={danger ? "destructive" : "default"}
            onClick={confirm}
            disabled={busy}
          >
            {busy ? busyLabel : confirmLabel}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setAsking(false)} disabled={busy}>
            {cancelLabel}
          </Button>
          {error && <span className="text-xs text-danger">{error}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Button
        type="button"
        size="sm"
        // OUTLINE for the ordinary verbs and DESTRUCTIVE for the one that destroys, rather
        // than colouring all of them: a row of red is the same wall of identical controls
        // the confirmation exists to break up.
        variant={danger ? "destructive" : "outline"}
        onClick={() => setAsking(true)}
      >
        {label}
      </Button>
      {children}
      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  );
}
