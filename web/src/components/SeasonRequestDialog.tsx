/**
 * Choose which seasons to request, before anything is queued.
 *
 * WHY A DIALOG AND NOT AN INLINE PANEL. The Request button lives in the title header,
 * and the header rule (`TitleRoute.tsx`) is that nothing arriving late may push it
 * around -- the header is the local half and is on screen at t=0. A season chooser is
 * driven by the `seasons` facet, which arrives whenever it arrives. Drawn inline it
 * would reflow the header under the reader's cursor the moment the facet landed. A
 * dialog opens only on a click that has already happened, so it cannot move anything.
 *
 * Native `<dialog>` rather than a hand-rolled overlay: focus trapping, `Escape`, inert
 * background and the top layer are all browser behaviour, and every hand-rolled version
 * of those is worse. `showModal()` is what arms them -- rendering the element with an
 * `open` attribute instead gives a non-modal dialog and none of the above.
 */

import { useEffect, useRef, useState } from "react";
import { orderSeasons, seasonLabel } from "../lib/facet-panes";
import type { Season } from "../lib/facets";
import {
  allSeasonNumbers,
  defaultSelection,
  isEverySeason,
  summariseSeasons,
  toggleSeason,
} from "../lib/season-select";
import { ToggleChip } from "./Chip";

export interface SeasonRequestDialogProps {
  open: boolean;
  seasons: readonly Season[];
  title: string;
  onCancel: () => void;
  /** Called with the chosen season numbers. Never called with an empty list. */
  onConfirm: (seasons: number[]) => void;
}

export function SeasonRequestDialog({ open, seasons, title, onCancel, onConfirm }: SeasonRequestDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const ordered = orderSeasons([...seasons]);
  const [chosen, setChosen] = useState<number[]>(() => defaultSelection(seasons));

  /*
    Reset on every OPEN rather than once on mount. The dialog stays mounted between
    openings, so a reader who deselected everything, cancelled, and came back would
    otherwise find their abandoned selection still there -- stale state wearing the
    look of a fresh default.
  */
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open) {
      setChosen(defaultSelection(seasons));
      if (!el.open) el.showModal();
    } else if (el.open) {
      el.close();
    }
  }, [open, seasons]);

  const everything = isEverySeason(chosen, ordered);
  const nothing = chosen.length === 0;

  return (
    <dialog
      ref={ref}
      // `Escape` closes a native dialog without telling React, so the parent's `open`
      // would stay true and the dialog could never be reopened. `onClose` fires for
      // every route out -- Escape, close(), the backdrop -- so it is the one place to
      // put this rather than an Escape key handler.
      onClose={onCancel}
      onCancel={onCancel}
      className="m-auto w-full max-w-md rounded-xl border border-line bg-surface p-0 text-ink
                 backdrop:bg-black/60"
    >
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (!nothing) onConfirm(chosen);
        }}
        className="flex flex-col gap-4 p-5"
      >
        <div>
          <h2 className="text-base font-medium">Request {title}</h2>
          {/*
            The reader is told what happens on Enter before they press it, and the
            sentence updates as they tick. "all seasons" is a real answer here, not an
            absence -- see `summariseSeasons`.
          */}
          <p className="mt-1 text-sm text-muted">
            {nothing ? "Pick at least one season." : `Sonarr will monitor ${summariseSeasons(chosen)}.`}
          </p>
        </div>

        {/*
          A real <fieldset>, not a div wearing role="group": these toggles are inside a
          form, which is exactly the case the element exists for, and it gets the
          grouping announced without an aria attribute doing the work.
        */}
        <fieldset className="flex flex-wrap gap-1.5 border-0 p-0">
          <legend className="sr-only">Seasons to request</legend>
          {ordered.map((s) => (
            <ToggleChip
              key={s.number}
              label={seasonLabel(s)}
              count={s.episodeCount ?? undefined}
              active={chosen.includes(s.number)}
              onClick={() => setChosen((c) => toggleSeason(c, s.number))}
            />
          ))}
        </fieldset>

        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => setChosen(everything ? [] : allSeasonNumbers(ordered))}
            className="text-xs text-muted underline hover:text-ink"
          >
            {everything ? "Clear all" : "Select all"}
          </button>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg border border-line px-3 py-1.5 text-sm text-muted hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={nothing}
              className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-black
                         transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              Request {summariseSeasons(chosen)}
            </button>
          </div>
        </div>
      </form>
    </dialog>
  );
}
