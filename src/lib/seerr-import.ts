/**
 * Importing Seerr's users so they can sign in with "Continue with Plex".
 *
 * finderr is invite-only and stays that way -- this file mints no invites and weakens no
 * gate. It works because of a fact about the sign-in ceremony rather than a hole in it:
 * `/api/auth/plex/finish` (`src/server/auth-routes.ts`) consults `getUserByPlexId` BEFORE
 * it looks for an invite, and the only other thing it tests on that branch is `disabledAt`.
 * So a row carrying a `plex_id` is already a complete answer to "may this account sign in",
 * and a migrated user never touches `invite`, `redeemed_by` or a credential.
 *
 * > [!IMPORTANT] Match on the Plex ID, NEVER on the username
 * > A Plex username is editable by its owner at any time, so a username match would hand
 * > somebody else's account to whoever renamed themselves into it. `app_user.plex_id` is
 * > TEXT and Seerr's is an integer, so everything here stringifies at the boundary and
 * > compares strings after that -- `2326453` and `"2326453"` must not be two identities.
 *
 * > [!CAUTION] A migrated row is an account, and creating one is not reversible by re-running
 * > This is why the planner is pure and the writer is separate: the caller can print the
 * > whole plan, read it, and only then commit. `planSeerrImport` never touches a database
 * > and `applySeerrImport` never makes a decision.
 *
 * The second gate (`FINDERR_PLEX_MACHINE_ID`, "does this account have access to OUR
 * server") is unaffected by any of this. When it is configured, a migrated user who has
 * since been un-shared on Plex is refused at sign-in -- that is the gate doing its job, and
 * the fix is on the Plex side. `seerrAdminBit` exists so a dry run can WARN about the
 * Seerr admin rather than silently promoting anybody: role is hardcoded to `user` here and
 * no Seerr permission bit is ever read as authority.
 */

import type { Database } from "bun:sqlite";
import type { Role } from "./auth";

/** One row of Seerr's `user` table, narrowed to the columns that decide anything. */
export interface SeerrUser {
  id: number;
  plexId: string | null;
  plexUsername: string | null;
  username: string | null;
  /** Seerr's permission bitfield. Read ONLY to warn, never to grant. */
  permissions: number;
}

/** Overseerr's `Permission.ADMIN`. Used to flag, never to promote. */
export const SEERR_ADMIN_BIT = 2;

export function isSeerrAdmin(u: Pick<SeerrUser, "permissions">): boolean {
  return (u.permissions & SEERR_ADMIN_BIT) !== 0;
}

/**
 * Read Seerr's `user` table.
 *
 * Only the five columns that decide anything are selected. Notably NOT `plexToken`,
 * `password` or `email`: this job has no use for a credential, and reading one into a
 * process that also prints a report is how a secret reaches a log. A test asserts the
 * returned shape carries no secret.
 *
 * The caller opens the database `readonly`, so nothing here can reach Seerr's data.
 */
export function readSeerrUsers(db: Database): SeerrUser[] {
  const rows = db
    .query(
      `select id, plexId, plexUsername, username, permissions
         from user
        order by id`,
    )
    .all() as {
    id: number;
    plexId: number | null;
    plexUsername: string | null;
    username: string | null;
    permissions: number | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    plexId: r.plexId === null ? null : String(r.plexId),
    plexUsername: r.plexUsername,
    username: r.username,
    permissions: r.permissions ?? 0,
  }));
}

export type SkipReason =
  /** No Plex account behind the row -- a local or Jellyfin Seerr user. Nothing to link. */
  | "no-plex-id"
  /** The operator named this Plex id on the command line. */
  | "excluded"
  /** finderr already has a row for this Plex id. This is what makes a re-run a no-op. */
  | "already-linked"
  /** A second Seerr row carrying a Plex id an earlier row in this same plan already claimed. */
  | "duplicate-in-source";

export interface CreateAction {
  kind: "create";
  seerrId: number;
  plexId: string;
  plexUsername: string | null;
  displayName: string;
  role: Role;
  /** True when Seerr considered this account an admin. Surfaced so a dry run can shout. */
  seerrAdmin: boolean;
}

export interface SkipAction {
  kind: "skip";
  seerrId: number;
  plexId: string | null;
  plexUsername: string | null;
  reason: SkipReason;
}

export type ImportAction = CreateAction | SkipAction;

/**
 * What to call somebody.
 *
 * The Plex username is the name they will see on the sign-in screen, so it is the honest
 * first choice; Seerr's own `username` is a display override an admin may have typed. The
 * final fallback is deliberately generic rather than an email local-part -- an email is
 * not a display name and putting one on screen leaks an address to every other user.
 */
export function displayNameFor(u: SeerrUser): string {
  const plex = u.plexUsername?.trim();
  if (plex) return plex;
  const local = u.username?.trim();
  if (local) return local;
  return "finderr user";
}

/** Seerr writes `plexId` as an integer and uses NULL (and, historically, 0) for "none". */
export function normalisePlexId(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? String(raw) : null;
  const s = String(raw).trim();
  if (!s || s === "0") return null;
  return /^\d+$/.test(s) ? s : null;
}

export interface ImportPlan {
  actions: ImportAction[];
  creates: CreateAction[];
  skips: SkipAction[];
}

/**
 * Decide, without touching anything.
 *
 * The order of the checks is the contract and the tests pin it: an excluded account is
 * reported as `excluded` even when it would also have been `already-linked`, because the
 * operator asked about that id specifically and deserves to see their own instruction
 * reflected back rather than an incidental reason.
 */
export function planSeerrImport(opts: {
  users: SeerrUser[];
  /** Every `plex_id` finderr already holds. Stringified by the caller. */
  existingPlexIds: Iterable<string>;
  /** Plex ids the operator named. Stringified by the caller. */
  exclude?: Iterable<string>;
}): ImportPlan {
  const existing = new Set(opts.existingPlexIds);
  const excluded = new Set(opts.exclude ?? []);
  const claimed = new Set<string>();
  const actions: ImportAction[] = [];

  for (const u of opts.users) {
    const plexId = normalisePlexId(u.plexId);
    const skip = (reason: SkipReason): SkipAction => ({
      kind: "skip",
      seerrId: u.id,
      plexId,
      plexUsername: u.plexUsername,
      reason,
    });

    if (!plexId) {
      actions.push(skip("no-plex-id"));
      continue;
    }
    if (excluded.has(plexId)) {
      actions.push(skip("excluded"));
      continue;
    }
    if (existing.has(plexId)) {
      actions.push(skip("already-linked"));
      continue;
    }
    if (claimed.has(plexId)) {
      actions.push(skip("duplicate-in-source"));
      continue;
    }

    claimed.add(plexId);
    actions.push({
      kind: "create",
      seerrId: u.id,
      plexId,
      plexUsername: u.plexUsername,
      displayName: displayNameFor(u),
      // Hardcoded. A Seerr admin does not become a finderr admin by having been one there;
      // promoting somebody is a deliberate PATCH through the admin API.
      role: "user",
      seerrAdmin: isSeerrAdmin(u),
    });
  }

  return {
    actions,
    creates: actions.filter((a): a is CreateAction => a.kind === "create"),
    skips: actions.filter((a): a is SkipAction => a.kind === "skip"),
  };
}

/** The narrow slice of `AuthStore` this needs, so a test can pass a fake. */
export interface UserWriter {
  createUser(u: { displayName: string; role: Role; plexId?: string | null; plexUsername?: string | null }): {
    id: string;
  };
}

/**
 * Write the plan. Returns the finderr ids created, in plan order.
 *
 * Nothing is decided here -- every `create` in the plan is executed and every `skip` is
 * ignored. A unique-index violation on `plex_id` would throw rather than be swallowed:
 * it means the plan was computed against a database that has since changed, and quietly
 * continuing would report a migration that did not happen.
 */
export function applySeerrImport(
  writer: UserWriter,
  plan: ImportPlan,
): { seerrId: number; plexId: string; userId: string }[] {
  return plan.creates.map((c) => {
    const user = writer.createUser({
      displayName: c.displayName,
      role: c.role,
      plexId: c.plexId,
      plexUsername: c.plexUsername,
    });
    return { seerrId: c.seerrId, plexId: c.plexId, userId: user.id };
  });
}
