/**
 * `/admin/users` -- everybody with an account, one row each.
 *
 * > [!IMPORTANT] A ROW IS A LINK, AND CARRIES NO ACTIONS
 * > The page this replaces put "Make admin", "Disable", "Reset access" and "Remove" inline
 * > on every row, four identical-looking text buttons wide, with the destructive one last
 * > and unconfirmed. A list is for FINDING somebody; doing something to them is a decision
 * > taken while looking at them, which is what the person page is for. The actions land
 * > there together, each with its own confirmation -- see
 * > `admin-user-actions-per-user-quota-and-the-assistant-toggle`.
 *
 * Five facts per row and they are the five an operator scans for: who, what they may do,
 * whether they are shut out, when they were last here, and whether they have been busy.
 */

import { Link } from "@tanstack/react-router";
import { type AdminUser, listUsers } from "../lib/auth-api";
import { formatStamp } from "../lib/timestamps";
import { useAsyncData } from "../lib/use-async-data";

async function loadUsers(): Promise<AdminUser[]> {
  return (await listUsers()).users;
}

/** The word for what somebody may do here. `Role` is the server's spelling, not a reader's. */
function roleLabel(user: AdminUser): string {
  return user.role === "admin" ? "Administrator" : "Member";
}

/**
 * The rows, from props alone -- so the shape of the list can be asserted without a fetch.
 *
 * Exported for `AdminUsersRoute.test.tsx`, which is where "a row is a link and holds no
 * button" is pinned. That is the regression worth guarding: it is one careless restyle away.
 */
export function PeopleList({ users }: { users: AdminUser[] }) {
  if (users.length === 0) {
    return <p className="text-sm text-muted">Nobody has an account yet. Invite somebody to start.</p>;
  }
  return (
    <ul className="flex flex-col divide-y divide-line border-y border-line">
      {users.map((u) => (
        <li key={u.id}>
          <Link
            to="/admin/users/$id"
            params={{ id: u.id }}
            className="grid items-baseline gap-x-3 gap-y-1 py-3 hover:text-ink sm:grid-cols-[1fr_9rem_8rem_7rem]"
          >
            <span className="truncate text-sm">
              {u.displayName}
              {u.disabled && <span className="ml-2 text-xs text-danger">disabled</span>}
            </span>
            <span className="text-xs text-muted">{roleLabel(u)}</span>
            <span className="text-xs text-muted">last seen {formatStamp(u.lastSeenAt, "never")}</span>
            {/*
              Zero is drawn rather than hidden: "nothing this week" is a fact about a person,
              and a blank cell reads as a column that failed to load.
            */}
            <span className="text-xs text-muted tabular-nums">{u.requestsThisWeek} this week</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function AdminUsersRoute() {
  const { data, error } = useAsyncData(loadUsers);

  if (error) return <p className="text-sm text-danger">{error}</p>;
  if (!data) return <p className="text-sm text-muted">Loading…</p>;
  return <PeopleList users={data} />;
}
