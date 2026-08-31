/**
 * The shell every route renders inside: title bar, the always-available search box,
 * the queue badge, and the toast stack.
 *
 * The search box lives HERE rather than on the search route so it is reachable from a
 * title page or a browse view without going back first -- typing anywhere navigates to
 * the results. That is the same "never make the human wait or backtrack" rule the rest
 * of the product follows.
 */

import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useKeyAction } from "../components/Kbd";
import {
  getRequests,
  patchTitleState,
  postRequest,
  type RequestOverrides,
  retryRequest,
  type Title,
} from "../lib/api";
import { AppProvider } from "../lib/app-context";
import { getAuthState, type PublicUser } from "../lib/auth-api";
import type { SearchParams } from "../lib/search-params";
import { summariseSeasons } from "../lib/season-select";
import { useToasts } from "../lib/toasts";

/**
 * What the success toast says.
 *
 * A whole-title request keeps the sentence it always had. A request that named seasons
 * says WHICH -- the reader made a choice that costs disk and bandwidth, and a toast
 * reading "sent to sonarr" gives them no way to notice they picked the wrong ones.
 */
function summariseSent(t: Title, seasons?: readonly number[] | null): string {
  const where = t.service === "sonarr" ? "Sonarr" : "Radarr";
  if (!seasons || seasons.length === 0) return `${t.title} sent to ${where}`;
  return `${t.title} — ${summariseSeasons(seasons)} sent to ${where}`;
}

export function RootLayout() {
  const navigate = useNavigate();
  const toasts = useToasts();
  const [pendingCount, setPendingCount] = useState(0);
  const searchBox = useRef<HTMLInputElement>(null);
  /**
   * Who is signed in, read once.
   *
   * Only two things depend on it: whether to draw the Admin link, and what the account
   * link is called. It is NOT a permission check -- every admin endpoint refuses a
   * non-admin on the server, so hiding the link is tidiness and the server is the wall.
   */
  const [me, setMe] = useState<PublicUser | null>(null);

  useEffect(() => {
    void getAuthState()
      .then((s) => setMe(s.user ?? null))
      .catch(() => setMe(null));
  }, []);

  /**
   * `/` puts the caret back in the box from anywhere, selecting what is already there so
   * the next keystroke starts a new query rather than appending to the old one.
   *
   * Always live: the box is on every screen. It is also the one binding whose glyph must
   * go away while it is being typed into -- see the hint below.
   */
  const searchKey = useKeyAction("focusSearch", () => {
    searchBox.current?.focus();
    searchBox.current?.select();
  });

  // The query shown in the box is whatever the URL says, so a back/forward step or a
  // pasted link repopulates it with no extra state to keep in sync.
  const search = useRouterState({
    select: (s) => (s.location.search as SearchParams) ?? {},
  });
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const onSearchRoute = pathname === "/";
  const query = onSearchRoute ? (search.q ?? "") : "";

  /**
   * Poll the request queue while anything is in flight.
   *
   * The POST returned 202 immediately, so this is how outcomes get back to the user.
   * Polling slows to a crawl when the queue is empty -- no idle chatter.
   */
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      if (stop) return;
      try {
        const { queue } = await getRequests();
        setPendingCount(queue.pending);
        timer = setTimeout(tick, queue.pending > 0 ? 1500 : 8000);
      } catch {
        timer = setTimeout(tick, 8000);
      }
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, []);

  /** Fire and forget. The user keeps searching; the toast reports the outcome. */
  const request = useCallback(
    async (t: Title, seasons?: readonly number[] | null, overrides?: RequestOverrides) => {
      const id = toasts.push(`Requesting ${t.title}`);
      // Optimistic: mark it immediately so the card updates without a round trip.
      // patchTitleState writes through the shared caches, so every view showing this
      // title picks the change up -- no per-route copy to update.
      patchTitleState(t.tconst, { requestStatus: "queued" });

      try {
        await postRequest(t.tconst, seasons, overrides);
        toasts.resolve(id, "success", summariseSent(t, seasons));
      } catch (e) {
        patchTitleState(t.tconst, { requestStatus: null });
        // The retry carries the SAME selection AND the same overrides. Retrying into "all
        // seasons" would quietly download more than the reader asked for, and retrying into
        // the default quality profile would quietly download something other than what an
        // admin chose -- both on the one path where they are least likely to be watching.
        toasts.resolve(id, "error", (e as Error).message, () => {
          void retryRequest(t.tconst).then(() => request(t, seasons, overrides));
        });
      }
    },
    [toasts],
  );

  const onQueryChange = useCallback(
    (value: string) => {
      // Typing always lands on the search route, and always drops the facets --
      // a genre filter from the previous query is nearly never right for the new one.
      navigate({
        to: "/",
        search: value.trim() ? { q: value } : {},
        // Keystrokes REPLACE rather than push, or one search would bury the previous
        // page under thirty history entries and make Back useless.
        replace: onSearchRoute,
      });
    },
    [navigate, onSearchRoute],
  );

  return (
    <AppProvider value={{ request, pendingCount, isAdmin: me?.role === "admin" }}>
      <div className="mx-auto min-h-full max-w-7xl px-4 pb-24">
        <header className="sticky top-0 z-30 -mx-4 mb-4 bg-bg/85 px-4 pt-5 pb-3 backdrop-blur">
          <div className="flex items-baseline gap-3">
            <Link to="/" search={{}} className="text-lg font-semibold tracking-tight">
              finderr
            </Link>
            {pendingCount > 0 && (
              <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted">
                {pendingCount} queued
              </span>
            )}
            <span className="ml-auto flex items-baseline gap-3 text-xs text-muted">
              {me?.role === "admin" && (
                <Link to="/admin" className="hover:text-ink">
                  Admin
                </Link>
              )}
              {me && (
                <Link to="/account" className="hover:text-ink">
                  {me.displayName}
                </Link>
              )}
            </span>
          </div>

          {/*
            The `/` hint sits inside the box and vanishes while the box is being typed
            into -- `useKeyAction` withdraws it, because `/` is a character once the caret
            is here. No CSS focus rule: the same withdrawal serves every other glyph in
            the app, and a second one here would be a second owner of the rule.
          */}
          <div className="relative mt-3">
            <input
              ref={searchBox}
              // Search IS the product, so the caret belongs here the moment the app loads.
              autoFocus
              type="search"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              placeholder="Search anything -- spelling optional"
              aria-label="Search titles"
              {...searchKey.props}
              className="w-full rounded-xl border border-line bg-surface px-4 py-3 pr-10 text-base outline-none
                         placeholder:text-muted focus:border-accent/60"
            />
            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center">
              {searchKey.hint}
            </span>
          </div>
        </header>

        {/* Toasts render themselves from ToastProvider, which wraps the router. */}
        <Outlet />
      </div>
    </AppProvider>
  );
}
