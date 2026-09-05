/**
 * `/admin` -- the chrome every administration screen shares, and nothing else.
 *
 * Administration used to be ONE page carrying invitations, people with four inline buttons
 * each, and a link to the log. It is four now because they are four questions -- how is the
 * server doing, who is here, who has been asked, and what has one person been up to -- and a
 * single scroll answered none of them without answering all of them.
 *
 * > [!IMPORTANT] This screen is a CONVENIENCE, not the security boundary
 * > Every endpoint behind it refuses a non-admin on the server with a 404, so a user who
 * > types one of these URLs sees an empty page rather than anybody else's data. Nothing here
 * > is hidden by not being drawn -- see `asAdmin` in `src/server/auth-routes.ts` for where
 * > the rule actually lives. Putting a role check in the router would be a second owner of
 * > it, and the weaker of the two.
 *
 * A LAYOUT ROUTE rather than a nav bar pasted into four components: the tabs are the same
 * tabs on every one of them, and the version of this that copied them was the version where
 * a fifth screen shipped without one.
 */

import { Link, Outlet } from "@tanstack/react-router";

/** Where the tabs go. The request log is a reader's page that admins reach from here too. */
const TABS = [
  { to: "/admin", label: "Overview" },
  { to: "/admin/users", label: "People" },
  { to: "/admin/invites", label: "Invitations" },
  { to: "/log", label: "Request log" },
] as const;

export function AdminLayout() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold tracking-tight">Administration</h1>

      <nav className="flex flex-wrap gap-4 border-b border-line pb-2 text-sm">
        {TABS.map((tab) => (
          <Link
            key={tab.to}
            to={tab.to}
            // `exact` so "Overview" does not stay lit on every child of `/admin`.
            activeOptions={{ exact: true }}
            activeProps={{ className: "text-ink" }}
            inactiveProps={{ className: "text-muted hover:text-ink" }}
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      <Outlet />
    </div>
  );
}
