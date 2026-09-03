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
import type { SeasonGap } from "../lib/season-gap";
import {
  allSeasonNumbers,
  defaultSelection,
  episodesInSelection,
  fillSelection,
  isEverySeason,
  missingInSeason,
  summariseSeasons,
  toggleSeason,
} from "../lib/season-select";
import { ToggleChip } from "./Chip";
import { useChipGroup } from "./RovingFocus";

export interface SeasonRequestDialogProps {
  open: boolean;
  seasons: readonly Season[];
  title: string;
  /**
   * Where the series stands, season by season. Present ONLY for a series Sonarr already
   * holds, and its presence is what puts the dialog in FILL mode.
   *
   * The two modes are the same control over the same nouns and differ in three things: what
   * is ticked when it opens (every season vs the seasons with a hole), what a chip's number
   * means (how many episodes the season HAS vs how many we are MISSING), and what the confirm
   * button promises (monitor vs search). Everything else -- the roving focus, the specials
   * rule, the run-collapsing summary -- is one implementation, because it is one dialog.
   */
  gap?: readonly SeasonGap[];
  onCancel: () => void;
  /** Called with the chosen season numbers. Never called with an empty list. */
  onConfirm: (seasons: number[]) => void;
}

export function SeasonRequestDialog({
  open,
  seasons,
  title,
  gap,
  onCancel,
  onConfirm,
}: SeasonRequestDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const ordered = orderSeasons([...seasons]);
  /*
    PRESENT-BUT-EMPTY IS STILL FILL MODE, and the distinction is not pedantic. The header
    control that opens this is driven by the episode mirror, which is local; the gap needs
    the `episodes` facet, which is not. So a reader can open the chooser in the half second
    before the facet lands, and `[]` is what they get. Treating that as ADD mode would
    promise to "monitor" a series Sonarr already has and then 409 on confirm.
  */
  const filling = gap !== undefined;
  const [chosen, setChosen] = useState<number[]>(() => openingSelection(seasons, gap));

  /*
    Nine seasons is nine tab stops between the heading and the Cancel button, so the
    tick-boxes are ONE and ← → move within them.

    Focus does NOT choose: this is the multi-select case, so an arrow walk with selection
    following would tick or untick every box it passed over. `ToggleChip` is a real button,
    so Space still ticks the one under focus.

    > [!IMPORTANT] The roving tabindex cannot move where `showModal()` puts focus, and the
    > reason is `defaultSelection` rather than luck
    > A modal dialog focuses its first tabbable descendant, and a roving group makes that
    > the CHOSEN chip rather than the first one. Here they are always the same element: the
    > selection is reset to `defaultSelection` on every open, which ticks every real season,
    > and the specials sort last -- so chip 0 is ticked, and it is the tab stop. A series
    > that is nothing but specials ticks nothing, and `rovingStopIndex` answers 0 for that
    > too. Verified on screen, because "the browser owns focus here" is exactly the kind of
    > claim a green test suite cannot make.
  */
  const chips = useChipGroup<HTMLFieldSetElement>();

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
      setChosen(openingSelection(seasons, gap));
      if (!el.open) el.showModal();
    } else if (el.open) {
      el.close();
    }
  }, [open, seasons, gap]);

  const everything = isEverySeason(chosen, ordered);
  const nothing = chosen.length === 0;
  const episodes = gap ? episodesInSelection(gap, chosen) : 0;

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
            {nothing
              ? "Pick at least one season."
              : filling
                ? `Sonarr will search for ${episodeCount(episodes)} of ${summariseSeasons(chosen)}.`
                : `Sonarr will monitor ${summariseSeasons(chosen)}.`}
          </p>
        </div>

        {/*
          A real <fieldset>, not a div wearing role="group": these toggles are inside a
          form, which is exactly the case the element exists for, and it gets the
          grouping announced without an aria attribute doing the work.
        */}
        <fieldset ref={chips.ref} onKeyDown={chips.onKeyDown} className="flex flex-wrap gap-1.5 border-0 p-0">
          <legend className="sr-only">Seasons to request</legend>
          {ordered.map((s) => (
            <ToggleChip
              key={s.number}
              label={seasonLabel(s)}
              /*
                The number changes meaning with the mode, and the line under the row says
                which one it is. In fill mode a season we hold in full wears NO number --
                "0" reads as a count rather than as the absence of a hole, and the seasons
                worth ticking being the ones wearing a figure is what makes the row
                scannable without reading anything.
              */
              count={gap ? missingInSeason(gap, s.number) : (s.episodeCount ?? undefined)}
              active={chosen.includes(s.number)}
              onClick={() => setChosen((c) => toggleSeason(c, s.number))}
            />
          ))}
        </fieldset>

        {filling && (
          <p className="-mt-2 text-xs text-muted">Numbers are the aired episodes we do not have.</p>
        )}

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
              /*
                In fill mode a selection of complete seasons has nothing to fetch, and the
                server refuses it with a 409. Refusing it here instead means the reader is
                told before they press rather than by a red toast afterwards.
              */
              disabled={nothing || (filling && episodes === 0)}
              className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-black
                         transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {filling ? `Request ${episodeCount(episodes)}` : `Request ${summariseSeasons(chosen)}`}
            </button>
          </div>
        </div>
      </form>
    </dialog>
  );
}

/**
 * What is ticked when the dialog opens, which is the one thing the two modes disagree about
 * before the reader touches anything.
 *
 * Kept out of the component because it is a decision rather than markup, and because the
 * roving-focus note above depends on it. That note still holds in fill mode, for a better
 * reason than it holds in add mode: the tab stop is the FIRST TICKED chip
 * (`rovingStopIndex` reads `aria-pressed` off the rendered buttons), and fill mode ticks
 * exactly the seasons with a hole -- so `showModal()` lands focus on the first season the
 * reader is actually being offered, rather than on a complete season they cannot use.
 */
function openingSelection(seasons: readonly Season[], gap: readonly SeasonGap[] | undefined): number[] {
  return gap ? fillSelection(gap) : defaultSelection(seasons);
}

/** "85 episodes" / "1 episode" -- the noun the two labels and the sentence all share. */
function episodeCount(n: number): string {
  return `${n} episode${n === 1 ? "" : "s"}`;
}
