/**
 * The timeline: played, every buffered range, where the pointer is, and a drag that scrubs.
 *
 * Drawn per the comp (`.claude/docs/player-comp/`): 4px at rest, 6px under the pointer, the
 * thumb only while hovered, focused or dragged -- a thin bar respects the film, a fat one under
 * the pointer respects the hand.
 *
 * **A drag PREVIEWS and the release SEEKS.** Seeking on every pointer move would ask the server
 * for a segment at every position the viewer passed through; the transcoder's back-pressure
 * refuses most of those, but the requests would still be made. So the bar draws the preview
 * position and the time under it while dragging, and the element is sent there once.
 *
 * The keyboard half is deliberately small. ← → Home End and the digits are the player's global
 * keys and already work with focus here, so re-handling them would fire twice; only Page Up and
 * Page Down, which have no global meaning, are this control's own.
 */

import { type PointerEvent, useRef, useState } from "react";
import { clock } from "../../lib/playback-report";
import { SKIP_SEC, type Span, seekValueText } from "../../lib/player-controls";
import { cn } from "../../lib/utils";

export function SeekBar({
  position,
  duration,
  buffered,
  onSeek,
  onScrubbing,
}: {
  position: number;
  duration: number;
  buffered: Span[];
  onSeek: (seconds: number) => void;
  /** Told when a drag starts and ends, so the chrome can stay pinned for the length of it. */
  onScrubbing: (scrubbing: boolean) => void;
}) {
  const bar = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const known = Number.isFinite(duration) && duration > 0;
  const shown = drag ?? position;
  const playedFraction = known ? Math.min(1, Math.max(0, shown / duration)) : 0;

  const fractionAt = (clientX: number): number => {
    const rect = bar.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!known || e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDrag(fractionAt(e.clientX) * duration);
    onScrubbing(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const fraction = fractionAt(e.clientX);
    setHover(fraction);
    if (drag !== null) setDrag(fraction * duration);
  };
  const finish = (e: PointerEvent<HTMLDivElement>) => {
    if (drag === null) return;
    const target = fractionAt(e.clientX) * duration;
    setDrag(null);
    onScrubbing(false);
    onSeek(target);
  };

  const tooltipFraction = drag !== null && known ? drag / duration : hover;

  return (
    <div
      ref={bar}
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={known ? Math.round(duration) : 0}
      aria-valuenow={Math.round(shown)}
      aria-valuetext={known ? seekValueText(shown, duration) : "unknown length"}
      data-testid="seek-bar"
      className="group relative flex h-5 cursor-pointer touch-none items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onPointerLeave={() => setHover(null)}
      onKeyDown={(e) => {
        if (!known) return;
        if (e.key === "PageUp" || e.key === "PageDown") {
          e.preventDefault();
          onSeek(Math.min(duration, Math.max(0, position + (e.key === "PageUp" ? SKIP_SEC : -SKIP_SEC) * 6)));
        }
      }}
    >
      <div
        className={cn(
          "relative h-1 w-full rounded-full bg-white/20 transition-[height] duration-100 group-hover:h-1.5",
          drag !== null && "h-1.5",
        )}
      >
        {buffered.map((span) => (
          <div
            key={`${span.start}-${span.end}`}
            data-testid="buffered-range"
            className="absolute inset-y-0 rounded-full bg-white/35"
            style={{ left: `${span.start * 100}%`, width: `${(span.end - span.start) * 100}%` }}
          />
        ))}
        {hover !== null && drag === null ? (
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-white/15"
            style={{ width: `${hover * 100}%` }}
          />
        ) : null}
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-accent"
          style={{ width: `${playedFraction * 100}%` }}
        />
        <div
          className={cn(
            "absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent opacity-0 shadow-[0_1px_4px_rgba(0,0,0,.5)] transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100",
            drag !== null && "opacity-100",
          )}
          style={{ left: `${playedFraction * 100}%` }}
        />
      </div>
      {tooltipFraction !== null && known ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute bottom-6 -translate-x-1/2 rounded-md bg-surface px-2 py-1 text-xs font-medium tabular-nums ring-1 ring-line"
          // Clamped so the tooltip at either end of the bar does not hang off the screen.
          style={{ left: `clamp(1.75rem, ${tooltipFraction * 100}%, calc(100% - 1.75rem))` }}
        >
          {clock(tooltipFraction * duration)}
        </div>
      ) : null}
    </div>
  );
}
