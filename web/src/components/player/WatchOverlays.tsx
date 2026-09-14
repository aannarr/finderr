/**
 * What the player says about the reader's own history: "you were here", and "this is next".
 *
 * Both are CARDS over the frame rather than chrome, because they are about the reader rather
 * than about the controls -- they show whether or not the pointer moved, and they leave on their
 * own. Placed bottom-left and bottom-right above the bar so neither covers the centre of the
 * picture or the other.
 */

import { useEffect, useRef, useState } from "react";
import { clock } from "../../lib/playback-report";
import { realTimers, type Timers } from "../../lib/timers";
import { cn } from "../../lib/utils";

/** How long "Resumed at" stays up. Long enough to read and reach, short enough to be forgotten. */
export const RESUME_TOAST_MS = 8_000;
/** The up-next card appears this close to the end, which is where end credits usually start. */
export const UP_NEXT_LEAD_SEC = 20;
/** Seconds of "Playing in N s" once an episode has actually ended. */
export const UP_NEXT_COUNTDOWN_SEC = 10;

const CARD =
  "rounded-xl bg-surface/95 text-sm ring-1 ring-line shadow-[0_8px_28px_rgba(0,0,0,.55)] backdrop-blur";
const GHOST =
  "rounded-md px-2.5 py-1.5 font-medium text-muted outline-none hover:bg-surface-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-accent";

/** "Resumed at 42:10 · Start over", for a few seconds after a resumed start. */
export function ResumeToast({
  at,
  onStartOver,
  timers = realTimers,
}: {
  at: number;
  onStartOver: () => void;
  timers?: Timers;
}) {
  const [shown, setShown] = useState(true);
  useEffect(() => {
    const handle = timers.set(() => setShown(false), RESUME_TOAST_MS);
    return () => timers.clear(handle);
  }, [timers]);
  if (!shown) return null;
  return (
    <div
      role="status"
      className={`absolute bottom-28 left-4 z-10 flex items-center gap-3 py-2 pr-2 pl-3 sm:left-6 ${CARD}`}
    >
      <span>
        Resumed at <span className="tabular-nums">{clock(at)}</span>
      </span>
      <button
        type="button"
        // Merged rather than appended: `GHOST` carries `text-muted`, which won the cascade over a
        // trailing `text-accent` and drew the one action in grey (read off Chromium).
        className={cn(GHOST, "text-accent hover:text-accent")}
        onClick={() => {
          onStartOver();
          setShown(false);
        }}
      >
        Start over
      </button>
    </div>
  );
}

/**
 * "Up next", in the last seconds of an episode and at its end.
 *
 * It appears in the credits without doing anything -- somebody still reading them loses nothing --
 * and only once the episode has ENDED does it count down and play. Cancel dismisses it for this
 * episode; the key is the episode, so the next one gets its own card.
 */
export function UpNext({
  label,
  remainingSec,
  ended,
  onPlay,
  timers = realTimers,
}: {
  label: string;
  remainingSec: number;
  ended: boolean;
  onPlay: () => void;
  timers?: Timers;
}) {
  const [dismissed, setDismissed] = useState(false);
  const [left, setLeft] = useState(UP_NEXT_COUNTDOWN_SEC);
  const play = useRef(onPlay);
  play.current = onPlay;

  useEffect(() => {
    if (!ended || dismissed) return;
    let n = UP_NEXT_COUNTDOWN_SEC;
    setLeft(n);
    let handle: unknown = null;
    const step = () => {
      handle = timers.set(() => {
        n -= 1;
        setLeft(n);
        if (n <= 0) play.current();
        else step();
      }, 1_000);
    };
    step();
    return () => timers.clear(handle);
  }, [ended, dismissed, timers]);

  const near = Number.isFinite(remainingSec) && remainingSec <= UP_NEXT_LEAD_SEC;
  if (dismissed || !(ended || near)) return null;

  return (
    <section aria-label="Up next" className={`absolute right-4 bottom-28 z-10 w-72 p-4 sm:right-6 ${CARD}`}>
      <p className="text-xs font-medium text-muted">Up next</p>
      <p className="mt-0.5 truncate font-medium text-ink">{label}</p>
      {ended ? (
        <p className="mt-1 text-muted tabular-nums" aria-live="polite">
          Playing in {left} s
        </p>
      ) : null}
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" className={GHOST} onClick={() => setDismissed(true)}>
          Cancel
        </button>
        <button
          type="button"
          className="rounded-md bg-accent px-2.5 py-1.5 font-semibold text-black outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ink"
          onClick={() => play.current()}
        >
          Play now
        </button>
      </div>
    </section>
  );
}
