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
  onAsk,
  onConfirm,
  danger = false,
  variant = "panel",
  onAskingChange,
  children,
}: {
  /** The verb, as it reads before anybody has pressed anything: "Remove", "Revoke". */
  label: string;
  /**
   * What is asked once they have: "Remove this account?"
   *
   * A NODE and not a string, because one caller has to show WHAT it is about to delete --
   * the file count, the size, whether Plex still holds it, and the choice of whether the
   * files go. A confirmation that can only say "are you sure" is not a confirmation for a
   * destructive act against a real filesystem. Six of the seven callers pass a sentence and
   * are unaffected; widening the prop was the alternative to a second confirmation component
   * that would have re-implemented the guard, the busy lock and the error slot.
   */
  question: ReactNode;
  /** The way OUT of the question, and it repeats the verb: "Yes, remove". */
  confirmLabel: string;
  /** While the work is in flight. Present tense: "Removing…". */
  busyLabel: string;
  cancelLabel?: string;
  /**
   * Called when the reader ARMS the control, before they have confirmed anything.
   *
   * For a question whose facts have to be fetched: asking is the first moment the answer is
   * wanted, and gathering it on mount would cost every row on the page a request nobody asked
   * for. It must not do anything destructive -- the reader has said "tell me more", not "yes".
   */
  onAsk?: () => void;
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
  /**
   * Where this control lives, which decides what the ASKED state looks like.
   *
   * > [!IMPORTANT] `inline` exists because the panel shape breaks a row, and visibly
   * > A `panel` confirmation is a bordered block that appears where the button was, which is
   * > right in a card of stacked verbs -- the page behind is unchanged, one region has
   * > changed, and the two answers are told apart by shape. Put that same block inside a LIST
   * > ROW and it triples the row's height and shoves every row below it down the page: the
   * > thing you are about to destroy jumps out from under the cursor at the exact moment you
   * > are being asked to confirm destroying it.
   * >
   * > `inline` swaps the two answers into the row's own action column (`ACTION_COL`, same
   * > width) and hands the question to the caller to draw on the row's metadata line. Nothing
   * > moves, and the row still reads as the row you were pointing at.
   */
  variant?: "panel" | "inline";
  /**
   * Told what is being asked, so a ROW can put the question on its own metadata line.
   *
   * The `inline` variant draws no question of its own -- there is nowhere in an action column
   * to put a sentence -- so the row owns it. This is how the row knows to swap `meta` for
   * `question` at the same moment the buttons change.
   */
  onAskingChange?: (asking: boolean) => void;
  /** Anything to sit beside the resting verb, such as what the action last produced. */
  children?: ReactNode;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * One place that moves the asking flag, so the caller is told every time -- including the
   * `finally` below, where the control returns to rest on its own.
   *
   * A row that swapped its metadata line for the question and never swapped it back would be
   * left describing a decision that has already been taken.
   */
  const ask = (next: boolean) => {
    setAsking(next);
    onAskingChange?.(next);
    // ARMING is where `onAsk` fires, and it is here rather than on the resting button so
    // every path that arms this control reports it. It must do nothing destructive: the
    // reader has said "tell me more", not "yes".
    if (next) onAsk?.();
  };

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
      ask(false);
      setBusy(false);
    }
  };

  /*
    THE ASKED STATE, in two shapes. Everything above this line is shared.

    INLINE is exactly the two answers, in the space the one button occupied -- no box and no
    question, because the ROW draws the question on its own metadata line the moment
    `onAskingChange(true)` fires. The confirming verb is `destructive` even where the resting
    one was not: in a row there is no tinted panel to carry that signal, so the button has to.

    PANEL is a bordered block, and it is right in a card of stacked verbs. It was three items
    on one baseline before, which put "Remove this account for good?" at the same weight as
    the word beside it and left the confirming verb looking exactly like the cancel. Boxing it
    is what makes a screenshot legible: the page behind is unchanged, one region has changed,
    and the two answers are told apart by shape rather than by reading them. `danger` tints
    the box as well as the verb, so the one action that destroys something announces itself
    before it is read.
  */
  if (asking && variant === "inline") {
    return (
      <>
        <Button type="button" size="sm" variant="destructive" onClick={confirm} disabled={busy}>
          {busy ? busyLabel : confirmLabel}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => ask(false)} disabled={busy}>
          {cancelLabel}
        </Button>
        {/*
          A refusal is the ONE thing allowed to change a row's height, and only while it is on
          screen. Everything this variant does is to stop the page moving under the cursor
          during a confirmation -- but a save that was refused is exactly when a reader should
          be jolted into looking, and there is nowhere in an action column to put a sentence
          without one.
        */}
        {error && <span className="w-full text-right text-xs text-danger">{error}</span>}
      </>
    );
  }

  if (asking) {
    return (
      <div
        className={`flex flex-col gap-2 rounded-lg border p-3 ${
          danger ? "border-danger/40 bg-danger/5" : "border-line bg-surface-2/40"
        }`}
      >
        {/*
          A rich question is a BLOCK and a sentence is a line. One caller shows what it is
          about to delete -- the file count, the size, whether Plex still holds it -- and that
          needs its own room; `typeof` rather than a second prop, because the layout follows
          from what was passed and there is nothing for a caller to get wrong.
        */}
        {typeof question === "string" ? (
          <p className="text-sm text-ink">{question}</p>
        ) : (
          <div className="text-sm text-ink">{question}</div>
        )}
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
          <Button type="button" size="sm" variant="ghost" onClick={() => ask(false)} disabled={busy}>
            {cancelLabel}
          </Button>
          {error && <span className="text-xs text-danger">{error}</span>}
        </div>
      </div>
    );
  }

  /*
    AT REST. `inline` is a FRAGMENT rather than a wrapper: it sits inside the row's own
    `ACTION_COL`, which already owns the flex, the gap and the alignment. A div here would be
    a second box inside that one and would break the alignment it exists to provide.
  */
  const resting = (
    <Button
      type="button"
      size="sm"
      // OUTLINE for the ordinary verbs and DESTRUCTIVE for the one that destroys, rather
      // than colouring all of them: a row of red is the same wall of identical controls
      // the confirmation exists to break up.
      variant={danger ? "destructive" : "outline"}
      onClick={() => ask(true)}
    >
      {label}
    </Button>
  );

  if (variant === "inline") {
    return (
      <>
        {resting}
        {children}
        {error && <span className="w-full text-right text-xs text-danger">{error}</span>}
      </>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {resting}
      {children}
      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  );
}
