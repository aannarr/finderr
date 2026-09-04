/**
 * `/admin` -- people, invitations, and who asked for what.
 *
 * > [!IMPORTANT] This screen is a CONVENIENCE, not the security boundary
 * > Every endpoint it calls refuses a non-admin on the server with a 404, so a user who
 * > types the URL sees empty sections rather than anybody else's data. Nothing here is
 * > hidden by not being drawn -- see `visibleRequest` and `asAdmin` in the server for
 * > where the rule actually lives.
 *
 * The attributed request log used to be drawn HERE and is now at `/log`, which every reader
 * can open and which draws the requester's name only when the server sent one (aannarr,
 * 2026-08-31: only admins may see who requested what). What is left of it here is the count
 * and the way in -- one renderer of that list, not two.
 */

import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { ShowOnceSecret } from "../components/ShowOnceSecret";
import {
  type AdminInvite,
  type AdminUser,
  type AttributedRequest,
  adminRequests,
  createInvite,
  deleteUser,
  listInvites,
  listUsers,
  patchUser,
  type Role,
  resetUser,
  revokeInvite,
} from "../lib/auth-api";
import { formatStamp } from "../lib/timestamps";
import { LINK_BUTTON } from "../lib/ui";

export function AdminRoute() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [invites, setInvites] = useState<AdminInvite[]>([]);
  const [requests, setRequests] = useState<AttributedRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  /**
   * A minted invite link, shown ONCE.
   *
   * The server stores only the token's hash, so this string cannot be listed again
   * anywhere -- if it is lost, the answer is to mint another rather than to recover it.
   * Saying so beside the link is what stops somebody closing the page expecting to find
   * it later.
   */
  const [freshLink, setFreshLink] = useState<string | null>(null);
  const [role, setRole] = useState<Role>("user");
  const [name, setName] = useState("");

  const load = useCallback(async () => {
    try {
      const [u, i, r] = await Promise.all([listUsers(), listInvites(), adminRequests()]);
      setUsers(u.users);
      setInvites(i.invites);
      setRequests(r.requests);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      // Server refusals here are real answers -- "that is the last admin" is worth reading
      // rather than flattening into a generic failure.
      setError((e as Error).message);
    }
  };

  const mint = () =>
    act(async () => {
      const { url } = await createInvite({ role, displayName: name.trim() || undefined });
      setFreshLink(url);
      setName("");
    });

  const reset = (u: AdminUser) =>
    act(async () => {
      const { url } = await resetUser(u.id);
      setFreshLink(url);
    });

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-xl font-semibold tracking-tight">Administration</h1>

      {error && (
        <p className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-muted">{error}</p>
      )}

      <section>
        <h2 className="text-sm font-medium">Invite someone</h2>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Their name (optional)"
            className="rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent/60"
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            className="rounded-lg border border-line bg-surface px-3 py-2 text-sm"
          >
            <option value="user">Member</option>
            <option value="admin">Administrator</option>
          </select>
          <button
            type="button"
            onClick={mint}
            className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-bg"
          >
            Create link
          </button>
        </div>

        {freshLink && (
          <ShowOnceSecret
            note="Send this now -- it is not stored and cannot be shown again."
            value={freshLink}
          />
        )}
      </section>

      <section>
        <h2 className="text-sm font-medium">People</h2>
        <ul className="mt-2 flex flex-col gap-2">
          {users.map((u) => (
            <li key={u.id} className="rounded-lg border border-line bg-surface px-3 py-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm">
                  {u.displayName}
                  <span className="text-muted">
                    {" "}
                    · {u.role === "admin" ? "administrator" : "member"}
                    {u.disabled ? " · disabled" : ""} · {u.credentials} passkey
                    {u.credentials === 1 ? "" : "s"} · last seen {formatStamp(u.lastSeenAt)}
                  </span>
                </span>
                <span className="flex gap-3">
                  <button
                    type="button"
                    className={LINK_BUTTON}
                    onClick={() =>
                      act(() => patchUser(u.id, { role: u.role === "admin" ? "user" : "admin" }))
                    }
                  >
                    {u.role === "admin" ? "Demote" : "Make admin"}
                  </button>
                  <button
                    type="button"
                    className={LINK_BUTTON}
                    onClick={() => act(() => patchUser(u.id, { disabled: !u.disabled }))}
                  >
                    {u.disabled ? "Enable" : "Disable"}
                  </button>
                  {/*
                    There is no password to reset, so this revokes every credential and
                    session, breaks any Plex link, and hands back a fresh invitation. It is
                    also the decisive fix for a device littered with passkeys from a sign-up
                    that failed part way: with no server-side credential left, there is no
                    longer a right one to hunt for.
                  */}
                  <button type="button" className={LINK_BUTTON} onClick={() => reset(u)}>
                    Reset access
                  </button>
                  <button type="button" className={LINK_BUTTON} onClick={() => act(() => deleteUser(u.id))}>
                    Remove
                  </button>
                </span>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="text-sm font-medium">Invitations</h2>
        {invites.length === 0 ? (
          <p className="mt-2 text-sm text-muted">None outstanding.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {invites.map((i) => (
              <li
                key={i.id}
                className="flex items-baseline justify-between rounded-lg border border-line bg-surface px-3 py-2"
              >
                <span className="text-sm">
                  {i.displayName ?? "unnamed"}
                  <span className="text-muted">
                    {" "}
                    · {i.role}
                    {i.redeemedAt
                      ? ` · used ${formatStamp(i.redeemedAt)}`
                      : ` · expires ${formatStamp(i.expiresAt)}`}
                  </span>
                </span>
                {!i.redeemedAt && (
                  <button type="button" className={LINK_BUTTON} onClick={() => act(() => revokeInvite(i.id))}>
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/*
        The log itself is NOT drawn here any more -- `/log` is the one page that draws it.

        This section used to list every request with its requester, ordered by `updated_at`
        and stamped with it, which is the wrong fact for a log: the worker rewrites that
        column on every status change, so it answers "what moved lately" and not "what was
        asked for when". Two renderers of one list is also two places to fix the next thing
        wrong with it. What survives here is the COUNT and the way in.
      */}
      <section>
        <h2 className="text-sm font-medium">Requests</h2>
        <p className="mt-1 text-xs text-muted">
          {requests.length === 0
            ? "Nobody has asked for anything yet."
            : `${requests.length} request${requests.length === 1 ? "" : "s"} so far. The log shows who asked, and it shows that to administrators only.`}
        </p>
        <Link to="/log" className={`mt-2 inline-block ${LINK_BUTTON}`}>
          Open the request log
        </Link>
      </section>
    </div>
  );
}
