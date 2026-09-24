/**
 * The header's destinations on a narrow screen, behind one button.
 *
 * Measured 2026-09-24 at 375px: the section links, Admin and the account link needed 456px
 * of a 343px row, so the last two sat off the right edge and the whole page scrolled
 * sideways. Below `md` the bar keeps what is either the brand or NEWS (the wordmark, the
 * "ready" badge, search, the assistant) and everything that is merely a place to go moves in
 * here. At `md` and up the bar has the room and this button is not drawn.
 *
 * It renders the SAME `links` table the desktop bar does, so a section added to `NAV_LINKS`
 * appears in both with no second edit -- a menu that forgot a section would be the one place
 * a phone reader could not reach it.
 */

import { Link } from "@tanstack/react-router";
import { Menu } from "lucide-react";
import type { PublicUser } from "../lib/auth-api";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

export type NavLink = { to: string; label: string };

/**
 * Whether `to` is the section the reader is in.
 *
 * `startsWith` so a page BELOW a section still marks its parent: `/lists` stays lit on a
 * list's own sub-page. An exact match would unlight the bar the moment somebody navigated one
 * step in, which reads as having left. The desktop bar and this menu both ask it, so the two
 * can never disagree about where you are.
 */
export function isCurrentSection(pathname: string, to: string): boolean {
  return pathname === to || pathname.startsWith(`${to}/`);
}

/** Tall enough to hit with a thumb; this menu only exists on a touch-sized screen. */
const ITEM = "px-3 py-2.5 text-sm";
const CURRENT = "text-accent focus:text-accent";

export function SiteMenu({
  links,
  pathname,
  me,
  pendingCount,
}: {
  links: readonly NavLink[];
  pathname: string;
  me: PublicUser | null;
  /** The bar's "N queued" chip does not fit beside this button, so the count rides here. */
  pendingCount: number;
}) {
  const item = (to: string, label: string, meta?: string) => {
    const current = isCurrentSection(pathname, to);
    return (
      <DropdownMenuItem key={to} asChild className={`${ITEM} ${current ? CURRENT : ""}`}>
        <Link to={to} aria-current={current ? "page" : undefined}>
          <span className="flex-1">{label}</span>
          {meta && <span className="text-xs text-muted">{meta}</span>}
        </Link>
      </DropdownMenuItem>
    );
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* A 44px hit area around the same 28px glyph, with the negative margins giving the
            height back: on a phone this button is the only door to every section, so it gets
            the touch floor that a desktop icon in this bar deliberately does not. */}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Menu"
          className="-my-2.5 -mr-2.5 size-11 md:hidden"
        >
          <Menu />
        </Button>
      </DropdownMenuTrigger>
      {/* `collisionPadding` is the page gutter (`px-4`): the trigger's hit area bleeds into
          the gutter, and without it the menu followed and missed the search box's edge. */}
      <DropdownMenuContent align="end" collisionPadding={16} className="w-56">
        {links.map((link) =>
          item(
            link.to,
            link.label,
            link.to === "/requests" && pendingCount > 0 ? `${pendingCount} queued` : undefined,
          ),
        )}
        {me && (
          <>
            <DropdownMenuSeparator />
            {me.role === "admin" && item("/admin", "Admin")}
            {/* A bare name in a list of places does not say it is a place; the bar has the
                room to let position say it and this menu does not. */}
            {item("/account", me.displayName, "Account")}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
