/**
 * The clock a scheduled policy runs on, injected so the policy can be tested.
 *
 * This lived in `debounce.ts` until a second consumer appeared -- `renewStreamToken` in
 * `playback-api.ts`, whose cadence is measured in minutes and could not be tested at all
 * against the real one. The seam is about TIME rather than about debouncing, so it owns a
 * module of its own instead of making playback import the search box's helper.
 *
 * `web/src/test/fake-timers.ts` is the virtual clock every test drives it with.
 */

/** `setTimeout`'s shape, narrowed to what a policy actually uses. */
export interface Timers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

export const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
