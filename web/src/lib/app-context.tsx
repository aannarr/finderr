/**
 * The two things every route needs and neither should re-implement: the toast stack
 * and the request action.
 *
 * Context rather than props because `TitleCard` renders on the search grid, the
 * detail route and every future browse view, and threading `onRequest` down each of
 * those is how the three copies drift apart.
 */

import { createContext, use } from "react";
import type { Title } from "./api";

export interface AppActions {
  /**
   * Fire-and-forget. Returns once the POST is acknowledged; the toast reports the rest.
   *
   * `seasons` is optional and only the title route ever passes it -- a grid card has no
   * room to choose and correctly means "all". Omitting it is not a lesser request: it is
   * the one every caller made before the selector existed.
   */
  request: (t: Title, seasons?: readonly number[] | null) => Promise<void>;
  /** How many requests are still in flight, for the header badge. */
  pendingCount: number;
}

const AppContext = createContext<AppActions | null>(null);

export const AppProvider = AppContext.Provider;

export function useApp(): AppActions {
  const ctx = use(AppContext);
  if (!ctx) throw new Error("useApp must be used inside <AppProvider>");
  return ctx;
}
