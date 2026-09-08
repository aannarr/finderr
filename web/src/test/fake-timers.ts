/**
 * A virtual clock for anything built on the `Timers` seam.
 *
 * Timers fire when `advance` passes their deadline, so a 150 ms debounce and a fifteen-minute
 * token renewal both cost a test nothing and assertions read as elapsed milliseconds.
 *
 * Lifted out of `debounce.test.ts` when `playback-api.test.ts` needed the same clock: a second
 * copy would have drifted, and the renewal tests turn on the one behaviour a hand-rolled copy
 * usually gets wrong -- a callback that schedules the NEXT timer while `advance` is still
 * walking the queue.
 */

import type { Timers } from "../lib/timers";

/** How many times one `advance` may re-scan before it calls the schedule a runaway. */
const MAX_PASSES = 1000;

export interface FakeClock {
  timers: Timers;
  /** Move time forward, firing everything that comes due -- including timers set while firing. */
  advance(ms: number): void;
  /** How many timers are outstanding. Zero after a cancel is what proves nothing leaked. */
  readonly scheduled: number;
}

export function fakeTimers(): FakeClock {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();

  const timers: Timers = {
    set: (fn, ms) => {
      const id = next++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clear: (handle) => {
      pending.delete(handle as number);
    },
  };

  return {
    timers,
    advance(ms) {
      now += ms;
      // Re-scanning rather than iterating a snapshot: a self-rescheduling policy adds its
      // next timer from inside this loop, and one already due within the same window has to
      // fire in this call or the test would silently measure only the first hop of a chain.
      // A policy that re-scheduled at zero delay forever would spin here with no test ever
      // failing, so the walk is bounded and says what it hit.
      for (let pass = 0; pass < MAX_PASSES; pass++) {
        const due = [...pending].filter(([, t]) => t.at <= now).sort((a, b) => a[1].at - b[1].at);
        if (due.length === 0) return;
        for (const [id, t] of due) {
          if (!pending.delete(id)) continue;
          t.fn();
        }
      }
      throw new Error(`fakeTimers: timers still due after ${MAX_PASSES} passes at t=${now}ms`);
    },
    get scheduled() {
      return pending.size;
    },
  };
}
