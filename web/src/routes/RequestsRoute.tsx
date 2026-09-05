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
 */

import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { isWithdrawable } from "../../../src/lib/request-withdrawal";
import { RequestVerdictPanel } from "../components/RequestProgress";
import {
  getRequests,
  type MediaRequest,
  markRequestsSeen,
  patchTitleState,
  withdrawRequest,
} from "../lib/api";
import { seasonLine } from "../lib/request-log";
import { LINK_BUTTON } from "../lib/ui";

/**
 * Newly-arrived first, then everything else by most recent activity.
 *
 * The server already sorts by `updated_at`, so this only lifts the news to the top --
 * which is the one thing a reader who followed the badge came here for. A stable partition
 * rather than a full comparator: within each group the server's order is kept.
 */
function newsFirst(requests: readonly MediaRequest[]): MediaRequest[] {
  return [...requests.filter((r) => r.isNew), ...requests.filter((r) => !r.isNew)];
}

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

export function RequestsRoute() {
  const [requests, setRequests] = useState<MediaRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { requests } = await getRequests({ mine: true });
      setRequests(newsFirst(requests));
    } catch (e) {
      setError((e as Error).message);
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
    */
    void load().then(() => markRequestsSeen().catch(() => {}));
  }, [load]);

  if (error) return <p className="text-sm text-danger">{error}</p>;
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
                it, and this page fetches once per visit anyway.
              */}
              <WithdrawControl request={request} onWithdrawn={load} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
