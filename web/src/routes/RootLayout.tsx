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
import { flushSync } from "react-dom";
import { JumpKeysProvider } from "../components/JumpKeys";
import { Kbd, type KeyAction, mergeKeyProps, useKeyAction } from "../components/Kbd";
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
import { type HeaderState, INITIAL_HEADER_STATE, nextHeaderState } from "../lib/header-scroll";
import { ariaKeyShortcuts, HOST_PLATFORM, KEYMAP } from "../lib/keymap";
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

/**
 * The top-level destinations, beside the wordmark.
 *
 * > [!IMPORTANT] THIS ARRAY IS THE EXTENSION POINT -- add a line, do not rewrite it
 * > A section that earns a place in the bar adds ONE `{ to, label }` here and nothing
 * > else. It is a table rather than hand-written JSX for exactly that reason: two people
 * > adding a link at once is a one-line merge instead of a conflict in markup.
 *
 * **A link only goes in once its route resolves.** A nav entry pointing at a 404 is the
 * dead end this product refuses to draw, and it is worse in the chrome than anywhere else
 * because it is on every screen.
 *
 * `Admin` and the account link are deliberately NOT here: those are conditional on who is
 * signed in and they live on the right, away from the sections everyone shares.
 */
const NAV_LINKS: { to: string; label: string }[] = [
  { to: "/lists", label: "Lists" },
  { to: "/awards/oscars", label: "Awards" },
  { to: "/requests", label: "Requests" },
];

/**
 * The magnifier, inline rather than from an icon set.
 *
 * One glyph, eleven lines, no dependency and no sprite to keep in sync. `currentColor` is
 * what lets the surrounding hover rule light it up without a second colour written down.
 */
function SearchGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

export function RootLayout() {
  const navigate = useNavigate();
  const toasts = useToasts();
  const [pendingCount, setPendingCount] = useState(0);
  /**
   * How many of YOUR requests have arrived that you have not been shown.
   *
   * It rides the queue poll below rather than having a timer of its own: the server puts
   * both numbers on the same response, so they always describe the same moment and the
   * badge costs no extra request.
   */
  const [unseenCount, setUnseenCount] = useState(0);
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
  // The query shown in the box is whatever the URL says, so a back/forward step or a
  // pasted link repopulates it with no extra state to keep in sync.
  const search = useRouterState({
    select: (s) => (s.location.search as SearchParams) ?? {},
  });
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const onSearchRoute = pathname === "/";
  const query = onSearchRoute ? (search.q ?? "") : "";

  /*
    The sticky header's search box collapses to a button on the way down the page.

    `collapsed` is the only thing that renders, so it is the only thing in state. The
    scroll ANCHOR lives in a ref beside it: `nextHeaderState` re-anchors roughly every step
    while a scroll is in progress, and putting that in state would re-render the whole shell
    every twelve pixels of a flick in order to draw the identical DOM.

    The policy itself is in `../lib/header-scroll.ts` and is a pure function tested with no
    DOM -- same split as `pollWhileWorking` and for the same reason.
  */
  const [collapsed, setCollapsed] = useState(false);
  const headerState = useRef<HeaderState>(INITIAL_HEADER_STATE);
  const searchFocused = useRef(false);

  /** Open the box and re-anchor here, so the next scroll is measured from this point. */
  const expand = useCallback(() => {
    headerState.current = { collapsed: false, anchorY: Math.max(0, window.scrollY) };
    setCollapsed(false);
  }, []);

  /**
   * Open the box and put the caret in it, from `/` or from the collapsed button.
   *
   * > [!IMPORTANT] `flushSync` is required here, and it is not a performance hack
   * > The collapsed wrapper is `inert`, and `inert` blocks PROGRAMMATIC focus as firmly as
   * > it blocks tabbing -- that is the whole point of it. React batches state, so a plain
   * > `expand()` followed by `.focus()` would call focus while the DOM still carries the
   * > attribute, and the caret would silently go nowhere. Flushing the expansion first is
   * > what makes `/` a single atomic action instead of a race.
   * >
   * > This runs in an event handler, never during render, which is where `flushSync` is
   * > sanctioned rather than warned about.
   */
  const focusSearch = useCallback(() => {
    flushSync(expand);
    searchBox.current?.focus();
    searchBox.current?.select();
  }, [expand]);

  useEffect(() => {
    const onScroll = () => {
      const next = nextHeaderState(headerState.current, {
        y: window.scrollY,
        // A reader with a query on screen is mid-task even when the caret is elsewhere,
        // so a query pins the box open as firmly as focus does.
        pinned: searchFocused.current || query.length > 0,
      });
      if (next === headerState.current) return;
      headerState.current = next;
      setCollapsed(next.collapsed);
    };

    // `passive` because this listener never calls `preventDefault`; without it the browser
    // must wait for it before scrolling, which is the classic way a scroll handler becomes
    // the jank it was added to remove.
    window.addEventListener("scroll", onScroll, { passive: true });
    // Run once on mount: a route change can restore a scroll position without firing an
    // event, and the header would otherwise sit expanded halfway down a page.
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, [query]);

  /**
   * `/` puts the caret back in the box from anywhere, selecting what is already there so
   * the next keystroke starts a new query rather than appending to the old one.
   *
   * Always live: the box is on every screen. It is also the one binding whose glyph must
   * go away while it is being typed into -- see the hint below.
   */
  // The input is never UNMOUNTED while collapsed -- only sized to nothing -- so the ref is
  // live either way and `/` stays one atomic action. See `focusSearch`.
  const searchKey = useKeyAction("focusSearch", focusSearch);
  /*
    Navigation mode's ANNOUNCEMENT only -- it has no handler here on purpose.

    `JumpKeysProvider` binds the key, because it is the only thing that knows which cards
    are on screen. But the provider wraps the `<Outlet />` and this header sits above it,
    so there is no control down there to hang the declaration on, and a shortcut a screen
    reader is never told about is one it cannot discover. This carries the aria half and
    nothing else, built from the same `KEYMAP` entry the provider matches against.
  */
  const jumpModeAnnounce: KeyAction = {
    props: { "aria-keyshortcuts": ariaKeyShortcuts(KEYMAP.jumpMode, HOST_PLATFORM) },
    hint: null,
  };

  /**
   * Poll the request queue while anything is in flight.
   *
   * The POST returned 202 immediately, so this is how outcomes get back to the user.
   * Polling slows to a crawl when the queue is empty -- no idle chatter.
   *
   * It also carries the unread count. A title arriving is a slow event -- the reconcile
   * timer notices it within thirty seconds of the arr importing the file -- so the idle
   * eight-second cadence is already far faster than the thing it is watching, and giving
   * that badge its own timer would be a second poll of the same endpoint.
   */
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      if (stop) return;
      try {
        const { queue, unseen } = await getRequests();
        setPendingCount(queue.pending);
        setUnseenCount(unseen);
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
      {/*
        The development-login banner.

        ABOVE the sticky header and not itself sticky, so it scrolls away rather than
        spending a strip of every screen -- but it is the first thing in the document, so it
        lands in any screenshot of the top of the page, which is the whole job. A screenshot
        of a login-less finderr is otherwise identical to one of the real thing.

        `role="alert"` because it is a standing warning about the state of the SERVER rather
        than a piece of page content, so a reader who cannot see the colour still gets told.
      */}
      {/*
        NO BANNER. aannarr, 2026-09-01: "REMOVE THIS HEADER FULL .. no need for it ever".

        It used to draw an orange strip on every page whenever `FINDERR_NO_AUTH` was
        set. The reasoning was that a screenshot of a login-less finderr is otherwise
        indistinguishable from a screenshot of a locked one -- but the operator who turned
        the flag on is the same person reading the strip on every screen, so it spends
        permanent screen space telling them something they chose. The boot banner and
        `auth.noAuth` in `/api/health` remain, and both are read by whoever is asking
        the question rather than by whoever already knows the answer.
      */}
      <div className="mx-auto min-h-full max-w-7xl px-4 pb-24">
        {/*
          `pt-[calc(1.25rem+var(--safe-top))]` REPLACES `pt-5`, it does not sit beside it.

          Installed to a home screen the sticky bar comes to rest at the physical top of the
          screen, which on a notched device is behind the status bar. The inset goes on the
          padding rather than on `top`, so the translucent background still bleeds up under
          the clock and only the wordmark and the search box move down. `--safe-top` is
          `0px` everywhere without a cutout, so this is `pt-5` on every desktop.
        */}
        <header className="sticky top-0 z-30 -mx-4 mb-4 bg-bg/85 px-4 pt-[calc(1.25rem+var(--safe-top))] pb-3 backdrop-blur">
          <div className="flex items-baseline gap-3">
            <Link to="/" search={{}} className="text-lg font-semibold tracking-tight">
              finderr
            </Link>
            {/*
              The section links. `aria-current="page"` rather than a colour alone -- the
              underline is what a sighted reader sees and the attribute is what everyone
              else gets, and one of those without the other is half a signal.

              Matched with `startsWith` so a page BELOW a section still marks its parent:
              `/lists` stays lit on a list's own sub-page. An exact match would unlight the
              bar the moment somebody navigated one step in, which reads as having left.
            */}
            <nav className="flex items-baseline gap-3 text-xs text-muted">
              {NAV_LINKS.map((link) => {
                const current = pathname === link.to || pathname.startsWith(`${link.to}/`);
                return (
                  <Link
                    key={link.to}
                    to={link.to}
                    aria-current={current ? "page" : undefined}
                    className={current ? "text-ink underline underline-offset-4" : "hover:text-ink"}
                  >
                    {link.label}
                  </Link>
                );
              })}
            </nav>
            {pendingCount > 0 && (
              <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted">
                {pendingCount} queued
              </span>
            )}
            {/*
              THE READY BADGE. Coloured, and a LINK rather than a chip, because unlike
              "queued" it is news the reader is meant to act on -- and a count with nowhere
              to go is the dead end this product refuses to draw.

              Hidden while the reader is ON `/requests`: opening that page marks everything
              seen, and the poll would go on drawing the old number for up to eight seconds
              afterwards -- a badge insisting there is unread news on the page that is
              showing it.
            */}
            {unseenCount > 0 && pathname !== "/requests" && (
              <Link
                to="/requests"
                className="rounded-full bg-accent/15 px-2 py-0.5 text-xs text-accent hover:bg-accent/25"
              >
                {unseenCount} ready
              </Link>
            )}
            <span className="ml-auto flex items-baseline gap-3 text-xs text-muted">
              {/*
                The collapsed box's stand-in, in the row that never collapses. It is a real
                button rather than an icon-shaped div, so it is tabbable and reads as
                "Search" -- the whole point is that the affordance survives the collapse.
              */}
              {collapsed && (
                <button
                  type="button"
                  onClick={focusSearch}
                  aria-label="Search titles"
                  className="-my-1 rounded-lg px-2 py-1 text-muted transition-colors hover:text-ink"
                >
                  <SearchGlyph />
                </button>
              )}
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

            > [!IMPORTANT] The input is SIZED to nothing when collapsed, never unmounted
            > `/` has to expand and focus in one handler, and an unmounted input has no
            > element to focus -- which would make the binding a two-step dance with a
            > render in the middle. Animating a wrapper is also the only way to get a
            > transition at all; there is nothing to tween between "present" and "absent".
            >
            > `inert` is what keeps that honest. A zero-height input is still in the tab
            > order and still announced, so a keyboard or screen-reader user would land in
            > a control nobody can see. `inert` removes it from both, and `expand()` runs
            > before any focus we ask for ourselves.
          */}
          <div
            inert={collapsed || undefined}
            className={`grid transition-all duration-200 ease-out motion-reduce:transition-none ${
              collapsed ? "mt-0 grid-rows-[0fr] opacity-0" : "mt-3 grid-rows-[1fr] opacity-100"
            }`}
          >
            {/* `grid-rows-[0fr]` -> `[1fr]` is the one way to transition to auto height
                without measuring anything in JS. The inner div owns the overflow. */}
            <div className="relative overflow-hidden">
              <input
                ref={searchBox}
                // Search IS the product, so the caret belongs here the moment the app loads.
                autoFocus
                type="search"
                value={query}
                onChange={(e) => onQueryChange(e.target.value)}
                onFocus={() => {
                  searchFocused.current = true;
                  expand();
                }}
                onBlur={() => {
                  // Only clears the pin. It deliberately does NOT collapse: a box vanishing
                  // the instant the caret leaves it would swallow a click aimed just below.
                  searchFocused.current = false;
                }}
                placeholder="Search anything -- spelling optional"
                aria-label="Search titles"
                /*
                  BOTH shortcuts, merged. `aria-keyshortcuts` takes a space-separated list,
                  so spreading a second props object would silently overwrite the first --
                  which is exactly what `mergeKeyProps` exists to prevent, and why the mode
                  is handed through it as a props-only `KeyAction` rather than concatenated
                  by hand. A reader who tabs here is told about `/` AND about the mode.
                */
                {...mergeKeyProps(searchKey, jumpModeAnnounce)}
                className="w-full rounded-xl border border-line bg-surface px-4 py-3 pr-10 text-base outline-none
                         placeholder:text-muted focus:border-accent/60"
              />
              {/*
                Both slashes, in the one place a keyboard-first reader is already looking.

                `/` puts the caret here; `⌘/` labels every card on screen so one key opens
                one. They sit together because they are the same idea one modifier apart --
                the two entry points to driving this without a mouse -- and because this
                app's rule is that an action wears its own key rather than hiding in a help
                overlay nobody opens. Navigation mode has no button of its own to wear one,
                so the search box carries it: it is where the caret already is, which is
                exactly where a reader is when they want to stop typing and start picking.

                THE GLYPH ALONE, not a `useKeyAction`, and that is not a shortcut taken.
                `useKeyAction` binds a handler to the control that wears the key, which is
                right for an action a button performs. Navigation mode is not performed by
                any control -- it is a mode the whole page enters, and `JumpKeysProvider`
                owns its listener because it is the only thing that knows which cards are
                on screen. `Kbd` reads the same `KEYMAP` entry that provider matches
                against, so the single source of truth is intact, which is what the rule
                is actually protecting. It is always drawn: the binding is
                command-modified, so it fires through a caret and never advertises a key
                that would not work from where the reader is.
              */}
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center gap-1">
                {searchKey.hint}
                <Kbd action="jumpMode" />
              </span>
            </div>
          </div>
        </header>

        {/*
          Toasts render themselves from ToastProvider, which wraps the router.

          Alt-to-jump wraps the OUTLET rather than the whole shell, and only just: the
          scope has to cover every route that draws cards while excluding nothing above
          it, and there are no cards in the header. One provider for the app -- per-route
          or per-shelf scopes would make `Alt+1` mean a different card in every shelf on
          the front page. See `JumpKeysProvider`.
        */}
        <JumpKeysProvider>
          <Outlet />
        </JumpKeysProvider>
      </div>
    </AppProvider>
  );
}
