/**
 * Where you stand, in four cells, at the top of your own page.
 *
 * > [!IMPORTANT] THIS IS THE SUBSTANCE OF THE REDESIGN, not decoration on top of it
 * > `/account` was a credentials manager wearing an account page's name: five controls and
 * > not one fact about the person reading it. Your own request count and your own daily
 * > allowance existed ONLY on `/api/admin/users/:id` -- so the way to learn something about
 * > yourself was to ask an administrator to open the admin page about you. `ownActivity` and
 * > the caller's `quota` on `/api/auth/me` are what make this cell strip possible, and the
 * > strip is why that endpoint changed.
 *
 * **EVERY CELL IS A LINK, and that is the rule rather than a flourish.** A dashboard whose
 * numbers cannot be clicked makes a reader find the same page again by hand -- the same
 * argument `/admin`'s tiles already make. A figure with nowhere to go is a figure that should
 * have been a sentence.
 *
 * THE LABEL SITS ABOVE THE NUMBER, which is the inversion worth explaining. `6` then
 * `requested` makes a reader hold a value until they learn what it counts; the other way
 * round they read the noun and then the figure that answers it.
 */

import { Link, type LinkProps } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";
import type { QuotaState } from "../../lib/auth-api";
import { formatAge } from "../../lib/timestamps";

export interface StatProps {
  label: string;
  /** The figure. A STRING, because the fourth cell is words -- see `quotaStat`. */
  value: string;
  icon: LucideIcon;
  to: LinkProps["to"];
  search?: LinkProps["search"];
  /** Draw the figure in the accent. For the one cell that is worth acting on right now. */
  live?: boolean;
}

function Stat({ label, value, icon: Icon, to, search, live }: StatProps) {
  return (
    <Link
      to={to}
      search={search}
      className="group flex flex-col gap-1.5 rounded-xl border border-line bg-surface px-4 py-3 transition-colors hover:border-accent/60"
    >
      <span className="flex items-center gap-1.5 text-xs text-muted">
        <Icon className="size-3.5 shrink-0" aria-hidden="true" />
        {label}
      </span>
      {/*
        `tabular-nums` so four cells of digits line up their columns, and `truncate` because
        the quota cell is a phrase rather than a number and a long one must not push the
        card wider than its siblings.
      */}
      <span className={`truncate text-2xl font-semibold tabular-nums ${live ? "text-accent" : "text-ink"}`}>
        {value}
      </span>
    </Link>
  );
}

/**
 * The quota cell, in words, from the SERVER's own verdict.
 *
 * `applies` is the request rule's to decide -- an administrator is exempt, and a limit of zero
 * is unlimited -- so this reads the answer rather than working it out from `limitPerDay` and a
 * role. A screen that re-derived it would be free to disagree with the endpoint that actually
 * refuses the request.
 *
 * Exported and pure so the wording can be checked against a fixed state rather than a live one.
 */
export function quotaStat(quota: QuotaState): { value: string; label: string } {
  if (!quota.applies) return { value: "No limit", label: "Daily allowance" };
  const left = Math.max(0, quota.limitPerDay - quota.usedToday);
  return {
    value: `${left} left`,
    // The reset is the second half of the fact: "0 left" is alarming until you know it is
    // back in three hours. `formatAge` of a FUTURE instant is what phrases that.
    label: `Of ${quota.limitPerDay} today · back ${formatAge(quota.resetsAt) ?? "at midnight UTC"}`,
  };
}

export function StatStrip({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</div>;
}

export { Stat };
