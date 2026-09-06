/**
 * Which requests may be withdrawn. One rule, and only the rule.
 *
 * Pure -- no SQLite, no HTTP -- for the same reason `./request-diagnostics.ts` is: the
 * BROWSER decides whether to draw a Withdraw control and the SERVER decides whether to
 * honour one, and those are the same question asked twice. Written out in both places they
 * drift, and the drift is silent in the worst direction: a button that promises something
 * the server refuses. `web/src/routes/RequestsRoute.tsx` and `../server/withdraw-request.ts`
 * both read this file.
 *
 * The RULE is here; the AUTHORISATION is not. Who may withdraw depends on a stored
 * `requested_by` the browser is never shown (`visibleRequest` strips it), so it can only be
 * decided on the server and lives there -- see `mayWithdraw`.
 */

/**
 * `available` is the one request a reader may not take back, and refusing it is the whole
 * boundary of this feature.
 *
 * It arrived. There is nothing left to stop searching for, so the only thing "withdraw"
 * could still mean is removing the media, which is a destructive library operation and a
 * different act with a different rule -- `isRemovable` in `./media-removal.ts`, admin-only,
 * and offered on `/requests` and `/log` alone. Everything else, from `queued` through
 * `failed`, is an ask that has not landed yet and is the reader's to cancel.
 *
 * `removed` is refused too, and it is the one status neither this nor `isRemovable` accepts.
 * The media is gone and the row is the RECORD of an admin having removed it, so withdrawing
 * would delete the log entry that explains where a household's film went. Asking for it again
 * is what revives the row -- see `RequestStatus.removed`.
 *
 * The parameter is `string` rather than `RequestStatus` on purpose: `RequestStatus` is
 * declared in `./store.ts`, which opens SQLite, and the browser's own `MediaRequest.status`
 * is deliberately a plain string -- the client is not given the state machine's vocabulary,
 * it is given a verdict to render. Widening here is what lets both sides call one function.
 */
export function isWithdrawable(status: string): boolean {
  return status !== "available" && status !== "removed";
}
