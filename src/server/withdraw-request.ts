/**
 * "I asked for the wrong thing" -- undoing a request, and nothing more than the request.
 *
 * The gap this closes is the one `README.md` named: without it, changing your mind means
 * opening Radarr, which is exactly the thing finderr exists so nobody has to do.
 *
 * > [!CAUTION] WITHDRAWING IS NOT DELETING, and the line between them is the whole design
 * > This module removes finderr's own record of an ask and switches monitoring off in the
 * > arr so nothing keeps searching. It never removes a movie or a series from Radarr or
 * > Sonarr and it never touches a file. The arr brief's standing rule for media is
 * > replacement-first -- download the replacement, verify it is better, then delete -- and a
 * > one-click control in a household web app is the wrong place to spend that decision.
 * > Removing the media itself stays a library operation, done in the arr.
 * >
 * > The safety is structural rather than remembered: the only arr call reachable from here
 * > is `ArrUnmonitor.unmonitor`, whose transport is `PUT /{movie,series}/editor` -- an
 * > endpoint whose destructive form is a different HTTP verb. See `unmonitorVia`.
 *
 * Everything it touches is injected, so the whole policy runs in a test against two plain
 * objects with no SQLite, no arr and no network -- the same shape `./diagnose-requests.ts`
 * uses one layer down.
 */

import { ArrError, type ArrUnmonitor, safeArrMessage } from "../lib/arr";
import type { Role } from "../lib/auth";
import { isWithdrawable } from "../lib/request-withdrawal";
import type { MediaRequest, Store } from "../lib/store";

/** Only what this module calls, so a test hands over an object literal. */
export interface WithdrawDeps {
  store: Pick<Store, "getRequest" | "deleteRequest">;
  radarr?: ArrUnmonitor;
  sonarr?: ArrUnmonitor;
  log: (...args: unknown[]) => void;
}

/** The caller, reduced to the two facts the rule reads. */
export interface Withdrawer {
  /** Null for the system API key, which is not a person and owns no requests. */
  userId: string | null;
  role: Role | null;
}

/**
 * What happened, as a discriminated union rather than a Response.
 *
 * The HTTP spelling belongs to the route; what belongs here is the DECISION, and keeping the
 * two apart is what lets every branch below be asserted without parsing a body.
 */
export type WithdrawOutcome =
  | {
      ok: true;
      /** True when the arr was actually told to stop. False when there was nothing of ours there. */
      unmonitored: boolean;
    }
  | { ok: false; status: number; error: string };

/**
 * Every refusal that must not say whether the row exists, said once.
 *
 * A request you did not make and a title nobody asked for have to be INDISTINGUISHABLE, or
 * the endpoint becomes an oracle for "who has asked for what" -- the exact fact
 * `visibleRequest` strips from the log for everybody but an admin. Same argument as
 * `adminPrincipal` answering a signed-in non-admin with 404: the surface does not announce
 * itself.
 */
const UNKNOWN: WithdrawOutcome = { ok: false, status: 404, error: "unknown request" };

/**
 * May this caller undo this ask?
 *
 * The requester or an admin, and the requester is read from the STORED row -- never from
 * anything the browser sent back, which for an ordinary user does not even contain the field
 * (`visibleRequest` strips `requested_by` on the way out).
 *
 * A row with no requester (`requested_by: null` -- an agent acting on nobody's behalf) is
 * withdrawable by an admin alone: there is no person for it to belong to, and letting the
 * next signed-in reader claim it would make "nobody's" mean "everybody's".
 */
function mayWithdraw(row: MediaRequest, by: Withdrawer): boolean {
  if (by.role === "admin") return true;
  return by.userId !== null && row.requested_by === by.userId;
}

/**
 * Withdraw one request: stop the arr searching for it, then forget it.
 *
 * THE ORDER IS DELIBERATE -- the arr first, our row second. A row deleted before a failed
 * unmonitor would leave a title being searched for that finderr no longer knows about, which
 * is unreachable from the UI and therefore permanent. Doing it this way, a failed unmonitor
 * leaves everything exactly as it was and the reader can press the button again.
 *
 * Which statuses may be withdrawn is `isWithdrawable`, in `../lib/request-withdrawal.ts`,
 * because the browser has to answer the same question to decide whether to draw the control
 * at all -- and a rule written out in both places is a button that promises something this
 * function refuses.
 */
export async function withdrawRequest(
  deps: WithdrawDeps,
  tconst: string,
  by: Withdrawer,
): Promise<WithdrawOutcome> {
  const row = deps.store.getRequest(tconst);
  if (!row) return UNKNOWN;
  if (!mayWithdraw(row, by)) {
    deps.log(`withdraw refused for ${by.userId ?? "unknown"}: ${tconst} is not theirs`);
    return UNKNOWN;
  }
  if (!isWithdrawable(row.status)) {
    return {
      ok: false,
      status: 409,
      error: "it has already arrived -- remove it in Radarr or Sonarr if you no longer want it",
    };
  }

  const stopped = await stopSearching(deps, row);
  if (!stopped.ok) return stopped;

  deps.store.deleteRequest(tconst);
  deps.log(`withdraw: "${row.title}" (${tconst})${stopped.unmonitored ? ", unmonitored" : ""}`);
  return stopped;
}

/**
 * Tell the arr to stop looking, IF the thing it would stop looking for is ours to switch off.
 *
 * > [!IMPORTANT] `arr_id` is the whole test, and it is stronger than asking the library mirror
 * > It is written in exactly one place -- `RequestWorker.process`, from the id the arr
 * > returned when OUR add created the row. Every other path leaves it null, and the one that
 * > matters is the "already exists" arm: when the arr answers 400 because somebody else had
 * > already added the title, the worker marks the request `sent` and deliberately records no
 * > id. So a null `arr_id` means "we never put anything in the arr", and switching monitoring
 * > off would be reaching into somebody else's library row.
 * >
 * > The mirror cannot answer this as precisely. `library` carries the arr's own `added_at`,
 * > which is null for rows mirrored before that column existed and is a timestamp from
 * > another machine's clock either way -- so "was it there before the request" becomes a
 * > comparison that is merely usually right. `arr_id` is a record of what WE did.
 *
 * A `queued` request has no id for the same reason and needs no call: the worker has not run,
 * so nothing upstream has been asked for anything yet.
 *
 * A 404 from the arr is SUCCESS, not a failure. It means the row we added is gone -- somebody
 * removed it by hand -- so the state the caller asked for ("stop searching for this") already
 * holds, and refusing the withdraw would strand a row nothing can act on.
 */
async function stopSearching(deps: WithdrawDeps, row: MediaRequest): Promise<WithdrawOutcome> {
  if (row.arr_id === null) return { ok: true, unmonitored: false };

  const client = row.service === "radarr" ? deps.radarr : deps.sonarr;
  if (!client) {
    return { ok: false, status: 503, error: `${row.service} is not configured` };
  }

  try {
    await client.unmonitor(row.arr_id);
    return { ok: true, unmonitored: true };
  } catch (err) {
    if (err instanceof ArrError && err.status === 404) {
      deps.log(`withdraw: ${row.service} no longer holds ${row.tconst} (id ${row.arr_id})`);
      return { ok: true, unmonitored: false };
    }
    // SANITISED, for the reason `safeArrMessage` exists: an arr's own error text quotes its
    // response body, which carries root folder paths and internal hostnames, and this string
    // is going to a browser. The full message stays in the log.
    deps.log(`withdraw FAILED "${row.title}": ${(err as Error).message}`);
    return { ok: false, status: 502, error: safeArrMessage(err) };
  }
}
