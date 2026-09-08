/**
 * `/admin` -- the chrome every administration screen shares, and nothing else.
 *
 * Administration used to be ONE page carrying invitations, people with four inline buttons
 * each, and a link to the log. It is six now because they are six questions -- how is the
 * server doing, who is here, who has been asked, what is installed and waiting on a setting,
 * what is playback costing the machine, and what has one person been up to -- and a single
 * scroll answered none of them without answering all of them.
 *
 * > [!IMPORTANT] This screen is a CONVENIENCE, not the security boundary
 * > Every endpoint behind it refuses a non-admin on the server with a 404, so a user who
 * > types one of these URLs sees an empty page rather than anybody else's data. Nothing here
 * > is hidden by not being drawn -- see `asAdmin` in `src/server/auth-routes.ts` for where
 * > the rule actually lives. Putting a role check in the router would be a second owner of
 * > it, and the weaker of the two.
 *
 * A LAYOUT ROUTE rather than a nav bar pasted into every component: the tabs are the same tabs
 * on every one of them, and the version of this that copied them was the version where a fifth
 * screen shipped without one.
 *
 * > [!NOTE] These are ROUTER links wearing a tab's clothes, and NOT `components/ui/tabs`
 * > The registry's `Tabs` owns its own selected state and swaps panels in place. These are
 * > URLs -- they must survive a reload, a back button and a pasted address, and the
 * > active one is decided by the router rather than by a component's `useState`. Reaching
 * > for `Tabs` here would put a second, disagreeing owner on "which screen am I on".
 */

import { Link, Outlet } from "@tanstack/react-router";

/** Where the tabs go. The request log is a reader's page that admins reach from here too. */
const TABS = [
  { to: "/admin", label: "Overview" },
  { to: "/admin/users", label: "People" },
  { to: "/admin/invites", label: "Invitations" },
  { to: "/admin/addons", label: "Addons" },
  { to: "/admin/playback", label: "Playback" },
  { to: "/log", label: "Request log" },
] as const;

/**
 * The underline sits on the TAB, not on the bar, and the bar's own line runs behind it.
 *
 * `-mb-px` pulls each tab's bottom border over the container's, so the active tab's accent
 * replaces that segment of the rule rather than stacking a second line under it. Without it
 * the active marker floats a pixel below the divider and reads as a rendering fault.
 */
const TAB_BASE =
  "-mb-px border-b-2 px-1 pb-2 text-sm whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

export function AdminLayout() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Administration</h1>
        <p className="mt-1 text-sm text-muted">
          Who may use this finderr, what they are allowed, and how the server is holding up.
        </p>
      </div>

      {/*
        `overflow-x-auto` because five tabs plus a safe-area inset is wider than a small
        phone, and a tab bar that wraps to two lines stops reading as one control.
      */}
      <nav className="shelf-row flex gap-6 overflow-x-auto border-b border-line">
        {TABS.map((tab) => (
          <Link
            key={tab.to}
            to={tab.to}
            // `exact` so "Overview" does not stay lit on every child of `/admin`.
            activeOptions={{ exact: true }}
            activeProps={{ className: `${TAB_BASE} border-accent font-medium text-ink` }}
            inactiveProps={{ className: `${TAB_BASE} border-transparent text-muted hover:text-ink` }}
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      <Outlet />
    </div>
  );
}
