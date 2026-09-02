/**
 * How far along a request is, and one honest sentence about why.
 *
 * The answer to the thing Seerr never says. Two exports, because a card and a title page
 * want different amounts of the same fact: `ProgressBar` is the thin line under a chip in a
 * grid, `RequestVerdictPanel` is the block a reader who opened the page gets.
 *
 * Neither of them knows what any verdict MEANS. The words, and the tone that colours them,
 * come from `VERDICT_COPY` on the server side of the tree -- so the chip in the grid and
 * the panel on the page can never disagree about the same title.
 */

import { useEffect, useState } from "react";
import { formatRemaining, VERDICT_COPY, type VerdictTone } from "../../../src/lib/request-diagnostics";
import type { RequestState } from "../lib/api";

/** How often the "about 4 min left" line re-reads the clock. */
const ETA_TICK_MS = 20_000;

/**
 * Wall-clock time, re-read on a timer, but only while somebody is waiting on it.
 *
 * `active` is not an optimisation: the ETA is the ONLY thing on these screens that goes
 * stale on its own, so a permanent interval would re-render every card in a grid every
 * twenty seconds to redraw identical markup.
 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), ETA_TICK_MS);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** The border and fill each tone wears. One table, both surfaces. */
const TONE_SHELL: Record<VerdictTone, string> = {
  working: "border-warn/40 bg-warn/10",
  done: "border-line",
  dead_end: "border-danger/50 bg-danger/10",
};

/**
 * A download in progress, as a line.
 *
 * `aria-valuenow` and friends make it a real progressbar rather than a coloured box, which
 * matters here because the percentage is the only part of this a screen reader can use --
 * the bar itself carries no text.
 *
 * Built from SPANS rather than divs, because one of its two callers is the chip inside
 * `RequestAction`, which is itself a span. A div in there is invalid markup that browsers
 * silently reparent, moving the bar out of the chip it is meant to sit under.
 */
export function ProgressBar({ value }: { value: number }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <span
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="Download progress"
      className="block h-1 overflow-hidden rounded-full bg-surface-2"
    >
      <span
        className="block h-full rounded-full bg-accent transition-[width] duration-500 ease-out motion-reduce:transition-none"
        style={{ width: `${pct}%` }}
      />
    </span>
  );
}

/**
 * The whole answer: what state this request is in, how far along, and why.
 *
 * `error` wins over the verdict's own sentence when it is there. It is already sanitised on
 * the server (`safeArrMessage`) and it is more specific -- "Radarr rejected our
 * credentials" tells an admin what to go and fix, where "the request could not be sent"
 * only tells them something is wrong.
 */
export function RequestVerdictPanel({
  state,
  error = null,
}: {
  state: RequestState;
  /** The request row's own sanitised failure reason, when the caller has one. */
  error?: string | null;
}) {
  const etaMs = state.requestEtaAt ? Date.parse(state.requestEtaAt) : Number.NaN;
  const now = useNow(Number.isFinite(etaMs));
  if (!state.requestVerdict) return null;

  const copy = VERDICT_COPY[state.requestVerdict];
  const pct = state.requestProgress === null ? null : Math.round(state.requestProgress * 100);
  const remaining = Number.isFinite(etaMs) ? formatRemaining(etaMs - now) : null;

  return (
    <div className={`rounded-lg border px-3 py-2 text-sm ${TONE_SHELL[copy.tone]}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium">{copy.label}</span>
        {pct !== null && (
          <span className="tabular-nums text-xs text-muted">
            {pct}%{remaining && ` · about ${remaining} left`}
          </span>
        )}
      </div>

      {state.requestProgress !== null && (
        <div className="mt-2">
          <ProgressBar value={state.requestProgress} />
        </div>
      )}

      <p className="mt-1.5 text-xs text-muted">{error ?? copy.sentence}</p>
    </div>
  );
}
