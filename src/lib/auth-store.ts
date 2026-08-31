/**
 * Identity, on disk.
 *
 * The tables are declared HERE and applied by `Store`'s constructor, which stays the one
 * thing that opens the app database. So there is still a single connection and a single
 * migration path, and the auth vocabulary still lives beside the auth rules rather than
 * halfway down an 861-line file about libraries and facets.
 *
 * Every method is synchronous. `bun:sqlite` is synchronous and the render path is
 * explicitly not allowed to await anything, so a session read costs a prepared-statement
 * lookup and no promise at all.
 */

import type { Database } from "bun:sqlite";
import {
  type Credential,
  hashToken,
  type Invite,
  isoIn,
  isoNow,
  newToken,
  type Role,
  type Session,
  type User,
} from "./auth";

/**
 * Applied by `Store`, appended to its own SCHEMA.
 *
 * `app_user` rather than `user`: `user` is not reserved in SQLite today, but it is in
 * enough dialects that a future export/import tool would have to quote it, and the cost
 * of the prefix is three characters.
 *
 * NOTE: no backticks in this string -- it is a template literal, and one would end it.
 */
export const AUTH_SCHEMA = `
create table if not exists app_user (
  id            text primary key,
  display_name  text not null,
  role          text not null,
  plex_id       text,
  plex_username text,
  created_at    text not null,
  last_seen_at  text,
  disabled_at   text
);
-- Partial, so the many users with no Plex account do not all collide on NULL.
create unique index if not exists ix_user_plex on app_user(plex_id) where plex_id is not null;

-- One user has MANY credentials, which is why this is a table and not a column.
--
-- A person registers a laptop and a phone, and losing one must not lock them out. A schema
-- that cannot express that gets migrated later, under pressure, by somebody who is locked
-- out at the time.
--
-- public_key is TEXT holding base64url and NEVER a blob: a COSE key round-tripped as a
-- blob comes back as something the verifier refuses, and it fails at LOGIN rather than at
-- registration -- so the credential looks good right up until it is the only way in.
create table if not exists credential (
  id           text primary key,
  user_id      text not null references app_user(id) on delete cascade,
  public_key   text not null,
  counter      integer not null default 0,
  transports   text,
  device_type  text,
  backed_up    integer not null default 0,
  label        text,
  created_at   text not null,
  last_used_at text
);
create index if not exists ix_credential_user on credential(user_id);

-- An invitation, keyed by the HASH of its token.
--
-- Redeemed rows are kept rather than deleted, so "who let this person in" still has an
-- answer months later. redeemed_by is a foreign key to a user that does not exist yet at
-- claim time, which is why claiming and attributing are two statements -- see claimInvite.
create table if not exists invite (
  token_hash   text primary key,
  role         text not null,
  note         text,
  display_name text,
  created_by   text,
  created_at   text not null,
  expires_at   text not null,
  redeemed_at  text,
  redeemed_by  text references app_user(id) on delete set null
);

-- A session is a ROW, not a signed token.
--
-- A JWT cannot be revoked without rotating a secret that signs everybody out. With a row,
-- cutting off a lost phone is one DELETE. The cookie carries 32 random bytes and this
-- table holds their hash, so a forgery has to guess a row rather than break a MAC.
create table if not exists session (
  id_hash      text primary key,
  user_id      text not null references app_user(id) on delete cascade,
  created_at   text not null,
  expires_at   text not null,
  last_seen_at text not null,
  user_agent   text
);
create index if not exists ix_session_user on session(user_id);

-- A WebAuthn challenge, consumed exactly once.
--
-- READ-ONCE IS NOT OPTIONAL: a challenge that survives its own use is a replay. takeChallenge
-- deletes in the same statement that reads, and sweeps anything expired while it is there --
-- the write happens anyway, so the cleanup is free and the table cannot grow unnoticed.
create table if not exists webauthn_challenge (
  id           text primary key,
  challenge    text not null,
  kind         text not null,
  user_id      text,
  invite_hash  text,
  display_name text,
  expires_at   text not null
);

-- An in-flight Plex PIN. Same read-once rule, same reason.
create table if not exists plex_pin (
  id          text primary key,
  client_id   text not null,
  invite_hash text,
  created_at  text not null,
  expires_at  text not null
);
`;

interface UserRow {
  id: string;
  display_name: string;
  role: string;
  plex_id: string | null;
  plex_username: string | null;
  created_at: string;
  last_seen_at: string | null;
  disabled_at: string | null;
}

interface CredentialRow {
  id: string;
  user_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  device_type: string | null;
  backed_up: number;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
}

interface InviteRow {
  token_hash: string;
  role: string;
  note: string | null;
  display_name: string | null;
  created_by: string | null;
  created_at: string;
  expires_at: string;
  redeemed_at: string | null;
  redeemed_by: string | null;
}

interface SessionRow {
  id_hash: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  user_agent: string | null;
}

export interface Challenge {
  id: string;
  challenge: string;
  kind: "register" | "login";
  userId: string | null;
  inviteHash: string | null;
  displayName: string | null;
}

export interface PendingPin {
  id: string;
  clientId: string;
  inviteHash: string | null;
}

function toUser(r: UserRow): User {
  return {
    id: r.id,
    displayName: r.display_name,
    role: r.role as Role,
    plexId: r.plex_id,
    plexUsername: r.plex_username,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    disabledAt: r.disabled_at,
  };
}

function toCredential(r: CredentialRow): Credential {
  return {
    id: r.id,
    userId: r.user_id,
    publicKey: r.public_key,
    counter: r.counter,
    transports: r.transports ? (JSON.parse(r.transports) as string[]) : [],
    deviceType: r.device_type,
    backedUp: r.backed_up === 1,
    label: r.label,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  };
}

function toInvite(r: InviteRow): Invite {
  return {
    tokenHash: r.token_hash,
    role: r.role as Role,
    note: r.note,
    displayName: r.display_name,
    createdBy: r.created_by,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    redeemedAt: r.redeemed_at,
    redeemedBy: r.redeemed_by,
  };
}

function toSession(r: SessionRow): Session {
  return {
    idHash: r.id_hash,
    userId: r.user_id,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    lastSeenAt: r.last_seen_at,
    userAgent: r.user_agent,
  };
}

/**
 * How often the read paths bother sweeping expired rows, and the granularity of
 * `last_seen_at`. One value on purpose: both exist to keep per-request writes off the
 * hot path, and a minute is invisible to every question either field answers.
 */
const SWEEP_INTERVAL_MS = 60_000;

export class AuthStore {
  /** ms epoch of the last expired-session sweep. Per process, like the limiter windows. */
  private lastSessionSweep = 0;

  constructor(private readonly db: Database) {}

  // --- users ---------------------------------------------------------------

  /**
   * `id` is optional and is passed by exactly one caller: the passkey registration, which
   * mints the id at BEGIN so the authenticator's user handle matches the row that finish
   * will write. Everything else lets the store generate one.
   */
  createUser(u: {
    id?: string;
    displayName: string;
    role: Role;
    plexId?: string | null;
    plexUsername?: string | null;
    now?: Date;
  }): User {
    const id = u.id ?? newToken(12);
    const createdAt = isoNow(u.now);
    this.db
      .query(
        `insert into app_user (id, display_name, role, plex_id, plex_username, created_at)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, u.displayName, u.role, u.plexId ?? null, u.plexUsername ?? null, createdAt);
    return {
      id,
      displayName: u.displayName,
      role: u.role,
      plexId: u.plexId ?? null,
      plexUsername: u.plexUsername ?? null,
      createdAt,
      lastSeenAt: null,
      disabledAt: null,
    };
  }

  getUser(id: string): User | null {
    const r = this.db.query("select * from app_user where id = ?").get(id) as UserRow | undefined;
    return r ? toUser(r) : null;
  }

  getUserByPlexId(plexId: string): User | null {
    const r = this.db.query("select * from app_user where plex_id = ?").get(plexId) as UserRow | undefined;
    return r ? toUser(r) : null;
  }

  listUsers(): User[] {
    const rows = this.db.query("select * from app_user order by created_at").all() as UserRow[];
    return rows.map(toUser);
  }

  userCount(): number {
    const r = this.db.query("select count(*) as n from app_user").get() as { n: number };
    return r.n;
  }

  adminCount(): number {
    const r = this.db
      .query("select count(*) as n from app_user where role = 'admin' and disabled_at is null")
      .get() as { n: number };
    return r.n;
  }

  updateUser(id: string, patch: { displayName?: string; role?: Role; disabled?: boolean }): User | null {
    const sets: string[] = [];
    const args: (string | null)[] = [];
    if (patch.displayName !== undefined) {
      sets.push("display_name = ?");
      args.push(patch.displayName);
    }
    if (patch.role !== undefined) {
      sets.push("role = ?");
      args.push(patch.role);
    }
    if (patch.disabled !== undefined) {
      sets.push("disabled_at = ?");
      args.push(patch.disabled ? isoNow() : null);
    }
    if (sets.length > 0) {
      this.db.query(`update app_user set ${sets.join(", ")} where id = ?`).run(...args, id);
    }
    return this.getUser(id);
  }

  /** Link a Plex account to an existing user. Fails loudly if that account is taken. */
  linkPlex(id: string, plexId: string, plexUsername: string | null): void {
    this.db
      .query("update app_user set plex_id = ?, plex_username = ? where id = ?")
      .run(plexId, plexUsername, id);
  }

  unlinkPlex(id: string): void {
    this.db.query("update app_user set plex_id = null, plex_username = null where id = ?").run(id);
  }

  /**
   * Cascades to credentials and sessions -- which only happens because `Store` turns on
   * `pragma foreign_keys`. SQLite's default is OFF, and with it off the DDL above is
   * documentation rather than behaviour.
   */
  deleteUser(id: string): void {
    this.db.query("delete from app_user where id = ?").run(id);
  }

  touchUser(id: string, now?: Date): void {
    this.db.query("update app_user set last_seen_at = ? where id = ?").run(isoNow(now), id);
  }

  // --- credentials ---------------------------------------------------------

  addCredential(c: {
    id: string;
    userId: string;
    publicKey: string;
    counter: number;
    transports?: string[];
    deviceType?: string | null;
    backedUp?: boolean;
    label?: string | null;
    now?: Date;
  }): void {
    this.db
      .query(
        `insert into credential (id, user_id, public_key, counter, transports, device_type, backed_up, label, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.id,
        c.userId,
        c.publicKey,
        c.counter,
        JSON.stringify(c.transports ?? []),
        c.deviceType ?? null,
        c.backedUp ? 1 : 0,
        c.label ?? null,
        isoNow(c.now),
      );
  }

  getCredential(id: string): Credential | null {
    const r = this.db.query("select * from credential where id = ?").get(id) as CredentialRow | undefined;
    return r ? toCredential(r) : null;
  }

  credentialsFor(userId: string): Credential[] {
    const rows = this.db
      .query("select * from credential where user_id = ? order by created_at")
      .all(userId) as CredentialRow[];
    return rows.map(toCredential);
  }

  /**
   * Store the new counter, never gate on it.
   *
   * The signature counter is WebAuthn's only clone detection and most platform
   * authenticators pin it at 0 forever. Rejecting a non-incrementing counter locks out
   * every Apple passkey, which is most of ours. It is recorded for forensics and that is
   * all.
   */
  markCredentialUsed(id: string, counter: number, now?: Date): void {
    this.db
      .query("update credential set counter = ?, last_used_at = ? where id = ?")
      .run(counter, isoNow(now), id);
  }

  deleteCredential(id: string, userId: string): boolean {
    const res = this.db.query("delete from credential where id = ? and user_id = ?").run(id, userId);
    return res.changes > 0;
  }

  deleteCredentialsFor(userId: string): number {
    return this.db.query("delete from credential where user_id = ?").run(userId).changes;
  }

  // --- invites -------------------------------------------------------------

  /** Returns the TOKEN, which is the only time it exists outside the invitee's link. */
  createInvite(i: {
    role: Role;
    note?: string | null;
    displayName?: string | null;
    createdBy?: string | null;
    expiresAt: string;
    now?: Date;
  }): { token: string; invite: Invite } {
    const token = newToken();
    const tokenHash = hashToken(token);
    const createdAt = isoNow(i.now);
    this.db
      .query(
        `insert into invite (token_hash, role, note, display_name, created_by, created_at, expires_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        tokenHash,
        i.role,
        i.note ?? null,
        i.displayName ?? null,
        i.createdBy ?? null,
        createdAt,
        i.expiresAt,
      );
    return {
      token,
      invite: {
        tokenHash,
        role: i.role,
        note: i.note ?? null,
        displayName: i.displayName ?? null,
        createdBy: i.createdBy ?? null,
        createdAt,
        expiresAt: i.expiresAt,
        redeemedAt: null,
        redeemedBy: null,
      },
    };
  }

  getInvite(tokenHash: string): Invite | null {
    const r = this.db.query("select * from invite where token_hash = ?").get(tokenHash) as
      | InviteRow
      | undefined;
    return r ? toInvite(r) : null;
  }

  listInvites(): Invite[] {
    const rows = this.db.query("select * from invite order by created_at desc").all() as InviteRow[];
    return rows.map(toInvite);
  }

  /**
   * Claim an invite: ONE statement, with the whole condition in the WHERE.
   *
   * > [!CAUTION] Do NOT write `redeemed_by` here, and do NOT create the user first
   * > `redeemed_by` is a foreign key to a user row that does not exist yet, so the
   * > natural-reading order (claim the invite, then create the user it authorises) fails
   * > the constraint. And the tempting alternative -- create the user, then claim --
   * > leaves an orphan account behind every time the claim loses a race.
   * >
   * > So: claim (here), create the user, then `attributeInvite`. One mercy from this being
   * > a single statement is that a registration dying between steps leaves the invite
   * > UNCLAIMED and still usable; check before minting a replacement.
   *
   * With `select`-then-`update`, two people opening the same link milliseconds apart both
   * pass the check and both get an account. The `changes === 1` below is the race being
   * decided by SQLite instead of by us.
   */
  claimInvite(tokenHash: string, now?: Date): Invite | null {
    const at = isoNow(now);
    const peeked = this.getInvite(tokenHash);
    const res = this.db
      .query(
        "update invite set redeemed_at = ? where token_hash = ? and redeemed_at is null and expires_at > ?",
      )
      .run(at, tokenHash, at);
    if (res.changes !== 1 || !peeked) return null;
    return { ...peeked, redeemedAt: at };
  }

  /** Step 3. Failing here is survivable: a working account beats a receipt. */
  attributeInvite(tokenHash: string, userId: string): void {
    this.db.query("update invite set redeemed_by = ? where token_hash = ?").run(userId, tokenHash);
  }

  /** Un-claim, so a botched registration can be retried without minting a new link. */
  resetInvite(tokenHash: string): void {
    this.db
      .query("update invite set redeemed_at = null, redeemed_by = null where token_hash = ?")
      .run(tokenHash);
  }

  deleteInvite(tokenHash: string): boolean {
    return this.db.query("delete from invite where token_hash = ?").run(tokenHash).changes > 0;
  }

  // --- sessions ------------------------------------------------------------

  /** Returns the TOKEN for the cookie; only its hash is stored. */
  createSession(s: { userId: string; expiresAt: string; userAgent?: string | null; now?: Date }): string {
    const token = newToken();
    const at = isoNow(s.now);
    this.db
      .query(
        `insert into session (id_hash, user_id, created_at, expires_at, last_seen_at, user_agent)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .run(hashToken(token), s.userId, at, s.expiresAt, at, s.userAgent ?? null);
    return token;
  }

  /**
   * Resolve a cookie to its session and user, sweeping expired rows on the way.
   *
   * The sweep lives on the read path deliberately -- a session table that only shrinks
   * when somebody remembers to sweep it is a table that never shrinks -- but it runs AT
   * MOST ONCE A MINUTE, not per read. This runs on EVERY authenticated request, and an
   * unconditional DELETE is a write transaction per request whether or not anything
   * expired. Correctness never rides on the sweep: the expiry check below refuses a
   * stale row whether or not this pass happened to delete it.
   */
  readSession(token: string, now?: Date): { session: Session; user: User } | null {
    const at = isoNow(now);
    const t = (now ?? new Date()).getTime();
    if (t - this.lastSessionSweep >= SWEEP_INTERVAL_MS) {
      this.lastSessionSweep = t;
      this.db.query("delete from session where expires_at <= ?").run(at);
    }
    const r = this.db.query("select * from session where id_hash = ?").get(hashToken(token)) as
      | SessionRow
      | undefined;
    if (!r || r.expires_at <= at) return null;
    const user = this.getUser(r.user_id);
    if (!user || user.disabledAt !== null) return null;
    return { session: toSession(r), user };
  }

  /**
   * Record activity, at minute granularity.
   *
   * The condition is what keeps this from being a write per authenticated request:
   * `last_seen_at` answers "when was this device active", and for that question a
   * value under a minute old is already the answer. An UPDATE that matches no row
   * never enters the WAL.
   */
  touchSession(idHash: string, now?: Date): void {
    const t = now ?? new Date();
    this.db
      .query("update session set last_seen_at = ? where id_hash = ? and last_seen_at <= ?")
      .run(isoNow(t), idHash, isoIn(-SWEEP_INTERVAL_MS, t));
  }

  sessionsFor(userId: string): Session[] {
    const rows = this.db
      .query("select * from session where user_id = ? order by created_at desc")
      .all(userId) as SessionRow[];
    return rows.map(toSession);
  }

  deleteSession(token: string): void {
    this.db.query("delete from session where id_hash = ?").run(hashToken(token));
  }

  deleteSessionByHash(idHash: string): boolean {
    return this.db.query("delete from session where id_hash = ?").run(idHash).changes > 0;
  }

  deleteSessionsFor(userId: string): number {
    return this.db.query("delete from session where user_id = ?").run(userId).changes;
  }

  sessionCount(): number {
    const r = this.db.query("select count(*) as n from session").get() as { n: number };
    return r.n;
  }

  // --- challenges ----------------------------------------------------------

  putChallenge(c: {
    challenge: string;
    kind: "register" | "login";
    userId?: string | null;
    inviteHash?: string | null;
    displayName?: string | null;
    expiresAt: string;
  }): string {
    const id = newToken(16);
    // Sweep on the way in, not only in `takeChallenge`: begin is an ANONYMOUS,
    // rate-limited-but-public endpoint, and a caller who begins ceremonies without ever
    // finishing one would otherwise grow this table until somebody happens to finish.
    this.db.query("delete from webauthn_challenge where expires_at <= ?").run(isoNow());
    this.db
      .query(
        `insert into webauthn_challenge (id, challenge, kind, user_id, invite_hash, display_name, expires_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        c.challenge,
        c.kind,
        c.userId ?? null,
        c.inviteHash ?? null,
        c.displayName ?? null,
        c.expiresAt,
      );
    return id;
  }

  /** Read-once. Returns null for an unknown, used, or expired handle -- all one answer. */
  takeChallenge(id: string, now?: Date): Challenge | null {
    const at = isoNow(now);
    const r = this.db.query("select * from webauthn_challenge where id = ?").get(id) as
      | {
          id: string;
          challenge: string;
          kind: string;
          user_id: string | null;
          invite_hash: string | null;
          display_name: string | null;
          expires_at: string;
        }
      | undefined;
    this.db.query("delete from webauthn_challenge where id = ? or expires_at <= ?").run(id, at);
    if (!r || r.expires_at <= at) return null;
    return {
      id: r.id,
      challenge: r.challenge,
      kind: r.kind as "register" | "login",
      userId: r.user_id,
      inviteHash: r.invite_hash,
      displayName: r.display_name,
    };
  }

  // --- plex pins -----------------------------------------------------------

  putPin(p: {
    id: string;
    clientId: string;
    inviteHash?: string | null;
    expiresAt: string;
    now?: Date;
  }): void {
    this.db
      .query(
        `insert or replace into plex_pin (id, client_id, invite_hash, created_at, expires_at)
         values (?, ?, ?, ?, ?)`,
      )
      .run(p.id, p.clientId, p.inviteHash ?? null, isoNow(p.now), p.expiresAt);
  }

  /**
   * Read WITHOUT consuming -- the client polls this one while the user is still typing
   * their Plex password, so a read-once here would break the flow on the second poll.
   * It is deleted explicitly by `takePin` once the token actually arrives.
   */
  peekPin(id: string, now?: Date): PendingPin | null {
    const at = isoNow(now);
    this.db.query("delete from plex_pin where expires_at <= ?").run(at);
    const r = this.db.query("select * from plex_pin where id = ?").get(id) as
      | { id: string; client_id: string; invite_hash: string | null; expires_at: string }
      | undefined;
    if (!r || r.expires_at <= at) return null;
    return { id: r.id, clientId: r.client_id, inviteHash: r.invite_hash };
  }

  deletePin(id: string): void {
    this.db.query("delete from plex_pin where id = ?").run(id);
  }
}
