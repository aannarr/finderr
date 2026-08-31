/**
 * The Request settings panel's load policy, in one place and with no React in it.
 *
 * > [!CAUTION] An effect must never list the state its own `setState` writes
 * > This exists because `RequestOptions` did. The effect read `state.phase`, guarded on
 * > `!== "idle"`, called `setState({ phase: "loading" })` and latched `cancelled = true` in
 * > its cleanup -- so starting the fetch changed a dependency, React ran the cleanup on the
 * > very next render, and the response was discarded before it could possibly arrive. The
 * > panel said `Asking Sonarr…` for the life of the page while `/api/arr/options` answered
 * > 200 to a hand `curl`. The cancel wins that race every time: it happens on the next
 * > render rather than after any await, so it is not intermittent and no amount of a
 * > faster network changes it.
 *
 * The shape is the one `pollWhileWorking` uses in `use-title-detail.ts` and for the same
 * reason: the web suite renders through `react-dom/server`, which does not run effects, so
 * a sequencing rule left inside a `useEffect` is a rule no test in this repo can reach.
 * Here it is a plain object driven by a deferred promise.
 *
 * Two properties carry the whole fix:
 *
 * - **`start()` is idempotent**, so the component may call it from every render without
 *   needing a state guard. This is the one route in the tree that leaves the box, and the
 *   panel is deliberately collapsed by default so most admins never pay for it -- asking
 *   twice would spend that restraint.
 * - **`dispose()` is tied to UNMOUNT and to nothing else.** Cancelling on a state change,
 *   on a prop change, or on the panel being collapsed is what broke this; a response that
 *   arrives after the reader closed the panel is still the right answer for when they open
 *   it again.
 */

import type { ArrOptions } from "./api";

/** Both arrs in one answer -- the panel needs every list at once or none of them. */
export interface ArrOptionsPayload {
  radarr: ArrOptions | null;
  sonarr: ArrOptions | null;
}

/**
 * What the panel draws.
 *
 * `ready` carries BOTH services rather than the one being drawn. Picking at render time is
 * what keeps `service` out of the effect's dependencies, which is the second half of the
 * bug this module was written for.
 */
export type OptionsState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ready"; options: ArrOptionsPayload }
  | { phase: "error"; message: string };

export interface ArrOptionsLoader {
  /** Fetch, once. Safe to call on every render; every call after the first is a no-op. */
  start: () => void;
  /** The view has gone away. A response landing after this is dropped. */
  dispose: () => void;
}

/**
 * @param fetcher how to get the lists. Injected so a test needs no DOM and no network.
 * @param emit where each state goes -- a `setState` in the component, an array in a test.
 */
export function makeArrOptionsLoader(
  fetcher: () => Promise<ArrOptionsPayload>,
  emit: (state: OptionsState) => void,
): ArrOptionsLoader {
  let started = false;
  let alive = true;

  const settle = (state: OptionsState) => {
    if (alive) emit(state);
  };

  return {
    start() {
      if (started) return;
      started = true;
      emit({ phase: "loading" });
      // `try` as well as `.catch`: a fetcher that throws synchronously -- a bad relative
      // URL, a stubbed one in a test -- would otherwise escape as an exception thrown from
      // inside a render effect and take the panel down instead of showing its error line.
      try {
        fetcher().then(
          (options) => settle({ phase: "ready", options }),
          (err: Error) => settle({ phase: "error", message: err.message }),
        );
      } catch (err) {
        settle({ phase: "error", message: (err as Error).message });
      }
    },
    dispose() {
      alive = false;
    },
  };
}
