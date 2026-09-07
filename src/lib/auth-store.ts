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
  type AgentKey,
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
import { type AddedColumn, addMissingColumns } from "./sqlite-columns";

/**
 * Applied by `applyAuthSchema`, which `Store`'s constructor calls.
 *
 * `app_user` rather than `user`: `user` is not reserved in SQLite today, but it is in
 * enough dialects that a future export/import tool would have to quote it, and the cost
 * of the prefix is three characters.
 *
 * A column added after the first release does NOT belong here -- it goes in
 * `AUTH_ADDED_COLUMNS` below, which is the only spelling of it. See that list for why.
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

-- A browser that has agreed to be told when its owner's request arrives.
--
-- NOTE: no backticks anywhere in this comment. AUTH_SCHEMA is a template literal.
--
-- IT LIVES HERE, WITH IDENTITY, FOR THE CASCADE. A push subscription is a device that will
-- be sent messages on somebody's behalf, so it has to die with the account exactly as a
-- session does -- and an "on delete cascade" only works if the table is declared where
-- app_user is. Deleting a user and leaving this behind would mean going on pushing to a
-- phone about an account that no longer exists.
--
-- ENDPOINT IS THE KEY, and it is the browser's own opaque URL. Keying on the user instead
-- would allow one device each; keying on a generated id would let the same browser
-- re-subscribe into a second row after clearing its storage, and both rows would then be
-- delivered the same notification.
--
-- p256dh and auth are the subscriber's half of the encryption. They are not a credential
-- for anything here: they let this server encrypt TO that browser and nothing else. See
-- ./web-push.ts.
create table if not exists push_subscription (
  endpoint     text primary key,
  user_id      text not null references app_user(id) on delete cascade,
  p256dh       text not null,
  auth         text not null,
  user_agent   text,
  created_at   text not null,
  last_sent_at text
);
create index if not exists ix_push_user on push_subscription(user_id);

-- MANY agent keys per user, each with a name. CORRECTED 2026-09-07 -- see migrateAgentKeys.
--
-- NOTE: no backticks anywhere in this comment. AUTH_SCHEMA is a template literal.
--
-- This was keyed on user_id, one key per person, and the comment here argued the case: no
-- collection to list, nothing to label, no revocation-by-id, and creating replaced in one
-- statement so there was no window where two tokens worked. That reasoning was sound for
-- one key and it is what made the SECOND one impossible.
--
-- It stops holding the moment somebody runs two agents. With one key they share it, so
-- revoking the one that leaked kills the one that did not, and last_used_at answers for
-- both at once -- which is to say it answers for neither. A name is what turns a row into
-- something you can decide about, and it is why aannarr asked for one.
--
-- The uniqueness check the old comment worried about is real and it is HERE: token_hash is
-- unique, so an orphan credential is a constraint violation rather than a thing to remember.
--
-- token_hash is UNIQUE because it is the lookup key on every authenticated request: a
-- caller presents a token, we hash it, and the row it finds decides who they are. The
-- token itself is never stored -- same rule as sessions and invites.
--
-- name is NULLABLE and stays that way: a key migrated from the old shape never had one, and
-- inventing a name for it would be inventing a fact. Readers fall back to the kind.
--
-- read_only is a TOGGLE, not a scope list. See AgentKey in ./auth.ts for what it costs.
create table if not exists agent_key (
  id           text primary key,
  user_id      text not null references app_user(id) on delete cascade,
  name         text,
  token_hash   text not null unique,
  created_at   text not null,
  last_used_at text,
  read_only    integer not null default 0
);
create index if not exists ix_agent_key_user on agent_key(user_id, created_at desc);
`;

/**
 * The PER-USER SETTINGS, added after the first release -- so they live here rather than in
 * the `create table` above, which a deployed database has long since run.
 *
 * Both are what an admin decides ABOUT somebody on `/admin/users/:id`, and both are written
 * so that an untouched row keeps behaving exactly as it did before the column existed.
 */
export const AUTH_ADDED_COLUMNS: AddedColumn[] = [
  /*
    THIS PERSON'S OWN DAILY TITLE LIMIT, or NULL to follow the deployment's.

    Nullable, and null is the default and the ordinary case: it means "whatever the site
    says", which is what every account had before this column. `quotaLimitFor` in
    `./request-quota.ts` is the one owner of that fallback -- a reader that spelled
    `override ?? siteSettings.read().requestQuotaPerDay` for itself would be a second one. The
    site default no longer comes from the env: it is a stored setting seeded by it, and
    `src/lib/site-settings.ts` owns which of the two wins.

    Zero here is NOT null: it is an explicit "unlimited for this person" that survives the
    operator later capping everybody else.
  */
  {
    table: "app_user",
    column: "quota_per_day",
    ddl: "alter table app_user add column quota_per_day integer",
  },
  /*
    MAY THIS PERSON USE THE ASSISTANT? Integer, because SQLite has no boolean.

    `not null default 1`, which is what makes the migration silent: SQLite writes the default
    into every existing row, so everybody who could use the assistant yesterday still can.
    Defaulting it OFF would have been a feature withdrawn by an upgrade nobody asked for.

    THE DDL DEFAULT NO LONGER DECIDES WHAT A NEW ROW GETS -- it applies only to rows this
    migration back-filled. `createUser` writes the column explicitly from the site setting
    (`SiteSettings.assistantAllowedByDefault`), so an operator who turns the assistant off for
    new accounts is obeyed. NOT NULL is also why that setting is a creation default rather than
    a fallback: there is no third state for "follow the site". See `src/lib/site-settings.ts`.

    It is the per-account half of the consent `aiGate` documents owing the household: a
    question typed here leaves the house, and this is the switch that decides whose does.
  */
  {
    table: "app_user",
    column: "assistant_allowed",
    ddl: "alter table app_user add column assistant_allowed integer not null default 1",
  },
];

/**
 * Create the auth tables and bring an existing database up to this build's shape.
 *
 * The one way in, used by `Store` and by every test harness, so the ALTERs above are
 * exercised by the suite rather than running for the first time against the live file.
 */
/**
 * Rebuild `agent_key` from one-key-per-user to many-named-keys-per-user.
 *
 * > [!IMPORTANT] THIS IS THE ONE MIGRATION IN THIS SCHEMA THAT `ADDED_COLUMNS` CANNOT DO
 * > Every other change to a deployed table here has been a new nullable column, which is one
 * > `alter table add column`. This one moves the PRIMARY KEY off `user_id` and onto a new
 * > `id`, and SQLite cannot alter a primary key at all -- the only way is to build the new
 * > table, copy, drop and rename. So it is written out rather than declared.
 *
 * **IDEMPOTENT BY SHAPE, not by a version number.** It asks `PRAGMA table_info` whether an
 * `id` column exists and does nothing if it does, so it is safe on every boot and on a fresh
 * database that `AUTH_SCHEMA` has just built correctly. A migrations table would be a second
 * thing to keep true; the shape IS the truth.
 *
 * **IN A TRANSACTION, because it is carrying live credentials.** A half-run rebuild would
 * drop the old table having failed to fill the new one, and every agent on the deployment
 * would stop authenticating at once. The keys are re-mintable, which bounds the damage --
 * but "re-mint every key by hand" is not a migration outcome anybody should accept.
 *
 * A migrated key keeps its `token_hash`, so **whatever is holding that token goes on working
 * across the upgrade**. It gains a generated id and a NULL name; the name is left null rather
 * than filled with something like "Agent key", because a name nobody chose is a fact this
 * table would be inventing, and every reader already falls back to the key's kind.
 */
export function migrateAgentKeys(db: Database): void {
  const columns = db.query("pragma table_info(agent_key)").all() as { name: string }[];
  // No table at all is a fresh database -- AUTH_SCHEMA has already built the new shape.
  if (columns.length === 0 || columns.some((c) => c.name === "id")) return;

  db.transaction(() => {
    db.run(`create table agent_key_new (
      id           text primary key,
      user_id      text not null references app_user(id) on delete cascade,
      name         text,
      token_hash   text not null unique,
      created_at   text not null,
      last_used_at text,
      read_only    integer not null default 0
    )`);
    /*
      The id is derived from the token hash rather than randomly generated, so re-running an
      interrupted migration cannot mint a second row for one credential. `substr` of a sha256
      is 32 hex characters, which is the same width the rest of this schema's ids use and is
      not a secret: the hash it comes from is already what the table stores.
    */
    db.run(`insert into agent_key_new (id, user_id, name, token_hash, created_at, last_used_at, read_only)
            select substr(token_hash, 1, 32), user_id, null, token_hash, created_at, last_used_at, read_only
            from agent_key`);
    db.run("drop table agent_key");
    db.run("alter table agent_key_new rename to agent_key");
    db.run("create index if not exists ix_agent_key_user on agent_key(user_id, created_at desc)");
  })();
}

export function applyAuthSchema(db: Database): void {
  db.run(AUTH_SCHEMA);
  addMissingColumns(db, AUTH_ADDED_COLUMNS);
  // AFTER the create-if-not-exists above, so a fresh database is already the new shape and
  // this is a no-op, and an old one is rebuilt from what it actually holds.
  migrateAgentKeys(db);
}

interface UserRow {
  id: string;
  display_name: string;
  role: string;
  plex_id: string | null;
  plex_username: string | null;
  created_at: string;
  last_seen_at: string | null;
  disabled_at: string | null;
  quota_per_day: number | null;
  assistant_allowed: number;
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

/**
 * One subscribed browser, as stored. Exported: the notifier reads these rows straight into
 * `PushTarget`, and re-typing the three fields it needs would be a second shape to keep in
 * step with the table.
 */
export interface PushSubscriptionRow {
  endpoint: string;
  user_id: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
  created_at: string;
  last_sent_at: string | null;
}

interface SessionRow {
  id_hash: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  user_agent: string | null;
}

interface AgentKeyRow {
  id: string;
  user_id: string;
  name: string | null;
  token_hash: string;
  created_at: string;
  last_used_at: string | null;
  read_only: number;
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
    quotaPerDay: r.quota_per_day,
    assistantAllowed: r.assistant_allowed !== 0,
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

function toAgentKey(r: AgentKeyRow): AgentKey {
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    tokenHash: r.token_hash,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    readOnly: r.read_only === 1,
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

  constructor(
    private readonly db: Database,
    /**
     * What a new account's assistant switch starts at -- `SiteSettings.assistantAllowedByDefault`.
     *
     * INJECTED HERE RATHER THAN THREADED THROUGH THE CEREMONIES, and a THUNK rather than a
     * value. There are four ways an account comes into existence -- passkey registration, Plex
     * sign-up, the no-auth dev admin, the Seerr import -- and passing a site default down each
     * of them would put a copy of "where does this default come from" in four call sites and a
     * new constructor argument on `PasskeyService`. A thunk because an operator changes the
     * setting while the process runs, so a value captured at wiring time would go stale the
     * first time anybody used the admin page.
     *
     * The default keeps the column's own default, so every test harness and every job that
     * constructs an `AuthStore` with a bare database behaves exactly as it did before.
     */
    private readonly assistantAllowedByDefault: () => boolean = () => true,
  ) {}

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
    /*
      `assistant_allowed` is WRITTEN rather than left to the column default, because the site
      default is a live setting and the column default is a constant frozen at migration time.
      The quota is not: `quota_per_day` stays NULL, which means "follow the site", so its site
      value is resolved at every read by `quotaLimitFor` and does not need writing down here.
      Two settings, two different mechanisms -- see `SiteSettings` for why the assistant one
      cannot be a fallback.
    */
    const assistantAllowed = this.assistantAllowedByDefault();
    this.db
      .query(
        `insert into app_user (id, display_name, role, plex_id, plex_username, created_at, assistant_allowed)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        u.displayName,
        u.role,
        u.plexId ?? null,
        u.plexUsername ?? null,
        createdAt,
        assistantAllowed ? 1 : 0,
      );
    return {
      id,
      displayName: u.displayName,
      role: u.role,
      plexId: u.plexId ?? null,
      plexUsername: u.plexUsername ?? null,
      createdAt,
      lastSeenAt: null,
      disabledAt: null,
      quotaPerDay: null,
      assistantAllowed,
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

  /**
   * Change what an admin may change about somebody. Every field is optional and an absent
   * one is untouched, which is what makes `null` meaningful: `quotaPerDay: null` CLEARS the
   * override back to the site default, where leaving it out changes nothing.
   */
  updateUser(
    id: string,
    patch: {
      displayName?: string;
      role?: Role;
      disabled?: boolean;
      quotaPerDay?: number | null;
      assistantAllowed?: boolean;
    },
  ): User | null {
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
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
    if (patch.quotaPerDay !== undefined) {
      sets.push("quota_per_day = ?");
      args.push(patch.quotaPerDay);
    }
    if (patch.assistantAllowed !== undefined) {
      sets.push("assistant_allowed = ?");
      args.push(patch.assistantAllowed ? 1 : 0);
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

  /**
   * Give a passkey a name its owner will recognise.
   *
   * Scoped to `userId` in the WHERE for the same reason `deleteCredential` is: a credential
   * id is not a secret, so holding one must never be authority over it. `false` means "not
   * yours, or no such thing" -- one answer for both, because telling them apart would be
   * telling a caller that somebody else's credential exists.
   *
   * An empty label is stored as NULL rather than as `""`. `AccountRoute` falls back to the
   * device type when the label is null, so a cleared name reverts to that instead of
   * rendering a blank row -- two spellings of "no name" would drift.
   */
  renameCredential(id: string, userId: string, label: string | null): boolean {
    const trimmed = label?.trim();
    const res = this.db
      .query("update credential set label = ? where id = ? and user_id = ?")
      .run(trimmed ? trimmed : null, id, userId);
    return res.changes > 0;
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

  /**
   * End ONE open session, named by its hash and scoped to whose it is.
   *
   * `user_id` is in the WHERE for the same reason `deleteCredential` has it there: a session
   * id is a hash rather than a secret, it is handed to every reader of `/api/auth/me` and
   * `/api/admin/users/:id`, and holding one must never be authority over it. `false` means
   * "not theirs, or no such thing" -- one answer for both, because telling them apart would
   * confirm that somebody else's session exists.
   */
  deleteSessionByHash(idHash: string, userId: string): boolean {
    return (
      this.db.query("delete from session where id_hash = ? and user_id = ?").run(idHash, userId).changes > 0
    );
  }

  deleteSessionsFor(userId: string): number {
    return this.db.query("delete from session where user_id = ?").run(userId).changes;
  }

  sessionCount(): number {
    const r = this.db.query("select count(*) as n from session").get() as { n: number };
    return r.n;
  }

  // --- agent keys ----------------------------------------------------------

  /**
   * Mint one agent key. Returns the TOKEN, which exists nowhere else, ever again.
   *
   * > [!IMPORTANT] IT NO LONGER REPLACES, and losing that is the point of naming keys
   * > This was an upsert on `user_id`: minting overwrote the previous hash, so rotation and
   * > creation were one call and there was never a window where two tokens worked. Neat, and
   * > it made a second agent impossible -- two agents shared one credential, so revoking the
   * > one that leaked killed the one that had not, and `last_used_at` answered for both at
   * > once.
   * >
   * > Rotation is now REPLACE-THEN-REVOKE by the caller, in that order, which does have a
   * > window where both work. That is the honest trade: the alternative kills the running
   * > agent before its replacement is in place, and the person doing it is looking at a
   * > list where they can see exactly which row is which.
   *
   * `name` is trimmed to null rather than stored as "", so there is one spelling of "no
   * name" -- the same rule `renameCredential` follows for passkeys.
   */
  putAgentKey(k: { userId: string; name?: string | null; readOnly: boolean; now?: Date }): {
    token: string;
    key: AgentKey;
  } {
    const token = newToken();
    const tokenHash = hashToken(token);
    const createdAt = isoNow(k.now);
    // `newToken(16)` is what every other id in this file is, and the width is the point
    // rather than the entropy: an id is not a secret here, it is drawn on the account page.
    const id = newToken(16);
    const name = k.name?.trim() || null;
    this.db
      .query(
        `insert into agent_key (id, user_id, name, token_hash, created_at, last_used_at, read_only)
         values (?, ?, ?, ?, ?, null, ?)`,
      )
      .run(id, k.userId, name, tokenHash, createdAt, k.readOnly ? 1 : 0);
    return {
      token,
      key: { id, userId: k.userId, name, tokenHash, createdAt, lastUsedAt: null, readOnly: k.readOnly },
    };
  }

  /**
   * Resolve a presented token's hash to the key that owns it, or null.
   *
   * By HASH rather than by user, because this is the lookup on the authentication path: the
   * caller offers a secret and the row is what says who they are. Comparing in SQL on the
   * hash is safe where comparing the token itself would not be -- the hash is what we
   * store, and an attacker who could time this learns only which hash exists.
   */
  getAgentKeyByHash(tokenHash: string): AgentKey | null {
    const r = this.db.query("select * from agent_key where token_hash = ?").get(tokenHash) as
      | AgentKeyRow
      | undefined;
    return r ? toAgentKey(r) : null;
  }

  /**
   * One key by its id, for the manifest that describes the caller to itself.
   *
   * NOT scoped to a user, unlike `deleteAgentKey` and `renameAgentKey`: the only caller is
   * the manifest, which has just been handed this id by the hash that authenticated the
   * request. There is no id here that did not come from a token somebody presented.
   */
  agentKeyById(id: string): AgentKey | null {
    const r = this.db.query("select * from agent_key where id = ?").get(id) as AgentKeyRow | undefined;
    return r ? toAgentKey(r) : null;
  }

  /** Every key this user holds, newest first. Never a token -- those are gone. */
  agentKeysFor(userId: string): AgentKey[] {
    return (
      this.db
        .query("select * from agent_key where user_id = ? order by created_at desc, id")
        .all(userId) as AgentKeyRow[]
    ).map(toAgentKey);
  }

  /**
   * Revoke ONE key, named by its id and scoped to whose it is.
   *
   * `user_id` is in the WHERE for the same reason `deleteSessionByHash` has it there: the id
   * is handed to every reader of `/api/auth/me`, and holding one must never be authority over
   * it. `false` means "not theirs, or no such thing" -- one answer for both, because telling
   * them apart would confirm that somebody else's key exists.
   */
  deleteAgentKey(id: string, userId: string): boolean {
    return this.db.query("delete from agent_key where id = ? and user_id = ?").run(id, userId).changes > 0;
  }

  /** Every key a user holds, gone at once. What "reset access" means for automation. */
  deleteAgentKeysFor(userId: string): number {
    return this.db.query("delete from agent_key where user_id = ?").run(userId).changes;
  }

  /** Rename one key. Empty means no name, the same rule `putAgentKey` applies on the way in. */
  renameAgentKey(id: string, userId: string, name: string | null): boolean {
    return (
      this.db
        .query("update agent_key set name = ? where id = ? and user_id = ?")
        .run(name?.trim() || null, id, userId).changes > 0
    );
  }

  /**
   * Record activity, at minute granularity -- the same condition and the same reason as
   * `touchSession`. This runs on EVERY agent-authenticated request, and "when was this key
   * last used" is a question a value under a minute old already answers.
   */
  /**
   * BY KEY ID, not by user -- which is the whole reason a name is worth having.
   *
   * It touched every row a user owned, which was correct while there was exactly one. With
   * several it would stamp the key that has sat unused for a month every time the busy one
   * made a request, so "last used never" -- the fact that tells you which row is safe to
   * revoke -- would be true of nothing.
   */
  touchAgentKey(id: string, now?: Date): void {
    const t = now ?? new Date();
    this.db
      .query(
        "update agent_key set last_used_at = ? where id = ? and (last_used_at is null or last_used_at <= ?)",
      )
      .run(isoNow(t), id, isoIn(-SWEEP_INTERVAL_MS, t));
  }

  // --- push subscriptions --------------------------------------------------
  //
  // Beside sessions rather than in the store's own file, for the reason the table's own
  // comment gives: a subscription is a DEVICE ATTACHED TO AN ACCOUNT, and it has to die
  // with that account. Everything else about it -- when to send, what to say -- is
  // `src/server/push.ts`'s business and none of it is here.

  /**
   * Record a browser's subscription, or refresh the one it already had.
   *
   * UPSERT, because a browser re-subscribes routinely: a push service may rotate an
   * endpoint's keys, and the app re-subscribes on every load to notice when it has. The
   * conflict arm rewrites `user_id` as well as the keys, which is the case of a shared
   * device -- one person signs out, another signs in, and the endpoint now belongs to them.
   * Leaving the old owner would push one person's news to the other's phone.
   */
  putPushSubscription(s: {
    endpoint: string;
    userId: string;
    p256dh: string;
    auth: string;
    userAgent?: string | null;
    now?: Date;
  }): void {
    this.db
      .query(
        `insert into push_subscription (endpoint, user_id, p256dh, auth, user_agent, created_at)
         values (?, ?, ?, ?, ?, ?)
         on conflict(endpoint) do update set
           user_id = excluded.user_id, p256dh = excluded.p256dh,
           auth = excluded.auth, user_agent = excluded.user_agent`,
      )
      .run(s.endpoint, s.userId, s.p256dh, s.auth, s.userAgent ?? null, isoNow(s.now));
  }

  /**
   * Forget one browser's subscription.
   *
   * Scoped to the owner, so the endpoint alone is not enough to unsubscribe somebody else's
   * device. An endpoint URL is not a secret from the push service's point of view, and a
   * delete keyed on it alone would be a stranger's off switch for your notifications.
   */
  deletePushSubscription(userId: string, endpoint: string): boolean {
    return (
      this.db.query("delete from push_subscription where user_id = ? and endpoint = ?").run(userId, endpoint)
        .changes > 0
    );
  }

  /**
   * Drop a dead endpoint, whoever it belonged to.
   *
   * The 404/410 path, and the one place the owner is NOT part of the key: the push service
   * has said this endpoint no longer exists, which is true regardless of whose it was.
   */
  forgetPushEndpoint(endpoint: string): void {
    this.db.query("delete from push_subscription where endpoint = ?").run(endpoint);
  }

  listPushSubscriptions(userId: string): PushSubscriptionRow[] {
    return this.db
      .query("select * from push_subscription where user_id = ? order by created_at asc")
      .all(userId) as PushSubscriptionRow[];
  }

  /** Stamped after a successful send, so an admin can see which devices are still real. */
  markPushSent(endpoint: string, now?: Date): void {
    this.db
      .query("update push_subscription set last_sent_at = ? where endpoint = ?")
      .run(isoNow(now), endpoint);
  }

  pushSubscriptionCount(): number {
    const r = this.db.query("select count(*) as n from push_subscription").get() as { n: number };
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
