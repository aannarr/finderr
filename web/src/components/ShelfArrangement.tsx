/**
 * Your front page, arranged: the order of the shelves, the ones you never scroll to, and the
 * way back to the shipped default.
 *
 * The reader-facing half of `/api/shelves/preference`. `src/lib/shelf-preferences.ts` owns
 * what a preference MEANS -- an order and a filter over the page finderr already assembled,
 * never a per-reader assembly -- and this draws it. Nothing here decides which shelves exist.
 *
 * ## AN EDIT IS THE COMMIT. There is no Save button, and removing it was a BUG FIX
 *
 * > [!CAUTION] The Save button was off-screen at the exact moment it appeared, and it was measured
 * > This screen used to hold a DRAFT and render Save in the section header only once the draft
 * > was dirty. Driven in a real browser on 2026-09-07, at the default viewport, pressing "Hide"
 * > on a shelf two thirds of the way down a fifteen-row list put the button that had just
 * > appeared at **`top: -217px`** -- 217 pixels above the fold, on a page the reader had
 * > scrolled to reach the row they were pressing. The row said `· hidden`, nothing said
 * > "unsaved", and navigating away discarded it silently. `shelf_pref` held **zero rows** on
 * > both live deployments, across thirteen accounts, with the feature shipped and working.
 * >
 * > A control that only exists once you cannot see it is not a control. Making it sticky was
 * > the smaller change and it would have kept a two-step commit on a screen whose every edit is
 * > a single toggle or a single swap -- so the fix is that there is nothing left to press.
 *
 * `ToggleSetting` (`SettingControls.tsx`) already commits a boolean on the press, and "Hide" is
 * a boolean. The arrows commit the same way, which is affordable because the PUT carries the
 * WHOLE list and is idempotent: sending it twice leaves the same page, so a run of presses can
 * collapse into one write with nothing lost. `debouncer` from `lib/debounce.ts` is what
 * collapses them -- the same one the search box uses, for the same reason, and reused rather
 * than re-written.
 *
 * ## THE SERVER'S ANSWER IS STILL THE TRUTH, and the draft is still never promoted to it
 *
 * Unchanged by the above, and it is the reason a write answers with the whole catalogue rather
 * than `204`: a genre row can retire with the nightly index build while this screen is open, so
 * a save of nine shelves can legitimately come back as eight -- and a screen that kept drawing
 * its own nine would be lying about what it just stored.
 *
 * The one thing auto-saving adds is that an answer can arrive AFTER the reader has pressed
 * something else, and adopting it then would yank the row back from under their finger.
 * `editSeq` is the guard: every edit bumps it, a write remembers the value it was sent at, and
 * an answer is adopted only if nothing has been edited since. A discarded answer costs nothing
 * -- the edit that discarded it has its own write already queued.
 *
 * ## MOVE BUTTONS, NOT DRAG
 *
 * aannarr asked for "its own order", not for a gesture. Two arrows per row are reachable from a
 * keyboard, from a touch screen and from a mouse without a single line of pointer maths, and
 * they put no drag library on the render path. A drag affordance could be added over this
 * later; a keyboard-only reader could not be added to a drag-only implementation.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getShelfPreference,
  resetShelfPreference,
  type ShelfChoiceView,
  type ShelfPreferencePayload,
  saveShelfPreference,
} from "../lib/api";
import { type Debouncer, debouncer } from "../lib/debounce";
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

/**
 * How still the list must be before an arrangement is worth a round trip.
 *
 * Longer than `SEARCH_DEBOUNCE_MS` (150) on purpose, and the two are answering different
 * questions. A search debounce is racing a typist who is WAITING for the answer, so it buys
 * request reduction at the cost of latency the reader feels. Nobody waits on this one: the row
 * has already moved on screen, the write changes nothing the reader can see, and the only thing
 * a longer window costs is how long the tab must stay open -- which the unmount flush covers
 * anyway. 600ms comfortably swallows a run of arrow presses walking a shelf up a list.
 */
export const SHELF_SAVE_DEBOUNCE_MS = 600;

/** What the header says about the last write. The error is drawn separately, by `useSaving`. */
type SaveState = "idle" | "saving" | "saved";

export function ShelfArrangement() {
  /** What the server holds, as of the last answer. Null until the first load lands. */
  const [stored, setStored] = useState<ShelfPreferencePayload | null>(null);
  /** The list on screen. Ahead of `stored` only for as long as a write is in flight. */
  const [draft, setDraft] = useState<readonly ShelfChoiceView[]>([]);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  /**
   * What just happened, for a reader who cannot see the row move.
   *
   * A live region rather than a focus change, because focus is exactly where it should be --
   * on the arrow that was pressed, ready for the next press. Nothing else on screen announces
   * a reorder: the button's own name does not change when the row under it moves.
   */
  const [announcement, setAnnouncement] = useState("");
  const { busy, error, run } = useSaving();

  /*
    THREE REFS, and each one exists because the debouncer's `emit` is built ONCE and would
    otherwise close over the first render's values forever.

    `storedRef` is what a pending list is compared against, so an edit that puts the page back
    the way the server already has it writes nothing -- which is what stops "hide it, show it
    again" marking an untouched reader as having customised their front page.

    `editSeq` counts EDITS, not writes. A write remembers the count it was sent at and its
    answer is adopted only if that count has not moved; see the header.

    `live` is false after unmount, and the emit path branches on it rather than bailing out --
    an edit made a moment before navigating away must still reach the server, it just has
    nowhere left to draw the answer.
  */
  const storedRef = useRef<ShelfPreferencePayload | null>(null);
  const editSeq = useRef(0);
  const live = useRef(true);

  /**
   * Take the server's answer as the state of the world, and say what it was.
   *
   * ONE OWNER for what a successful read or write means, shared by the first load, the
   * auto-save and the reset -- because all three answer with the whole resolved catalogue and
   * all three must leave the screen describing the server rather than the draft it sent.
   */
  const adopt = useCallback((next: ShelfPreferencePayload, said?: string) => {
    storedRef.current = next;
    setStored(next);
    setDraft(next.shelves);
    if (said) setAnnouncement(said);
  }, []);

  /**
   * Send one arrangement, and adopt the answer unless the reader has moved on.
   *
   * Built once and never rebuilt, so the debouncer below can hold it: everything that would
   * otherwise go stale is read through a ref.
   */
  const commit = useCallback(
    (shelves: readonly ShelfChoiceView[]) => {
      const held = storedRef.current;
      // Nothing to say. The server already holds this exact page, so a write would only
      // record that somebody had pressed two buttons that cancelled out.
      if (held && sameArrangement(shelves, held.shelves)) {
        setSaveState("idle");
        return;
      }
      const sentAt = editSeq.current;
      const write = () => saveShelfPreference(arrangementChoices(shelves));

      // Unmounted: the edit still has to land, and there is nothing left to draw. A rejection
      // here has no home either -- the screen that would have shown it is gone.
      if (!live.current) {
        void write().catch(() => {});
        return;
      }

      run(async () => {
        const answer = await write();
        // Superseded, or gone. Adopting a stale answer would pull a row back from under the
        // finger of a reader who has pressed something since; the edit that superseded it is
        // already queued behind its own debounce.
        if (!live.current || editSeq.current !== sentAt) return;
        adopt(answer);
        setSaveState("saved");
      });
    },
    [run, adopt],
  );

  const saves = useRef<Debouncer<readonly ShelfChoiceView[]> | null>(null);
  saves.current ??= debouncer<readonly ShelfChoiceView[]>(SHELF_SAVE_DEBOUNCE_MS, commit);

  /*
    FLUSH ON UNMOUNT, NEVER CANCEL -- this is the whole point of the change and the one line
    `useDebouncedValue` deliberately does the other way round. There, a pending emit after the
    route has gone would fetch a search result nobody can ever see. Here the pending value IS
    the reader's edit, and dropping it is precisely the bug this screen was reported for.
  */
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      saves.current?.flush();
    };
  }, []);

  useEffect(() => {
    run(async () => adopt(await getShelfPreference()));
  }, [run, adopt]);

  /** One edit: draw it now, say what happened, and queue the write behind the debounce. */
  const edit = (next: readonly ShelfChoiceView[], said: string) => {
    editSeq.current += 1;
    setDraft(next);
    setAnnouncement(said);
    setSaveState("saving");
    saves.current?.push(next);
  };

  const move = (shelf: ShelfChoiceView, direction: ShelfMove) => {
    const next = moveShelf(draft, shelf.id, direction);
    // The list comes back UNCHANGED at either end, so an arrow with nowhere to go says so
    // rather than silently doing nothing -- see `moveShelf` for why it stays pressable. It is
    // not an edit, so it neither bumps the sequence nor queues a write.
    if (next === draft) {
      setAnnouncement(`${shelf.title} is already ${direction === "up" ? "first" : "last"}`);
      return;
    }
    edit(next, `${shelf.title} moved ${direction}, ${next.indexOf(shelf) + 1} of ${next.length}`);
  };

  const toggle = (shelf: ShelfChoiceView) =>
    edit(toggleShelfHidden(draft, shelf.id), shelf.hidden ? `${shelf.title} shown` : `${shelf.title} hidden`);

  /**
   * The reset goes through `adopt` like everything else, and it CANCELS the pending write.
   *
   * Without the cancel, a debounced arrangement queued a moment before the reset would land
   * after it and re-create the preference the reader had just asked to be rid of.
   */
  const reset = async () => {
    editSeq.current += 1;
    saves.current?.cancel();
    adopt(await resetShelfPreference(), "Front page reset");
    setSaveState("idle");
  };

  return (
    <section>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium">Your front page</h2>
        {/*
          A REPORT, never a control. The reader has already committed by pressing the row's own
          button, so this says what became of it and offers nothing to press -- which is what
          makes it safe for it to be up here, out of sight, where a button was not.
        */}
        {saveState !== "idle" && !error && (
          <span className="text-xs text-muted">{busy || saveState === "saving" ? "Saving…" : "Saved"}</span>
        )}
      </div>
      <p className="mt-1 text-xs text-muted">
        The order these shelves appear in on the home page, and the ones you would rather not see. Changes
        save themselves. A shelf added by a later release turns up where it was meant to go, whatever you have
        arranged here.
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
            whenever there is something to put back -- which is now exactly "the server holds an
            arrangement", because every edit is already stored by the time a reader could look
            for this. It used to also cover unsaved edits; there are none any more.

            `ConfirmAction` rather than a bare button: a reset throws away an arrangement that
            took a minute of pressing arrows, and it is the one control here that cannot be
            undone by pressing it again. It is also awaited rather than handed to `useSaving`,
            so its own busy state and its own refusal land on it -- the rule the rest of this
            product follows, that a server's "no" appears on the control that provoked it.
          */}
          {stored.customised && (
            <div className="mt-3">
              <ConfirmAction
                label="Reset to the default order"
                question="Put the front page back the way it ships?"
                confirmLabel="Yes, reset"
                busyLabel="Resetting…"
                onConfirm={reset}
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
