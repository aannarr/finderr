/**
 * `/admin/invites` -- mint a way in, and see who has not walked through yet.
 *
 * Split off the people page because an invitation is not a person: it is a token with an
 * expiry, and the only thing it has in common with an account is that one becomes the other.
 * Keeping them on one screen meant the list of people opened with a form for making more.
 *
 * Revoke IS here and is not the destructive action the user page defers. It voids an unused
 * token -- nobody loses access, because nobody has any yet -- and its consequence is another
 * invitation. That is why it survives on a row while promote and remove do not.
 */

import { useState } from "react";
import { ShowOnceSecret } from "../components/ShowOnceSecret";
import { type AdminInvite, createInvite, listInvites, type Role, revokeInvite } from "../lib/auth-api";
import { formatStamp } from "../lib/timestamps";
import { LINK_BUTTON } from "../lib/ui";
import { useAsyncData } from "../lib/use-async-data";

async function loadInvites(): Promise<AdminInvite[]> {
  return (await listInvites()).invites;
}

export function AdminInvitesRoute() {
  const { data, error, act } = useAsyncData(loadInvites);
  /**
   * A minted invite link, shown ONCE.
   *
   * The server stores only the token's hash, so this string cannot be listed again anywhere
   * -- if it is lost, the answer is to mint another rather than to recover it. Saying so
   * beside the link is what stops somebody closing the page expecting to find it later.
   */
  const [freshLink, setFreshLink] = useState<string | null>(null);
  const [role, setRole] = useState<Role>("user");
  const [name, setName] = useState("");

  const mint = () =>
    act(async () => {
      const { url } = await createInvite({ role, displayName: name.trim() || undefined });
      setFreshLink(url);
      setName("");
    });

  return (
    <div className="flex flex-col gap-8">
      {/* Server refusals are real answers here -- "that is the last admin" is worth reading
          rather than flattening into a generic failure. */}
      {error && <p className="text-sm text-danger">{error}</p>}

      <section>
        <h2 className="text-sm font-medium">Invite someone</h2>
        <form
          className="mt-2 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void mint();
          }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Their name (optional)"
            className="rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent/60"
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            aria-label="What they may do"
            className="rounded-lg border border-line bg-surface px-3 py-2 text-sm"
          >
            <option value="user">Member</option>
            <option value="admin">Administrator</option>
          </select>
          <button type="submit" className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-bg">
            Create link
          </button>
        </form>

        {freshLink && (
          <ShowOnceSecret
            note="Send this now -- it is not stored and cannot be shown again."
            value={freshLink}
          />
        )}
      </section>

      <section>
        <h2 className="text-sm font-medium">Invitations</h2>
        {!data ? (
          <p className="mt-2 text-sm text-muted">Loading…</p>
        ) : data.length === 0 ? (
          <p className="mt-2 text-sm text-muted">None outstanding.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {data.map((i) => (
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
    </div>
  );
}
