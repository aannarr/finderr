/**
 * Which requests may have their MEDIA removed, and what the confirmation is entitled to say.
 *
 * The sibling of `./request-withdrawal.ts` at the other end of a request's life, and pure for
 * the same reason: the BROWSER decides whether to draw a Remove control and the SERVER decides
 * whether to honour one, and a rule written out in both places drifts into a button that
 * promises something the endpoint declines.
 *
 * > [!CAUTION] REMOVING IS NOT WITHDRAWING, and the two are deliberately disjoint
 * > Withdrawing calls off an ask that has not landed and never touches a file
 * > (`../server/withdraw-request.ts`). Removing acts on media that HAS landed, deletes the
 * > arr's library entry and -- when asked -- the files under it. Every status is on exactly one
 * > side of that line, except `removed` itself, which is on neither: it is where a removal
 * > leaves the row, and there is nothing left to withdraw or remove.
 *
 * The RULE is here; the AUTHORISATION is not. Only an admin may remove, and that is enforced
 * by the route living under `/api/admin/` -- see `auth.requireAdmin`, the one owner of it.
 */

/**
 * Has this request's media arrived, so that there is something to take back out?
 *
 * `available` alone. Everything earlier is an ask still in flight, which is withdrawn rather
 * than removed; and a partially-downloaded series has nothing an operator would call "the
 * media", so offering to delete it would be offering to delete a work in progress.
 *
 * The parameter is `string` rather than `RequestStatus` for the reason `isWithdrawable` gives:
 * `RequestStatus` is declared in `./store.ts`, which opens SQLite, and the browser's own
 * `MediaRequest.status` is a plain string.
 */
export function isRemovable(status: string): boolean {
  return status === "available";
}

/**
 * What is about to be deleted, as the confirmation must state it before anybody says yes.
 *
 * ONE shape, declared here and re-exported by `web/src/lib/api.ts`, so the sentence a reader
 * sees and the facts the server gathered cannot describe different things. Everything on it is
 * read LIVE from the arr and from the Plex mirror at the moment the question is asked -- a
 * confirmation built from cached numbers is a confirmation about a file that may already have
 * been upgraded.
 */
export interface MediaRemovalPreview {
  tconst: string;
  title: string;
  year: number | null;
  service: "radarr" | "sonarr";
  /** Files the arr holds. 0 or 1 for a film; the episode file count for a series. */
  files: number;
  /** Total bytes on disk, or null when the arr reports none. */
  bytes: number | null;
  /** The arr's quality name, or null -- always null for a series. See `ArrHoldings`. */
  quality: string | null;
  /**
   * Does PLEX still hold this?
   *
   * From `plex_item` and never from the arr's `hasFile`: the two answer different questions,
   * and only this one says whether the household would notice the thing disappear from the
   * app they actually watch in. A `true` here with `deleteFiles: false` is the case worth
   * spelling out -- the arr forgets the title and Plex keeps playing it.
   */
  inPlex: boolean;
}

/**
 * A removal as the LOG shows it: who did it, when, and whether the files went too.
 *
 * ADMIN-ONLY, and ABSENT rather than null for everybody else -- the same rule and the same
 * spelling as `requestedByName`, because "who removed what" is the same class of fact as "who
 * requested what". The absence IS the permission: nothing in the browser re-decides it.
 *
 * Declared here beside the preview rather than in `web/src/lib/api.ts`, so the server's shape
 * and the client's are one type and not two that drift.
 */
export interface RequestRemovalView {
  /** The admin's user id, or null for the system key. */
  by: string | null;
  /** What to print. `(removed)` for an account that no longer exists, null for the system key. */
  byName: string | null;
  at: string;
  deletedFiles: boolean;
  /** Bytes the arr reported holding at the moment it went, or null. */
  bytes: number | null;
}
