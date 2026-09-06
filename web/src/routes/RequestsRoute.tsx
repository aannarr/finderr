/**
 * `/requests` -- what you asked for, and which of it has arrived.
 *
 * The answer to "is it ready yet", which until now had no page at all: the request log
 * existed, but only an admin could see it and only as a list of everybody's rows. The
 * header's ready badge points here, and arriving here is what clears it.
 *
 * IT STILL DRAWS NO CARDS, and it now draws POSTERS. Those were the same sentence when this
 * file was written and they stopped being one: a card is a whole tile of metadata and votes
 * and award marks, which is the wrong unit for a row whose subject is a state. A 56-pixel
 * poster is not that -- it is ORIENTATION, the thing that lets a reader find the row they
 * came for without reading four titles. What survives unchanged is the state itself, which
 * `RequestVerdictPanel` says -- the same component the title page uses, so a request can
 * never be described one way here and another way there.
 *
 * GROUPED, NOT LISTED. A flat list in mixed states is a receipt: the row that needs somebody
 * to do something sits between two that arrived last week. `groupByState` partitions it into
 * Downloading / Waiting / Arrived / Needs attention, in that order, and the counts are
 * repeated in the header so one glance answers "is anything wrong".
 *
 * IT UPDATES WHILE YOU WATCH IT, and it has to: this is the one page somebody opens in order
 * to see a bar move, and a page that loaded once left that bar frozen at whatever percentage
 * it arrived with while the countdown beside it ticked toward an ETA nothing refreshed. The
 * timer belongs to the shell (`requestsTick`), not to this file.
 *
 * AND AN ARRIVED REQUEST OFFERS SOMETHING TO PRESS -- `PlayOnPlex`, the same pair of links
 * the title page draws, off the same server-built `plex` field. A DEAD-ENDED one offers
 * something too: `RetryControl`, which is the endpoint that has existed since requests did
 * and that nothing on this page had ever called.
 */

import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SeasonProgress } from "../../../src/lib/episodes";
import { VERDICT_COPY } from "../../../src/lib/request-diagnostics";
import type { QuotaState } from "../../../src/lib/request-quota";
import { isWithdrawable } from "../../../src/lib/request-withdrawal";
import { ConfirmAction } from "../components/ConfirmAction";
import { PlayOnPlex } from "../components/PlayOnPlex";
import { Poster } from "../components/Poster";
import { ProgressBar, RequestVerdictPanel } from "../components/RequestProgress";
import { RequestsHeader } from "../components/RequestsHeader";
import {
  getRequests,
  type MediaRequest,
  markRequestsSeen,
  patchTitleState,
  retryRequest,
  withdrawRequest,
} from "../lib/api";
import { useApp } from "../lib/app-context";
import { BUCKET_LABEL, groupByState, hasWorkInFlight, newsFirst, seasonLine } from "../lib/request-log";
import { LINK_BUTTON } from "../lib/ui";

/**
 * Undo one ask, behind a confirmation.
 *
 * The two-click guard, the busy lock and where the failure lands are `ConfirmAction`'s --
 * this component owns only what is specific to a request: which ones may be withdrawn at
 * all, and what withdrawing has to clean up afterwards.
 *
 * A request that has ARRIVED offers no control at all, and WHICH statuses those are is
 * `isWithdrawable` -- the same function the server refuses with, so a button can never
 * promise something the endpoint declines. Removing the media itself is a library operation
 * and belongs in the arr.
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
  if (!isWithdrawable(request.status)) return null;

  return (
    <div>
      <ConfirmAction
        label="Withdraw"
        question="Withdraw this request?"
        confirmLabel="Yes, withdraw"
        busyLabel="Withdrawing…"
        cancelLabel="Keep it"
        onConfirm={async () => {
          await withdrawRequest(request.tconst);
          // Every cached view of this title still carries the request badge, so it is cleared
          // through the shared caches rather than by reloading each of them -- the same call
          // `RootLayout` makes when a request fails to go out.
          patchTitleState(request.tconst, { requestStatus: null });
          onWithdrawn();
        }}
      />
    </div>
  );
}

/**
 * Ask again for something that dead-ended.
 *
 * `POST /api/requests/:tconst/retry` has existed since requests did and NOTHING on this page
 * called it -- `RootLayout` reaches for it only from the toast a failed POST raises, which is
 * gone the moment the reader looks away. So the one screen dedicated to watching requests
 * offered no way to act on the ones that had stopped, which is the dead end this product
 * refuses everywhere else.
 *
 * NO CONFIRMATION, unlike `WithdrawControl` beside it, and the asymmetry is the point:
 * withdrawing destroys an ask and cannot be undone, while retrying re-queues one and costs an
 * indexer search. A guard on a harmless verb teaches readers to click through guards.
 *
 * Offered on DEAD ENDS ONLY -- the tone, never a list of verdicts, so a verdict added to
 * `VERDICT_COPY` lands in the right place here without this file being edited. A retry on
 * something already downloading would cancel and re-search a download in progress.
 */
export function RetryControl({ request, onRetried }: { request: MediaRequest; onRetried: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!request.requestVerdict || VERDICT_COPY[request.requestVerdict].tone !== "dead_end") return null;

  const retry = async () => {
    setBusy(true);
    setError(null);
    try {
      await retryRequest(request.tconst);
      // Every cached view of this title still shows the failure, so it is corrected through
      // the shared caches rather than by reloading each of them -- the same call and the same
      // reason as `WithdrawControl` above.
      patchTitleState(request.tconst, { requestStatus: "queued" });
      onRetried();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <button type="button" onClick={() => void retry()} disabled={busy} className={LINK_BUTTON}>
        {busy ? "Asking again…" : "Try again"}
      </button>
      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  );
}

/**
 * What a reader may DO about one request: play it if Plex holds it, ask again if it stopped,
 * withdraw it if it has not arrived. They are not alternatives -- a series can be
 * half-playable and still downloading -- so this draws whichever the row has earned rather
 * than choosing between them.
 *
 * A FRAGMENT AND NOT A ROW. The caller owns the layout, because every control here can
 * legitimately be absent and a wrapper drawn here would leave an empty box on a row that
 * earned nothing -- which is also what lets a test assert the empty case as an empty string.
 *
 * Exported for its test, and it exists as a component for the same reason `WithdrawControl`
 * does: the rule worth pinning is which affordance a given row earns, and asserting that
 * through the whole route would need a router and an `AppProvider` to say something that is
 * true of one row.
 */
export function RequestActions({
  request,
  onWithdrawn,
}: {
  request: MediaRequest;
  /** Reload the list. One read after a withdraw OR a retry -- both change what the arr is doing. */
  onWithdrawn: () => void;
}) {
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
      <RetryControl request={request} onRetried={onWithdrawn} />
      <WithdrawControl request={request} onWithdrawn={onWithdrawn} />
    </>
  );
}

export function RequestsRoute() {
  const [requests, setRequests] = useState<MediaRequest[] | null>(null);
  /**
   * Where this reader stands against the daily limit, or null when it does not apply to them
   * or nothing has loaded yet. It rides on the same response as the rows -- see
   * `RequestsResponse.quota` -- so the header can never quote an allowance from one moment
   * beside a list from another.
   */
  const [quota, setQuota] = useState<QuotaState | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Everything that has been news at any point during this visit. See `newsFirst`. */
  const news = useRef<Set<string>>(new Set());
  const { requestsTick } = useApp();

  /** Fetch the caller's rows, and say whether any of them are news to them. */
  const load = useCallback(async (): Promise<boolean> => {
    try {
      const { requests, quota } = await getRequests({ mine: true });
      for (const r of requests) if (r.isNew) news.current.add(r.tconst);
      setRequests(newsFirst(requests, news.current));
      setQuota(quota);
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

  // Partitioned ONCE, and both the header's counts and the headings below read the same
  // array. Two calls would be two chances for a summary to disagree with the list it summarises.
  const groups = groupByState(requests);

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
    /*
      WIDER THAN `max-w-prose`, which was right for a column of sentences and wrong the moment
      a poster went next to one: 65 characters of measure left a desktop half empty and squeezed
      the row into a poster, a title and nothing else. `max-w-3xl` still bounds the line length
      of the verdict sentences, which is what the prose measure was actually protecting.
    */
    <div className="max-w-3xl">
      <RequestsHeader groups={groups} quota={quota} working={working} />
      <div className="mt-6 flex flex-col gap-8">
        {groups.map(({ bucket, rows }) => (
          <section key={bucket}>
            {/*
              The heading carries its own count, so a group that scrolled away from the header
              still says how big it is. `groupByState` drops empty buckets, so a heading here
              always has rows under it -- "Needs attention (0)" reads as a warning at a glance.
            */}
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted">
              {BUCKET_LABEL[bucket]} <span className="tabular-nums">({rows.length})</span>
            </h2>
            <ul className="mt-3 flex flex-col gap-5">
              {rows.map((request) => (
                <RequestRow key={request.tconst} request={request} onChanged={load} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

/**
 * One request: what it is, where it has got to, and what may be done about it.
 *
 * Its own component now that the list is grouped -- the route's job became "which rows go
 * under which heading" and a forty-line row body inside two nested maps is where that stops
 * being readable. Nothing here decides anything: every fact is a field the server sent.
 */
function RequestRow({ request, onChanged }: { request: MediaRequest; onChanged: () => void }) {
  const seasons = seasonLine(request);

  return (
    <li className="flex gap-3">
      {/*
        ORIENTATION, not a card. 56 pixels is enough to recognise a film you asked for and not
        enough to turn a state list into a gallery -- `Poster` owns the frame, the fade and
        the fallback, so this is the caller's frame and nothing else. `plain` because a strip
        of coloured monogram tiles beside a list of titles is noise at this size; the tile
        fallback is for a grid that is mostly poster.
      */}
      <Poster
        title={request}
        size="w154"
        /*
          `self-start` is not cosmetic: a flex child defaults to `stretch`, so the frame grew
          to the height of the row beside it and `aspect-2/3` lost -- a browser drew Inception
          at 56x138 and Breaking Bad, whose row is taller for its season lines, at 56x190. Both
          were the same poster cropped to two different shapes on one screen.
        */
        className="aspect-2/3 w-14 shrink-0 self-start overflow-hidden rounded-md bg-surface-2"
        link
        alt={request.title}
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          {/*
            The title is the way BACK to the thing itself -- to play it if it arrived,
            to see why if it did not. A row that only reported a status would be a
            dead end on the one page a reader visits when they want to act.
          */}
          <Link to="/title/$tconst" params={{ tconst: request.tconst }} className="truncate hover:underline">
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
          {seasons && <span className="ml-auto shrink-0 text-xs text-muted">{seasons}</span>}
        </div>

        <div className="mt-1.5">
          <RequestVerdictPanel
            state={request}
            // The row's own sanitised reason when there is one -- it is more specific
            // than the verdict's sentence. See `RequestVerdictPanel`.
            error={request.error}
          />
        </div>

        <SeasonProgressRows progress={request.seasonProgress} />

        {/*
          ONE ROW OF VERBS, because two of them stacking is what a browser showed: "Try again"
          on its own line above "Withdraw" reads as two decisions rather than one choice
          between them. The container is here rather than in `RequestActions` so that a row
          which earns no control at all draws nothing rather than an empty box.

          Reloading the whole list rather than splicing the row out locally: the poll
          that feeds this page is the server's, and a withdraw also frees a quota row
          and can change what the arr is doing. One read gives the true state of all of
          it, and the same read is what the tick above asks for.
        */}
        <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <RequestActions request={request} onWithdrawn={onChanged} />
        </div>
      </div>
    </li>
  );
}

/**
 * How far each requested season has got -- the one-line "Seasons 1-2" broken open.
 *
 * A series downloading four episodes across two seasons had a bar for the whole ask and a
 * text line naming the seasons, and no way to tell which of the two was moving.
 * `request_diagnostic` cannot answer that -- it is keyed on `tconst` alone -- so the counts
 * come from Sonarr's episode mirror and are computed by `seasonProgress` on the server.
 *
 * NOTHING AT ALL for a film, for a series Sonarr does not mirror, or for a single-season ask,
 * and the last of those is the interesting one: one row saying "Season 3 — 8 of 10" under a
 * bar that already says 80% is the same fact twice. The breakdown earns its space only when
 * there is something to break down.
 */
function SeasonProgressRows({ progress }: { progress: readonly SeasonProgress[] }) {
  if (progress.length < 2) return null;

  return (
    <ul className="mt-1.5 flex flex-col gap-1">
      {progress.map(({ season, held, aired }) => (
        <li key={season} className="flex items-baseline gap-2 text-xs text-muted">
          <span>Season {season}</span>
          <span className="tabular-nums">
            {held} of {aired}
          </span>
          {/*
            The bar is the same component the verdict panel draws, so a season line and the
            request above it can never render progress two different ways. `aired` is never
            zero -- `seasonProgress` reports no row for a season with nothing aired.
          */}
          <span className="ml-auto w-24 shrink-0">
            <ProgressBar value={held / aired} />
          </span>
        </li>
      ))}
    </ul>
  );
}
