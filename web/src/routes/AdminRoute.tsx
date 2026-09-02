/**
 * `/admin` -- people, invitations, and who asked for what.
 *
 * > [!IMPORTANT] This screen is a CONVENIENCE, not the security boundary
 * > Every endpoint it calls refuses a non-admin on the server with a 404, so a user who
 * > types the URL sees empty sections rather than anybody else's data. Nothing here is
 * > hidden by not being drawn -- see `visibleRequest` and `asAdmin` in the server for
 * > where the rule actually lives.
 *
 * The request log with names attached is the reason this page exists at all: aannarr,
 * 2026-08-31, only admins may see who requested what.
 */

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
import { LINK_BUTTON } from "../lib/ui";

function when(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

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
                    {u.credentials === 1 ? "" : "s"} · last seen {when(u.lastSeenAt)}
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
                    {i.redeemedAt ? ` · used ${when(i.redeemedAt)}` : ` · expires ${when(i.expiresAt)}`}
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

      <section>
        <h2 className="text-sm font-medium">Requests</h2>
        <p className="mt-1 text-xs text-muted">Who asked for what. Only administrators can see this.</p>
        <ul className="mt-2 flex flex-col gap-1">
          {requests.map((r) => (
            <li key={r.tconst} className="text-sm">
              {r.title}
              <span className="text-muted">
                {" "}
                · {r.status} · {r.requestedByName ?? "unattributed"} · {when(r.updated_at)}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
