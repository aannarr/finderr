/**
 * "Open in Radarr" / "Open in Sonarr" -- the one deliberate exception to the rule that the
 * browser is never handed an upstream URL, and the single owner of that exception.
 *
 * > [!CAUTION] This is admin-only, and it is stripped on the SERVER
 * > aannarr, 2026-08-31. The rule is `visibleRequest`'s (`src/lib/auth.ts`), applied to a
 * > different fact: a component that merely declines to DRAW the link still ships the arr's
 * > address in the JSON, one devtools tab away from every user on the system -- and that
 * > address describes the private network finderr sits in front of. So the link is built
 * > only for a caller whose role is `admin`, and every other caller is served `null`.
 *
 * > [!IMPORTANT] The slug is MIRRORED, never derived, because the two arrs disagree
 * > Both route their detail page on a `titleSlug` segment -- verified against
 * > `frontend/src/App/AppRoutes.tsx` in each project, `/movie/:titleSlug` and
 * > `/series/:titleSlug`. But Radarr 6.x fills that field with the tmdbId as a string
 * > ("700391") while Sonarr fills it with a word slug ("preacher"), both measured against
 * > live servers the same day. There is therefore no rule that computes both from an id we
 * > hold, which is why `library.title_slug` exists at all.
 *
 * A title we do not hold has no arr page to open, and a row mirrored before the slug column
 * existed has no segment -- both yield `null` rather than a guessed address. Plain text is a
 * correct answer; a link to a 404 is not.
 */

import type { Role } from "./auth";
import type { ArrService, Config } from "./config";
import type { LibraryEntry } from "./store";

/** Where an admin's browser is sent, and which arr it is. */
export interface ArrLink {
  service: "radarr" | "sonarr";
  /** Human label for the button -- "Radarr" or "Sonarr". */
  label: string;
  url: string;
}

const PATH_FOR = { radarr: "movie", sonarr: "series" } as const;
const LABEL_FOR = { radarr: "Radarr", sonarr: "Sonarr" } as const;

/**
 * The base a link is built on: the operator's stated public address, else the one the
 * server itself uses.
 *
 * `publicUrl` unset means "they are the same address", which is true for a LAN-only
 * instance and is the only default that cannot be wrong by omission -- an empty string
 * from a compose `${VAR:-}` counts as unset.
 */
export function arrBaseUrl(svc: ArrService | undefined): string | null {
  const base = svc?.publicUrl?.trim() || svc?.url?.trim();
  return base ? base.replace(/\/+$/, "") : null;
}

/**
 * The arr link for one title, or null when there is nothing honest to point at.
 *
 * Null for: a non-admin, a title not in the library, a row with no mirrored slug, and an
 * arr this instance has no configuration for.
 */
export function arrLink(
  cfg: Pick<Config, "radarr" | "sonarr">,
  entry: LibraryEntry | undefined,
  role: Role | null,
): ArrLink | null {
  if (role !== "admin") return null;
  if (!entry?.title_slug) return null;

  const service = entry.service;
  const base = arrBaseUrl(cfg[service]);
  if (!base) return null;

  return {
    service,
    label: LABEL_FOR[service],
    url: `${base}/${PATH_FOR[service]}/${encodeURIComponent(entry.title_slug)}`,
  };
}
