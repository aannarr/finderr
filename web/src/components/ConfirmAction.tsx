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
import { LINK_BUTTON } from "../lib/ui";

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

  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      {asking ? (
        <>
          <span className="text-xs text-muted">{question}</span>
          <button type="button" onClick={confirm} disabled={busy} className={LINK_BUTTON}>
            {busy ? busyLabel : confirmLabel}
          </button>
          <button type="button" onClick={() => setAsking(false)} disabled={busy} className={LINK_BUTTON}>
            {cancelLabel}
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setAsking(true)}
            className={danger ? `${LINK_BUTTON} text-danger hover:text-danger` : LINK_BUTTON}
          >
            {label}
          </button>
          {children}
        </>
      )}
      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  );
}
