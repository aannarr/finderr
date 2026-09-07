/**
 * How a PERSON is drawn on the admin screens: a coloured disc, their name, and what is true
 * about them.
 *
 * Its own module for the same reason `PersonPortrait` is one: there are two surfaces -- the
 * people table and the person's own page -- and they must not drift. The list and the header
 * are the same identity at two sizes, so a second copy sized one way here and another way
 * there is the difference nobody notices until the two screens appear back to back.
 *
 * > [!IMPORTANT] The disc colour is DERIVED FROM THE ID, and that is the whole point of it
 * > Thirteen identical grey circles are worth less than no circles at all -- they cost a
 * > column and buy nothing. A stable hue per account makes the list scannable at a glance
 * > and makes "am I on the right person's page" answerable without reading the name, which
 * > is the one question an operator asks twice on every destructive action.
 * >
 * > It is an inline `style` rather than a Tailwind class ON PURPOSE. The hue is computed, and
 * > Tailwind only emits utilities it can see written out in the source -- a template-built
 * > `bg-[oklch(...)]` is a class that exists in the DOM and in no stylesheet, which renders
 * > as no background at all. Same trap as `bg-muted`, one layer down.
 */

import type { PublicUser } from "../../lib/auth-api";
import { initialsOf } from "../../lib/facet-panes";
import { type ChipTone, InertChip } from "../Chip";
import { Avatar, AvatarFallback } from "../ui/avatar";

/**
 * A stable hue, 0-359, from an account id.
 *
 * FNV-1a rather than `charCodeAt` summed: a sum collides on anagrams, and these ids are
 * generated strings over a small alphabet where near-neighbours are common. Exported so
 * `UserIdentity.test.ts` can pin that the same id always lands on the same colour -- a disc
 * that changed colour between two renders of one list would be worse than a grey one.
 */
export function hueOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 360;
}

/**
 * The two colours a disc wears, as a `style` object.
 *
 * Lightness and chroma are FIXED and only the hue moves, so every disc sits at the same
 * visual weight on a dark page -- a palette that varies all three has one person shouting
 * and another invisible. 0.42/0.07 is dark enough to sit under `--color-ink` text without
 * competing with the accent, checked against the surface it draws on rather than picked.
 */
export function discStyle(id: string): { backgroundColor: string; color: string } {
  const h = hueOf(id);
  return { backgroundColor: `oklch(0.42 0.07 ${h})`, color: `oklch(0.93 0.03 ${h})` };
}

/** The disc alone, for a row that has its own layout. */
export function UserAvatar({
  user,
  size = "default",
}: {
  user: Pick<PublicUser, "id" | "displayName" | "disabled">;
  size?: "sm" | "default" | "lg";
}) {
  return (
    <Avatar size={size} className={user.disabled ? "opacity-40 grayscale" : undefined}>
      {/*
        No `AvatarImage`. finderr stores no picture for an account -- Plex has one and we
        deliberately do not mirror it -- so the "fallback" is the only state this ever has,
        and rendering an <img> that is always going to fail would flash a broken frame.
      */}
      <AvatarFallback style={discStyle(user.id)} className="font-medium">
        {initialsOf(user.displayName)}
      </AvatarFallback>
    </Avatar>
  );
}

/**
 * What is true about this account, as pills, with the QUIET case drawing nothing.
 *
 * An ordinary member in good standing gets no badge at all -- "Member" beside twelve other
 * Members is a column of noise, and the row already says what they are in the Role cell.
 * A badge here means LOOK AT THIS ONE.
 */
export function UserBadges({ user }: { user: Pick<PublicUser, "role" | "disabled"> }) {
  const badges: { label: string; tone: ChipTone }[] = [];
  if (user.role === "admin") badges.push({ label: "Administrator", tone: "accent" });
  if (user.disabled) badges.push({ label: "Disabled", tone: "danger" });
  if (badges.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {badges.map((b) => (
        <InertChip key={b.label} label={b.label} tone={b.tone} />
      ))}
    </span>
  );
}
