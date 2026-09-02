/**
 * What the search view is DOING, as one function the route reads once.
 *
 * Debouncing the fetch bought back a second of blocked event loop per typed word, and it
 * costs exactly one thing: the results now visibly trail the box. Before, every keystroke
 * fired instantly and the grid was either right or obviously mid-flight; now there is a
 * window -- the 150ms delay plus the round trip -- where the grid on screen belongs to a
 * query the reader has already stopped typing. Saying nothing during that window is how a
 * fast search comes to feel broken: the reader types, nothing moves, and the last thing they
 * can see is an answer to something else.
 *
 * The distinction that matters is whether there is anything on screen worth keeping.
 */

export type SearchPhase =
  /** The box is empty. The discover shelves own the page. */
  | "idle"
  /** Nothing painted yet -- the first query of a session, or the first after a clear. */
  | "first"
  /** Results ARE painted, for an older query. Keep them and say we are still working. */
  | "refining"
  /** What is painted is the answer to what is typed. */
  | "settled";

/**
 * `resultFor` is the key the painted result belongs to; `wantKey` is the key for what is
 * typed right now. They are compared rather than the queries themselves because a facet
 * toggle changes the answer without changing the query text.
 */
export function searchPhase(query: string, resultFor: string | null, wantKey: string): SearchPhase {
  if (query.trim().length === 0) return "idle";
  if (resultFor === wantKey) return "settled";
  return resultFor === null ? "first" : "refining";
}

/**
 * Whether the view is waiting on the server.
 *
 * `first` and `refining` differ only in what is drawn UNDERNEATH; both are "working", and a
 * caller asking "should the spinner be up?" should not have to know which. Keeping this
 * beside the phase stops the two-of-four-states test being re-derived at each call site.
 */
export function isSearching(phase: SearchPhase): boolean {
  return phase === "first" || phase === "refining";
}
