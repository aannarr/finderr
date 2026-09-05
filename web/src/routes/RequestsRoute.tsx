/**
 * `/requests` -- what you asked for, and which of it has arrived.
 *
 * The answer to "is it ready yet", which until now had no page at all: the request log
 * existed, but only an admin could see it and only as a list of everybody's rows. The
 * header's ready badge points here, and arriving here is what clears it.
 *
 * It draws NO cards. Every row is one request and the interesting part of it is the state,
 * which `RequestVerdictPanel` already knows how to say -- the same component the title page
 * uses, so a request can never be described one way here and another way there.
 *
 * IT UPDATES WHILE YOU WATCH IT, and it has to: this is the one page somebody opens in order
 * to see a bar move, and a page that loaded once left that bar frozen at whatever percentage
 * it arrived with while the countdown beside it ticked toward an ETA nothing refreshed. The
 * timer belongs to the shell (`requestsTick`), not to this file.
 *
 * AND AN ARRIVED REQUEST OFFERS SOMETHING TO PRESS -- `PlayOnPlex`, the same pair of links
 * the title page draws, off the same server-built `plex` field.
 */

import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { isWithdrawable } from "../../../src/lib/request-withdrawal";
import { PlayOnPlex } from "../components/PlayOnPlex";
import { RequestVerdictPanel } from "../components/RequestProgress";
import {
  getRequests,
  type MediaRequest,
  markRequestsSeen,
  patchTitleState,
  withdrawRequest,
} from "../lib/api";
import { useApp } from "../lib/app-context";
import { hasWorkInFlight, newsFirst, seasonLine } from "../lib/request-log";
import { LINK_BUTTON } from "../lib/ui";

/**
 * Undo one ask, behind a confirmation.
 *
 * > [!IMPORTANT] The confirmation is INLINE, and it is not `window.confirm`
 * > A native dialog cannot be styled, cannot be dismissed by keyboard the way the rest of
 * > this app can, is suppressible by the browser, and is invisible to a test -- jsdom does
 * > not implement it. Swapping the button for its own "Withdraw? Yes / Cancel" pair costs
 * > one piece of state and makes the guard a thing that can be asserted.
 *
 * A request that has ARRIVED offers no control at all, and WHICH statuses those are is
 * `isWithdrawable` -- the same function the server refuses with, so a button can never
 * promise something the endpoint declines. Removing the media itself is a library operation
 * and belongs in the arr.
 *
 * The failure is shown ON THE ROW rather than raised as a toast, because it is a fact about
 * this one request -- "Radarr is having trouble" -- and the reader is looking straight at it.
 *
 * Exported for its test: what has to be pinned is that the destructive verb is not reachable
 * in one click, and that is a property of THIS component rather than of the page around it.
 */
export function WithdrawControl({
  request,
  onWithdrawn,
}: {
  request: MediaRequest;
  onWithdrawn: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isWithdrawable(request.status)) return null;

  const withdraw = async () => {
    setBusy(true);
    setError(null);
    try {
      await withdrawRequest(request.tconst);
      // Every cached view of this title still carries the request badge, so it is cleared
      // through the shared caches rather than by reloading each of them -- the same call
      // `RootLayout` makes when a request fails to go out.
      patchTitleState(request.tconst, { requestStatus: null });
      onWithdrawn();
    } catch (e) {
      setError((e as Error).message);
      setAsking(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-1 flex items-baseline gap-3">
      {asking ? (
        <>
          <span className="text-xs text-muted">Withdraw this request?</span>
          <button type="button" onClick={withdraw} disabled={busy} className={LINK_BUTTON}>
            {busy ? "Withdrawing…" : "Yes, withdraw"}
          </button>
          <button type="button" onClick={() => setAsking(false)} disabled={busy} className={LINK_BUTTON}>
            Keep it
          </button>
        </>
      ) : (
        <button type="button" onClick={() => setAsking(true)} className={LINK_BUTTON}>
          Withdraw
        </button>
      )}
      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  );
}

/**
 * What a reader may DO about one request: play it if Plex holds it, withdraw it if it has
 * not arrived. The two are not alternatives -- a series can be half-playable and still
 * downloading -- so this stacks them rather than choosing between them.
 *
 * Exported for its test, and it exists as a component for the same reason `WithdrawControl`
 * does: the rule worth pinning is which affordance a given row earns, and asserting that
 * through the whole route would need a router and an `AppProvider` to say something that is
 * true of one row.
 */
export function RequestActions({ request, onWithdrawn }: { request: MediaRequest; onWithdrawn: () => void }) {
  return (
    <>
      {/*
        THE THING YOU WERE WAITING FOR, AS SOMETHING TO PRESS.

        Drawn off `request.plex` and never off the verdict: Plex having SCANNED the item is
        the only fact that makes a deeplink play anything, and it is a strictly later event
        than the arr importing the file. So a row can read "Available" with no button here
        for the minute before the next Plex sync -- which is the honest version, and the
        alternative is a link that opens a server home screen and looks like it worked.

        Not gated on the verdict in the other direction either. A series whose early seasons
        are in Plex while a later one downloads is both playable and still working, and
        withholding Play until every episode landed would be this page declining to answer
        the question it exists for.
      */}
      {request.plex && <PlayOnPlex plex={request.plex} variant="inline" />}
      <WithdrawControl request={request} onWithdrawn={onWithdrawn} />
    </>
  );
}

export function RequestsRoute() {
  const [requests, setRequests] = useState<MediaRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Everything that has been news at any point during this visit. See `newsFirst`. */
  const news = useRef<Set<string>>(new Set());
  const { requestsTick } = useApp();

  /** Fetch the caller's rows, and say whether any of them are news to them. */
  const load = useCallback(async (): Promise<boolean> => {
    try {
      const { requests } = await getRequests({ mine: true });
      for (const r of requests) if (r.isNew) news.current.add(r.tconst);
      setRequests(newsFirst(requests, news.current));
      setError(null);
      return requests.some((r) => r.isNew);
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }, []);

  useEffect(() => {
    /*
      LOAD FIRST, THEN MARK SEEN -- and never the other way round.

      The rows carry `isNew`, which is what puts the arrivals at the top and draws the
      marker beside them. Marking first would clear the flag on the server before the read
      that was going to show it, so following the badge would land on a page with nothing
      highlighted: the reader would be told there was news and then shown none.

      Marking is fire-and-forget. It cannot fail in a way the reader can act on, and a
      failed mark simply leaves the badge up -- which is the honest outcome.

      UNCONDITIONAL here, unlike the poll below: `?mine=1` returns the most recent 200 rows,
      so an unread arrival older than that never appears in `requests` at all and would keep
      the header badge up forever if the mark waited to see one.
    */
    void load().then(() => markRequestsSeen().catch(() => {}));
  }, [load]);

  /*
    THE PAGE THAT EXISTS TO WATCH A DOWNLOAD, WATCHING IT.

    On the shell's poll rather than a timer of its own -- see `requestsTick` in
    `AppActions` -- and only while something is actually moving, because a page of arrived
    and dead-ended rows reads the same however often it is fetched.

    The ref is what makes this a subscription rather than a second load on mount: the effect
    runs once with whatever tick was current when the reader arrived, and only a CHANGE is a
    cue. Without it the mount would fire two identical reads a moment apart.

    Marking seen is conditional here and unconditional above, for the reason stated there.
    What it covers is the arrival that lands WHILE the page is open: it is on screen and
    marked, so leaving the page must not then raise a badge for news the reader watched break.
  */
  const seenTick = useRef(requestsTick);
  const working = requests !== null && hasWorkInFlight(requests);
  useEffect(() => {
    if (requestsTick === seenTick.current) return;
    seenTick.current = requestsTick;
    if (!working) return;
    void load().then((isNews) => {
      if (isNews) markRequestsSeen().catch(() => {});
    });
  }, [requestsTick, working, load]);

  /*
    THE ERROR ONLY TAKES THE PAGE WHEN THERE IS NO PAGE TO TAKE.

    It replaced the whole view unconditionally, which was right when this loaded exactly
    once and is wrong now that it polls: a single failed poll would throw away a list the
    reader is watching and put a sentence where their downloads were. A stale list plus the
    next tick is the better answer, and a successful load clears the flag either way.
  */
  if (error && !requests) return <p className="text-sm text-danger">{error}</p>;
  if (!requests) return <p className="text-sm text-muted">Loading…</p>;

  if (requests.length === 0) {
    return (
      <div className="max-w-prose">
        <h1 className="text-xl font-semibold tracking-tight">Your requests</h1>
        <p className="mt-2 text-sm text-muted">
          You have not asked for anything yet. Search for a film or a series and press Request; this page is
          where it turns up.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-prose">
      <h1 className="text-xl font-semibold tracking-tight">Your requests</h1>
      <ul className="mt-4 flex flex-col gap-4">
        {requests.map((request) => {
          const seasons = seasonLine(request);
          return (
            <li key={request.tconst}>
              <div className="flex items-baseline gap-2">
                {/*
                  The title is the way BACK to the thing itself -- to play it if it arrived,
                  to see why if it did not. A row that only reported a status would be a
                  dead end on the one page a reader visits when they want to act.
                */}
                <Link to="/title/$tconst" params={{ tconst: request.tconst }} className="hover:underline">
                  {request.title}
                </Link>
                {request.year !== null && <span className="text-xs text-muted">{request.year}</span>}
                {request.isNew && (
                  /*
                    The unread marker. A word rather than a coloured dot, because a dot has
                    to be explained and "New" does not -- and a screen reader gets the same
                    signal for free rather than needing a label bolted on.
                  */
                  <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs text-accent">New</span>
                )}
                {seasons && <span className="ml-auto text-xs text-muted">{seasons}</span>}
              </div>
              <div className="mt-1.5">
                <RequestVerdictPanel
                  state={request}
                  // The row's own sanitised reason when there is one -- it is more specific
                  // than the verdict's sentence. See `RequestVerdictPanel`.
                  error={request.error}
                />
              </div>
              {/*
                Reloading the whole list rather than splicing the row out locally: the poll
                that feeds this page is the server's, and a withdraw also frees a quota row
                and can change what the arr is doing. One read gives the true state of all of
                it, and the same read is what the tick above asks for.
              */}
              <RequestActions request={request} onWithdrawn={load} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
