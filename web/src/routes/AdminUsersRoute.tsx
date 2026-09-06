/**
 * `/admin/users` -- everybody with an account, one row each.
 *
 * > [!IMPORTANT] A ROW IS A LINK, AND CARRIES NO ACTIONS
 * > The page this replaces put "Make admin", "Disable", "Reset access" and "Remove" inline
 * > on every row, four identical-looking text buttons wide, with the destructive one last
 * > and unconfirmed. A list is for FINDING somebody; doing something to them is a decision
 * > taken while looking at them, which is what the person page is for. The actions land
 * > there together, each with its own confirmation.
 * >
 * > **The 2026-09-06 restyle did not spend this.** A `⋯` menu per row was the obvious
 * > addition and it is the same rule wearing a hat: it puts "Remove this account" two
 * > clicks from a list where the only thing identifying the target is whichever row the
 * > cursor happened to be over. `AdminUsersRoute.test.tsx` asserts the absence, so a
 * > restyle that reintroduces one fails there rather than in production.
 *
 * Five facts per row and they are the five an operator scans for: who, what they may do,
 * whether they are shut out, when they were last here, and whether they have been busy.
 */

import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { UserAvatar, UserBadges } from "../components/admin/UserIdentity";
import { Input } from "../components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { type AdminUser, listUsers } from "../lib/auth-api";
import { formatStamp } from "../lib/timestamps";
import { count } from "../lib/units";
import { useAsyncData } from "../lib/use-async-data";

async function loadUsers(): Promise<AdminUser[]> {
  return (await listUsers()).users;
}

/** The word for what somebody may do here. `Role` is the server's spelling, not a reader's. */
function roleLabel(user: AdminUser): string {
  return user.role === "admin" ? "Administrator" : "Member";
}

/**
 * Administrators first, then the people who have actually been here, then the rest by name.
 *
 * The list arrived in whatever order the store returned, which put the one account that can
 * change anything somewhere in the middle of twelve that cannot. An operator opening this
 * page is looking for a PERSON or for the admins; both of those are answered by this order
 * and neither was answered by the old one.
 *
 * Exported for the test, and pure so it can be asserted without a render.
 */
export function peopleOrder(users: readonly AdminUser[]): AdminUser[] {
  return [...users].sort((a, b) => {
    if ((a.role === "admin") !== (b.role === "admin")) return a.role === "admin" ? -1 : 1;
    // A never-seen account sorts last within its group: it is the one that has not happened
    // yet, and it is the bulk of a household that invites in batches.
    const seen = Number(Boolean(b.lastSeenAt)) - Number(Boolean(a.lastSeenAt));
    if (seen !== 0) return seen;
    return a.displayName.localeCompare(b.displayName);
  });
}

/**
 * Name match, folded, on the one field a reader can see.
 *
 * Deliberately NOT a match on the id: an operator filtering a list is typing a person's
 * name, and an id that happened to contain those letters would surface a row whose visible
 * text does not contain the query -- a result that looks like a bug.
 */
export function matchPeople(users: readonly AdminUser[], query: string): AdminUser[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...users];
  return users.filter((u) => u.displayName.toLowerCase().includes(q));
}

/**
 * The rows, from props alone -- so the shape of the list can be asserted without a fetch.
 *
 * Exported for `AdminUsersRoute.test.tsx`, which is where "a row is a link and holds no
 * button" is pinned. That is the regression worth guarding: it is one careless restyle away.
 */
export function PeopleList({ users }: { users: AdminUser[] }) {
  if (users.length === 0) {
    return (
      <p className="rounded-lg border border-line border-dashed px-4 py-8 text-center text-sm text-muted">
        Nobody has an account yet. Invite somebody to start.
      </p>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="px-4">Person</TableHead>
            <TableHead className="hidden sm:table-cell">Role</TableHead>
            <TableHead className="hidden md:table-cell">Last seen</TableHead>
            <TableHead className="px-4 text-right">This week</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((u) => (
            <TableRow key={u.id} className="group">
              {/*
                THE LINK IS INSIDE THE CELL AND STRETCHED OVER THE ROW, rather than the row
                being an <a>. A <tr> cannot be wrapped in an anchor and stay a table row --
                the parser hoists it out -- so the anchor covers the row with an ::after
                overlay instead. That keeps one tab stop and one hit target per person while
                the markup stays a real table a screen reader can read as a grid.
              */}
              <TableCell className="relative px-4 py-2.5">
                <Link
                  to="/admin/users/$id"
                  params={{ id: u.id }}
                  className="flex items-center gap-3 after:absolute after:inset-0 after:content-['']"
                >
                  <UserAvatar user={u} />
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="truncate font-medium text-ink group-hover:underline">
                      {u.displayName}
                    </span>
                    {/*
                      The badges repeat the Role column on purpose, and only where there is
                      something to say. Below `sm` the Role column is gone entirely and this
                      is the only place an administrator is named -- which is the reader most
                      likely to be on a phone doing something they should think twice about.
                    */}
                    <UserBadges user={u} />
                  </span>
                </Link>
              </TableCell>
              <TableCell className="hidden text-muted sm:table-cell">{roleLabel(u)}</TableCell>
              <TableCell className="hidden text-muted md:table-cell">
                {formatStamp(u.lastSeenAt, "never")}
              </TableCell>
              {/*
                Zero is drawn rather than hidden: "nothing this week" is a fact about a person,
                and a blank cell reads as a column that failed to load. It is dimmed instead,
                so a busy account is what the eye lands on going down the column.
              */}
              <TableCell
                className={`px-4 text-right tabular-nums ${u.requestsThisWeek === 0 ? "text-muted/50" : "text-ink"}`}
              >
                {u.requestsThisWeek} this week
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function AdminUsersRoute() {
  const { data, error } = useAsyncData(loadUsers);
  const [query, setQuery] = useState("");

  const ordered = useMemo(() => (data ? peopleOrder(data) : []), [data]);
  const visible = useMemo(() => matchPeople(ordered, query), [ordered, query]);

  if (error) return <p className="text-sm text-danger">{error}</p>;
  if (!data) return <p className="text-sm text-muted">Loading…</p>;

  const admins = data.filter((u) => u.role === "admin").length;

  return (
    <div className="flex flex-col gap-4">
      {/*
        The filter appears only once there is enough of a list to lose somebody in. A search
        box over five rows is chrome that costs a line and answers a question nobody has --
        the same rule `/log`'s requester chips already follow.
      */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {data.length > 8 ? (
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter people…"
            aria-label="Filter people by name"
            className="w-full sm:max-w-64"
          />
        ) : (
          <span />
        )}
        <p className="text-sm text-muted tabular-nums">
          {count(data.length, "person", "people")} · {count(admins, "administrator")}
        </p>
      </div>

      {visible.length === 0 && data.length > 0 ? (
        <p className="rounded-lg border border-line border-dashed px-4 py-8 text-center text-sm text-muted">
          Nobody here is called “{query.trim()}”.
        </p>
      ) : (
        <PeopleList users={visible} />
      )}
    </div>
  );
}
