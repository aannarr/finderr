/**
 * The two things every route needs and neither should re-implement: the toast stack
 * and the request action.
 *
 * Context rather than props because `TitleCard` renders on the search grid, the
 * detail route and every future browse view, and threading `onRequest` down each of
 * those is how the three copies drift apart.
 */

import { createContext, use } from "react";
import type { RequestOverrides, Title } from "./api";

export interface AppActions {
  /**
   * Fire-and-forget. Returns once the POST is acknowledged; the toast reports the rest.
   *
   * `seasons` is optional and only the title route ever passes it -- a grid card has no
   * room to choose and correctly means "all". Omitting it is not a lesser request: it is
   * the one every caller made before the selector existed.
   *
   * `overrides` is the same shape one layer further: ADMIN-ONLY, only the title route's
   * request panel ever passes it, and the server REFUSES a non-admin who sends any of it.
   * A caller with nothing to say omits it, which every grid card does.
   */
  request: (t: Title, seasons?: readonly number[] | null, overrides?: RequestOverrides) => Promise<void>;
  /** How many requests are still in flight, for the header badge. */
  pendingCount: number;
  /**
   * Is the signed-in reader an admin?
   *
   * Here rather than fetched per component: `RootLayout` already holds `me` for the header
   * links, and a second `/api/me` per panel would be the same fact bought twice. It gates
   * DISPLAY only -- the server is what enforces the rule, and a client flag flipped in
   * devtools buys a 403 and nothing else.
   */
  isAdmin: boolean;
}

const AppContext = createContext<AppActions | null>(null);

export const AppProvider = AppContext.Provider;

export function useApp(): AppActions {
  const ctx = use(AppContext);
  if (!ctx) throw new Error("useApp must be used inside <AppProvider>");
  return ctx;
}
