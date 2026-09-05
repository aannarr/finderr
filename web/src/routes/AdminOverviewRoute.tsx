/**
 * `/admin` -- the shape of the household, in four numbers.
 *
 * Every number is a WAY IN rather than a readout: an operator who opens this page is on the
 * way to a person, an invitation or the log, so each tile is the link to the screen that
 * answers it. A dashboard whose figures cannot be clicked makes the reader find the same
 * page again by hand.
 *
 * > [!NOTE] Server health belongs here and is deliberately absent
 * > Index rows, arr reachability and the rest of `/api/health` are
 * > `site-defaults-and-an-operator-dashboard-on-admin`, which depends on this card and fills
 * > the gap below the tiles. Half of it built here would be the half that has to be torn out.
 */

import { Link, type LinkProps } from "@tanstack/react-router";
import { type AdminInvite, type AdminUser, adminRequests, listInvites, listUsers } from "../lib/auth-api";
import { useAsyncData } from "../lib/use-async-data";

interface Overview {
  users: AdminUser[];
  invites: AdminInvite[];
  requests: number;
}

async function loadOverview(): Promise<Overview> {
  const [u, i, r] = await Promise.all([listUsers(), listInvites(), adminRequests()]);
  return { users: u.users, invites: i.invites, requests: r.requests.length };
}

/** One figure and the page it leads to. `detail` is the second line, or nothing. */
function Tile(props: { to: LinkProps["to"]; label: string; value: number; detail?: string }) {
  return (
    <Link
      to={props.to}
      className="flex flex-col gap-1 rounded-lg border border-line bg-surface px-4 py-3 hover:border-accent/60"
    >
      <span className="text-2xl font-semibold tabular-nums">{props.value}</span>
      <span className="text-sm">{props.label}</span>
      {props.detail && <span className="text-xs text-muted">{props.detail}</span>}
    </Link>
  );
}

/** "2 administrators · 1 disabled", with the parts that are zero left out entirely. */
function peopleDetail(users: AdminUser[]): string {
  const admins = users.filter((u) => u.role === "admin").length;
  const disabled = users.filter((u) => u.disabled).length;
  return [
    `${admins} administrator${admins === 1 ? "" : "s"}`,
    ...(disabled > 0 ? [`${disabled} disabled`] : []),
  ].join(" · ");
}

export function AdminOverviewRoute() {
  // `loadOverview` is module-level and therefore already stable -- no `useCallback` needed.
  const { data, error } = useAsyncData(loadOverview);

  if (error) return <p className="text-sm text-danger">{error}</p>;
  if (!data) return <p className="text-sm text-muted">Loading…</p>;

  const outstanding = data.invites.filter((i) => !i.redeemedAt);

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Tile to="/admin/users" label="People" value={data.users.length} detail={peopleDetail(data.users)} />
      <Tile
        to="/admin/invites"
        label="Outstanding invitations"
        value={outstanding.length}
        detail={outstanding.length === 0 ? "Nobody is waiting to join." : undefined}
      />
      <Tile
        to="/log"
        label="Requests"
        value={data.requests}
        detail="Who asked is shown to administrators only."
      />
    </div>
  );
}
