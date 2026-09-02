/**
 * Holding a fast-changing value still until it is worth acting on.
 *
 * THE MEASUREMENT THIS EXISTS FOR, 2026-09-02, against the live deployment: every
 * keystroke in the search box fired `/api/search`. Typing "the matrix" cost TEN requests
 * in 3.1s, and two of them -- `the` and `the ` -- were the pathological stopword query
 * that took the server 1033ms each. `AbortController` did not help and could not: it
 * cancels the BROWSER's interest in the response, while the server has already begun a
 * synchronous SQLite query that runs to completion regardless. `bun:sqlite` is
 * synchronous, so those queries hold the event loop and every other request on the page
 * -- posters, facet polls, health -- queues behind a keystroke nobody is waiting for.
 *
 * So the fix has to stop the request being SENT. Debouncing is the only thing that does.
 *
 * > [!IMPORTANT] Debounce the FETCH, never the navigation
 * > The search box is a controlled input reading `q` straight out of the URL
 * > (`RootLayout`), so delaying the `navigate` would delay the CARET -- the box would
 * > visibly lag behind the typist, which is a far worse bug than the one being fixed.
 * > The URL stays instant and shareable; only the round trip waits.
 *
 * Timers are injected so the policy can be tested against a fake clock with no DOM and
 * no React, the same shape `pollWhileWorking` uses in `use-title-detail.ts`.
 */

import { useEffect, useRef, useState } from "react";

/** The clock a debouncer runs on. `setTimeout`'s shape, narrowed to what is used. */
export interface Timers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

export const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * How long the box must be STILL before a query is worth a round trip.
 *
 * 150ms is chosen against measured typing rather than taste: it is comfortably under the
 * ~200ms gap that reads as "the page is thinking" and comfortably over the inter-key
 * interval of ordinary typing, so a word arrives as one request. Raising it saves
 * requests the user never sees and costs responsiveness on the pause AFTER the last
 * letter, which is the one moment they are waiting.
 */
export const SEARCH_DEBOUNCE_MS = 150;

export interface Debouncer<T> {
  /** Offer a value. It is emitted once nothing else is offered for `ms`. */
  push: (value: T) => void;
  /** Emit the pending value NOW, if there is one. */
  flush: () => void;
  /** Drop the pending value without emitting it. */
  cancel: () => void;
}

/**
 * Emit the LAST value offered, once the offers stop for `ms`.
 *
 * Trailing-edge only, deliberately. A leading-edge debounce would fire on the first
 * keystroke of every word -- which is exactly the single-letter query that costs the most
 * and answers the least, because one letter prefix-matches a huge slice of the index.
 */
export function debouncer<T>(
  ms: number,
  emit: (value: T) => void,
  timers: Timers = realTimers,
): Debouncer<T> {
  let handle: unknown = null;
  let pending: { value: T } | null = null;

  const cancel = () => {
    if (handle !== null) timers.clear(handle);
    handle = null;
    pending = null;
  };

  return {
    push(value) {
      if (handle !== null) timers.clear(handle);
      pending = { value };
      handle = timers.set(() => {
        handle = null;
        const held = pending;
        pending = null;
        if (held) emit(held.value);
      }, ms);
    },
    flush() {
      const held = pending;
      cancel();
      if (held) emit(held.value);
    },
    cancel,
  };
}

/**
 * `value`, held still until it has stopped changing for `ms`.
 *
 * > [!IMPORTANT] The FIRST value is adopted with no delay, and that is not an optimisation
 * > Seeding the state FROM `value` is what makes a shared link (`/?q=matrix`) and a Back
 * > navigation fetch at once. Starting from `null` and waiting would put a 150ms stall on
 * > every cold arrival -- paying the debounce on the one path where nobody is typing.
 *
 * A value that returns to what is already settled -- typing a letter and deleting it --
 * schedules nothing, so the round trip that was already correct is not re-sent.
 */
export function useDebouncedValue<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  const ref = useRef<Debouncer<T> | null>(null);
  ref.current ??= debouncer<T>(ms, setSettled);

  // Cancel on unmount only. A pending emit after the route has gone would set state on a
  // dead component, and the fetch it triggers is one nobody can ever see.
  useEffect(() => () => ref.current?.cancel(), []);

  useEffect(() => {
    if (Object.is(value, settled)) return;
    ref.current?.push(value);
  }, [value, settled]);

  return settled;
}
