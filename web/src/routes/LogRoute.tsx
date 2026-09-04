/**
 * `/log` -- the request log. What was asked for, when, and (for an admin) by whom.
 *
 * > [!IMPORTANT] The log is for EVERYBODY; the WHO column is not
 * > aannarr, 2026-09-04: *"I need to see what was requested when, and by who.. only admins
 * > can see who!"*. Those are two rules and only the second one is a privacy rule. A shared
 * > household knowing that somebody already asked for a film is the point of a shared
 * > request queue -- it is what stops three people asking for the same thing and what makes
 * > "is it coming?" answerable without asking an admin. Which of them asked is the part that
 * > stays with the admins.
 * >
 * > So this page draws the same rows for everyone and simply has one fewer column for most
 * > readers, and it does not decide that for itself: `attributionVisible` asks whether the
 * > SERVER sent attribution. `attributedRequest` (`src/lib/auth.ts`) omits the key for
 * > anybody who is not an admin, so there is nothing in an ordinary reader's JSON to hide.
 * > A component that merely declined to draw a name it had been sent would be the bug.
 *
 * `/requests` is the neighbouring page and a different question: it is YOURS, scoped by the
 * server, and it is where the ready badge goes. This one is the whole house.
 */

import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ToggleChip } from "../components/Chip";
import { VerdictChip } from "../components/RequestProgress";
import { getRequests, type MediaRequest } from "../lib/api";
import { attributionVisible, byRequester, logOrder, requesters, seasonLine } from "../lib/request-log";
import { formatAge, formatStamp } from "../lib/timestamps";

export function LogRoute() {
  const [rows, setRows] = useState<MediaRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Which person the log is narrowed to. `undefined` is everybody, `null` is the rows nobody
   * is attached to -- a real selection rather than the absence of one. See `byRequester`.
   */
  const [who, setWho] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    /*
      No `mine` -- this is the whole log, which every signed-in reader may see.

      Loaded ONCE rather than polled. `RootLayout` already polls this same endpoint every
      eight seconds for the queue and ready badges, so a second timer here would buy a
      seldom-watched page a repaint it did not ask for; a reader who wants the newest state
      of a request they are waiting on is on `/requests`, which is where the badge sends them.
    */
    getRequests()
      .then(({ requests }) => setRows(requests))
      .catch((e) => setError((e as Error).message));
  }, []);

  const people = useMemo(() => (rows ? requesters(rows) : []), [rows]);
  const visible = useMemo(() => (rows ? logOrder(byRequester(rows, who)) : []), [rows, who]);

  if (error) return <p className="text-sm text-danger">{error}</p>;
  if (!rows) return <p className="text-sm text-muted">Loading…</p>;

  const showWho = attributionVisible(rows);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Request log</h1>
        <p className="mt-1 text-sm text-muted">
          Everything this server has been asked for, newest first.
          {showWho && " Who asked is shown to administrators only."}
        </p>
      </div>

      {/*
        The filter bar exists only where there is something to filter ON, so an ordinary
        reader gets no empty row of chrome and a household of one gets no chip that does
        nothing. `ToggleChip` is the product's one selectable chip -- the same control the
        season selector and the search refinements use.
      */}
      {showWho && people.length > 1 && (
        <div className="flex flex-wrap gap-2">
          <ToggleChip
            label="Everyone"
            count={rows.length}
            active={who === undefined}
            onClick={() => setWho(undefined)}
          />
          {people.map((p) => (
            <ToggleChip
              key={p.id ?? "unattributed"}
              label={p.name}
              count={p.count}
              active={who === p.id}
              onClick={() => setWho(who === p.id ? undefined : p.id)}
            />
          ))}
        </div>
      )}

      {visible.length === 0 ? (
        <p className="text-sm text-muted">
          {rows.length === 0
            ? "Nothing has been requested yet. Search for a film or a series and press Request."
            : "Nobody has asked for anything under that filter."}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-line border-y border-line">
          {visible.map((row) => {
            const seasons = seasonLine(row);
            const age = formatAge(row.created_at);
            return (
              <li
                key={row.tconst}
                /*
                  WHO, WHAT, WHEN -- in that order, and it is the order the question was
                  asked in. It collapses to a single column below `sm`, where three columns
                  of a title's length do not fit and the name is the least of the three.
                */
                className={`grid items-baseline gap-x-3 gap-y-1 py-2 ${
                  showWho ? "sm:grid-cols-[9rem_1fr_auto]" : "sm:grid-cols-[1fr_auto]"
                }`}
              >
                {showWho && (
                  <span className="truncate text-sm text-muted" title={row.requestedByName ?? undefined}>
                    {row.requestedByName ?? "—"}
                  </span>
                )}

                <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
                  {/*
                    The title is the way BACK to the thing itself -- to play it if it arrived,
                    or to see why if it did not. Same rule as `/requests`: a log row that only
                    reported a state would be a dead end.
                  */}
                  <Link to="/title/$tconst" params={{ tconst: row.tconst }} className="hover:underline">
                    {row.title}
                  </Link>
                  {row.year !== null && <span className="text-xs text-muted">{row.year}</span>}
                  {seasons && <span className="text-xs text-muted">{seasons}</span>}
                  {row.requestVerdict && (
                    <VerdictChip verdict={row.requestVerdict} progress={row.requestProgress} />
                  )}
                </span>

                {/*
                  The AGE is what a reader converts a date into anyway -- "how long has this
                  been sitting there". The exact stamp is one hover away rather than gone, so
                  nothing is lost by leading with the useful rounding.
                */}
                <span className="text-xs text-muted tabular-nums" title={formatStamp(row.created_at)}>
                  {age}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
