/**
 * The door that exists only until this server has its first account.
 *
 * An empty `app_user` table is a locked front door with nobody holding a key. The boot log
 * already prints a bootstrap invite for that, and it still does -- but reading a container
 * log is a shell step, and Jellyfin, Sonarr and Radarr all let the first visitor simply
 * create the account. This is that second door.
 *
 * > [!CAUTION] The window is real, and narrowing it is the whole design
 * > While the door is open, whoever arrives first becomes an admin of a process holding the
 * > Radarr, Sonarr and full-account Plex credentials. Three properties keep that bounded:
 * >
 * > 1. **It never reopens.** `userCount() === 0` is true both on a fresh install and on a
 * >    server whose only admin was just deleted, and those are not the same situation. The
 * >    latch below records that the server has HAD a user, so the second case stays closed.
 * > 2. **At most one claim is live at a time.** `claimHash` reuses an unspent claim rather
 * >    than minting a second, so two visitors racing each other race for the same invite row
 * >    and `claimInvite` -- one UPDATE, decided by SQLite -- lets exactly one of them win.
 * > 3. **Closing revokes what the open door left behind.** An abandoned claim is deleted the
 * >    moment an account exists, so no admin invite outlives the window it belonged to.
 *
 * It authorises the claim by minting a REAL admin invite and handing the ceremonies its
 * hash, rather than by teaching them a second way to create an account. Everything
 * downstream -- the atomic claim, the role, the user row, the `redeemed_by` receipt -- is
 * the invite path that was already there and already tested.
 */

import { isoIn, isoNow } from "./auth";
import type { AuthStore } from "./auth-store";
import type { KeyValueStore } from "./store";

/**
 * The kv key recording that this server has had a user. One fact about the SERVER, so it
 * belongs in `kv` rather than as a column on a table whose rows are exactly what it
 * outlives.
 */
export const FIRST_RUN_CLOSED_KEY = "first_run_closed_at";

/**
 * `created_by` on the invite the claim ceremony redeems, and the only way to recognise one.
 *
 * The minter's identity rather than a note, matching `"bootstrap"` and `"api-key"` beside
 * it -- a note is prose somebody may reword, and this value is read back by code.
 */
export const FIRST_RUN_CREATED_BY = "first-run";

/**
 * How long a claim stays redeemable. Long enough for a Plex round trip through plex.tv,
 * short enough that an abandoned one is gone before anybody could care.
 *
 * The token is never emitted -- only its hash reaches the ceremony -- so this bounds how
 * long a BEGUN sign-up may take, not how long a secret is at large.
 */
const CLAIM_TTL_MS = 15 * 60_000;

export interface FirstRunDeps {
  auth: AuthStore;
  kv: KeyValueStore;
  log: (msg: string) => void;
}

export class FirstRun {
  constructor(private readonly deps: FirstRunDeps) {}

  /**
   * May a stranger still claim the admin account?
   *
   * Reading this is what CLOSES it: the first call that sees a user latches the kv marker,
   * so the answer survives that user later being deleted. The latch is therefore cheapest
   * to arm early, which is why the server asks at boot rather than waiting for a visitor.
   */
  open(): boolean {
    if (this.deps.kv.getKv(FIRST_RUN_CLOSED_KEY) !== null) return false;
    if (this.deps.auth.userCount() === 0) return true;
    this.close();
    return false;
  }

  /**
   * The invite hash a claim ceremony should redeem, or null when the door is shut.
   *
   * Callers hand this to the ordinary invite path. The plaintext token is generated and
   * discarded here: nothing outside this process ever needs it, and a claim that cannot be
   * carried in a link cannot be forwarded to somebody else.
   */
  claimHash(): string | null {
    if (!this.open()) return null;
    const live = this.liveClaim();
    if (live) return live;
    const { invite } = this.deps.auth.createInvite({
      role: "admin",
      note: "first-run admin claim",
      createdBy: FIRST_RUN_CREATED_BY,
      expiresAt: isoIn(CLAIM_TTL_MS),
    });
    this.deps.log("first-run: minted the admin claim for a visitor with no invite");
    return invite.tokenHash;
  }

  /**
   * The unspent claim, if a ceremony already started one.
   *
   * A scan of `listInvites` rather than a query of its own: while this can return anything
   * at all the table holds the bootstrap invite and at most one claim, and a purpose-built
   * SQL method would be a second reader of the invite table earning nothing.
   */
  private liveClaim(): string | null {
    const now = isoNow();
    const found = this.deps.auth
      .listInvites()
      .find((i) => i.createdBy === FIRST_RUN_CREATED_BY && i.redeemedAt === null && i.expiresAt > now);
    return found?.tokenHash ?? null;
  }

  /** Latch the marker and revoke any claim the open door left behind. */
  private close(): void {
    this.deps.kv.setKv(FIRST_RUN_CLOSED_KEY, isoNow());
    for (const invite of this.deps.auth.listInvites()) {
      if (invite.createdBy === FIRST_RUN_CREATED_BY && invite.redeemedAt === null) {
        this.deps.auth.deleteInvite(invite.tokenHash);
      }
    }
    this.deps.log("first-run: an account exists -- the admin claim is closed for good");
  }
}
