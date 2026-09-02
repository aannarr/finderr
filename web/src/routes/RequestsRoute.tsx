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
import { RequestVerdictPanel } from "../components/RequestProgress";
import { getRequests, type MediaRequest, markRequestsSeen } from "../lib/api";
import { summariseSeasons } from "../lib/season-select";

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

/** "Seasons 1-3", when the reader chose some. Null for a film or for "all". */
function seasonLine(request: MediaRequest): string | null {
  if (!request.seasons) return null;
  const numbers = request.seasons
    .split(",")
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n));
  return numbers.length > 0 ? summariseSeasons(numbers) : null;
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
            </li>
          );
        })}
      </ul>
    </div>
  );
}
