/**
 * Your front page, arranged: the order of the shelves, the ones you never scroll to, and the
 * way back to the shipped default.
 *
 * The reader-facing half of `/api/shelves/preference`. `src/lib/shelf-preferences.ts` owns
 * what a preference MEANS -- an order and a filter over the page finderr already assembled,
 * never a per-reader assembly -- and this draws it. Nothing here decides which shelves exist.
 *
 * ## THE SERVER'S ANSWER IS THE TRUTH, and the draft is never promoted to it
 *
 * Every write answers with the whole resolved catalogue, and that answer replaces the list on
 * screen. It has to: a genre row can retire with the nightly index build while this screen is
 * open, so a save of nine shelves can legitimately come back as eight -- and a screen that
 * kept drawing its own nine would be lying about what it just stored.
 *
 * ## MOVE BUTTONS, NOT DRAG
 *
 * aannarr asked for "its own order", not for a gesture. Two arrows per row are reachable from a
 * keyboard, from a touch screen and from a mouse without a single line of pointer maths, and
 * they put no drag library on the render path. A drag affordance could be added over this
 * later; a keyboard-only reader could not be added to a drag-only implementation.
 */

import { useCallback, useEffect, useState } from "react";
import {
  getShelfPreference,
  resetShelfPreference,
  type ShelfChoiceView,
  type ShelfPreferencePayload,
  saveShelfPreference,
} from "../lib/api";
import {
  arrangementChoices,
  moveShelf,
  type ShelfMove,
  sameArrangement,
  toggleShelfHidden,
} from "../lib/shelf-arrangement";
import { LINK_BUTTON } from "../lib/ui";
import { useSaving } from "../lib/use-saving";
import { ConfirmAction } from "./ConfirmAction";

export function ShelfArrangement() {
  /** What the server holds, as of the last answer. Null until the first load lands. */
  const [stored, setStored] = useState<ShelfPreferencePayload | null>(null);
  /** The list being edited. Identical to `stored.shelves` until the reader touches something. */
  const [draft, setDraft] = useState<readonly ShelfChoiceView[]>([]);
  /**
   * What just happened, for a reader who cannot see the row move.
   *
   * A live region rather than a focus change, because focus is exactly where it should be --
   * on the arrow that was pressed, ready for the next press. Nothing else on screen announces
   * a reorder: the button's own name does not change when the row under it moves.
   */
  const [announcement, setAnnouncement] = useState("");
  const { busy, error, run } = useSaving();

  /**
   * Take the server's answer as the state of the world, and say what it was.
   *
   * ONE OWNER for what a successful write means, shared by the first load, the save and the
   * reset -- because all three answer with the whole resolved catalogue and all three must
   * leave the screen describing the server rather than the draft it sent.
   */
  const adopt = useCallback((next: ShelfPreferencePayload, said?: string) => {
    setStored(next);
    setDraft(next.shelves);
    if (said) setAnnouncement(said);
  }, []);

  /** A write whose refusal belongs on the header's own Save button. See `useSaving`. */
  const apply = useCallback(
    (work: () => Promise<ShelfPreferencePayload>, said?: string) => {
      run(async () => adopt(await work(), said));
    },
    [run, adopt],
  );

  useEffect(() => {
    apply(getShelfPreference);
  }, [apply]);

  const edit = (next: readonly ShelfChoiceView[], said: string) => {
    setDraft(next);
    setAnnouncement(said);
  };

  const move = (shelf: ShelfChoiceView, direction: ShelfMove) => {
    const next = moveShelf(draft, shelf.id, direction);
    // The list comes back UNCHANGED at either end, so an arrow with nowhere to go says so
    // rather than silently doing nothing -- see `moveShelf` for why it stays pressable.
    if (next === draft) {
      setAnnouncement(`${shelf.title} is already ${direction === "up" ? "first" : "last"}`);
      return;
    }
    edit(next, `${shelf.title} moved ${direction}, ${next.indexOf(shelf) + 1} of ${next.length}`);
  };

  const toggle = (shelf: ShelfChoiceView) =>
    edit(toggleShelfHidden(draft, shelf.id), shelf.hidden ? `${shelf.title} shown` : `${shelf.title} hidden`);

  const dirty = stored !== null && !sameArrangement(draft, stored.shelves);

  return (
    <section>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium">Your front page</h2>
        {dirty && (
          <button
            type="button"
            disabled={busy}
            onClick={() => apply(() => saveShelfPreference(arrangementChoices(draft)), "Front page saved")}
            className={LINK_BUTTON}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        )}
      </div>
      <p className="mt-1 text-xs text-muted">
        The order these shelves appear in on the home page, and the ones you would rather not see. A shelf
        added by a later release turns up where it was meant to go, whatever you have arranged here.
      </p>

      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
      {stored === null && !error && <p className="mt-2 text-sm text-muted">Loading…</p>}

      {stored !== null && (
        <>
          <ul className="mt-3 flex flex-col gap-2">
            {draft.map((shelf, i) => (
              <li
                key={shelf.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface px-3 py-2"
              >
                <span className={`min-w-0 truncate text-sm${shelf.hidden ? " text-muted" : ""}`}>
                  {shelf.title}
                  {shelf.hidden && <span className="text-muted"> · hidden</span>}
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  <MoveButton shelf={shelf} direction="up" atEnd={i === 0} onMove={() => move(shelf, "up")} />
                  <MoveButton
                    shelf={shelf}
                    direction="down"
                    atEnd={i === draft.length - 1}
                    onMove={() => move(shelf, "down")}
                  />
                  <button
                    type="button"
                    onClick={() => toggle(shelf)}
                    aria-label={`${shelf.hidden ? "Show" : "Hide"} ${shelf.title}`}
                    className={LINK_BUTTON}
                  >
                    {shelf.hidden ? "Show" : "Hide"}
                  </button>
                </span>
              </li>
            ))}
          </ul>

          {/*
            The way out, and the reason arranging is safe to experiment with. It is drawn
            whenever there is something to put back -- a saved arrangement, or unsaved edits --
            and not on a page nobody has touched, where it would offer to undo nothing.

            `ConfirmAction` rather than a bare button: a reset throws away an arrangement that
            took a minute of pressing arrows, and it is the one control here that cannot be
            undone by pressing it again. It is also awaited rather than handed to `useSaving`,
            so its own busy state and its own refusal land on it -- the rule the rest of this
            product follows, that a server's "no" appears on the control that provoked it.
          */}
          {(stored.customised || dirty) && (
            <div className="mt-3">
              <ConfirmAction
                label="Reset to the default order"
                question="Put the front page back the way it ships?"
                confirmLabel="Yes, reset"
                busyLabel="Resetting…"
                onConfirm={async () => adopt(await resetShelfPreference(), "Front page reset")}
              />
            </div>
          )}
        </>
      )}

      {/*
        `aria-live` on an element that is present from the FIRST render. A region added to the
        DOM at the same moment it gains text is one screen readers routinely miss, so it draws
        empty and stays put.
      */}
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </section>
  );
}

/**
 * One arrow, which stays pressable at the end of the list.
 *
 * `aria-disabled` and NOT `disabled`, deliberately: a `disabled` button is dropped from the tab
 * order the instant it becomes disabled, so moving a shelf to the top would blow focus back to
 * `<body>` and strand a keyboard reader halfway through arranging their page. Announcing the
 * state and making the press a no-op keeps the caret where the reader left it.
 */
function MoveButton({
  shelf,
  direction,
  atEnd,
  onMove,
}: {
  shelf: ShelfChoiceView;
  direction: ShelfMove;
  /** Is this shelf already as far this way as it goes? */
  atEnd: boolean;
  onMove: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onMove}
      aria-disabled={atEnd}
      aria-label={`Move ${shelf.title} ${direction}`}
      className={`text-sm ${atEnd ? "text-line" : "text-muted hover:text-ink"}`}
    >
      <span aria-hidden="true">{direction === "up" ? "↑" : "↓"}</span>
    </button>
  );
}
