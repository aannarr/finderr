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
import { InertChip } from "../components/Chip";
import { ShowOnceSecret } from "../components/ShowOnceSecret";
import { Empty, Panel } from "../components/settings/Panel";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { type AdminInvite, createInvite, listInvites, type Role, revokeInvite } from "../lib/auth-api";
import { formatStamp } from "../lib/timestamps";
import { useAsyncData } from "../lib/use-async-data";

async function loadInvites(): Promise<AdminInvite[]> {
  return (await listInvites()).invites;
}

/**
 * What an invitation IS right now, as one pill.
 *
 * Three states and they were one run-on sentence -- `unnamed · admin · expires Sep 13, 2026`
 * -- in which the word that mattered was the third of five. A redeemed invitation is spent
 * and a lapsed one is litter, and neither should look like the one still worth sending.
 *
 * Exported and pure, so the expiry boundary can be asserted against a fixed clock rather
 * than against whenever the suite happens to run.
 */
export function inviteState(
  invite: AdminInvite,
  now: Date = new Date(),
): { label: string; tone: "neutral" | "accent" | "warn" } {
  if (invite.redeemedAt) return { label: `Used ${formatStamp(invite.redeemedAt)}`, tone: "neutral" };
  // ISO strings compare correctly as strings, which is the same reason every stamp in this
  // product is TEXT -- but the comparison is done on instants here because `now` is injected.
  if (new Date(invite.expiresAt) <= now) return { label: "Expired", tone: "warn" };
  return { label: `Expires ${formatStamp(invite.expiresAt)}`, tone: "accent" };
}

/** Outstanding first: it is the only group anything can be DONE about. */
export function inviteOrder(invites: readonly AdminInvite[]): AdminInvite[] {
  return [...invites].sort((a, b) => {
    const open = Number(Boolean(a.redeemedAt)) - Number(Boolean(b.redeemedAt));
    if (open !== 0) return open;
    return b.createdAt.localeCompare(a.createdAt);
  });
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
  const [minting, setMinting] = useState(false);

  const mint = () => {
    setMinting(true);
    return act(async () => {
      try {
        const { url } = await createInvite({ role, displayName: name.trim() || undefined });
        setFreshLink(url);
        setName("");
      } finally {
        setMinting(false);
      }
    });
  };

  const invites = data ? inviteOrder(data) : [];

  return (
    <div className="flex flex-col gap-4">
      {/* Server refusals are real answers here -- "that is the last admin" is worth reading
          rather than flattening into a generic failure. */}
      {error && (
        <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      <Panel
        title="Invite someone"
        description="finderr has no sign-up. A link is the only way in, and it is shown once."
      >
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void mint();
          }}
        >
          <div className="flex min-w-48 flex-1 flex-col gap-1.5">
            <Label htmlFor="invite-name">Their name</Label>
            <Input
              id="invite-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Optional"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="invite-role">What they may do</Label>
            {/*
              The registry's Select rather than a bare `<select>`: the native control renders
              its options with the OS's own colours, which on a dark page is a white popup in
              the middle of this one. The trigger is ours and the list is ours.
            */}
            <Select value={role} onValueChange={(v) => setRole(v as Role)}>
              <SelectTrigger id="invite-role" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="user">Member</SelectItem>
                <SelectItem value="admin">Administrator</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Button type="submit" disabled={minting}>
            {minting ? "Creating…" : "Create link"}
          </Button>
        </form>

        {freshLink && (
          <ShowOnceSecret
            note="Send this now -- it is not stored and cannot be shown again."
            value={freshLink}
          />
        )}
      </Panel>

      <Panel title="Invitations" description="Everything minted, whether or not it was used.">
        {!data ? (
          <Empty>Loading…</Empty>
        ) : invites.length === 0 ? (
          <Empty>None yet. Create a link above to let somebody in.</Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {invites.map((i) => {
              const state = inviteState(i);
              return (
                <li
                  key={i.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface-2/40 px-3 py-2.5"
                >
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="truncate text-sm text-ink">{i.displayName ?? "unnamed"}</span>
                    <InertChip label={i.role === "admin" ? "Administrator" : "Member"} />
                    <InertChip label={state.label} tone={state.tone} />
                  </span>
                  {/*
                    STILL NOT BEHIND A CONFIRMATION, and that is this file's own decision
                    rather than an oversight -- see the top of the file. Voiding an unused
                    token costs nobody their access and its consequence is another
                    invitation; wrapping it in `ConfirmAction` would be ceremony on the one
                    harmless verb, which is what teaches somebody to click through the ones
                    that matter. It is a real button now instead of an underlined word,
                    which is the only thing that changed.
                  */}
                  {!i.redeemedAt && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => act(() => revokeInvite(i.id))}
                    >
                      Revoke
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
