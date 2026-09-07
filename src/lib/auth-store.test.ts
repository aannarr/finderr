import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { hashToken, isoIn } from "./auth";
import { AUTH_SCHEMA, AuthStore, applyAuthSchema, migrateAgentKeys } from "./auth-store";

/**
 * An in-memory database with the same pragma the real `Store` sets.
 *
 * `foreign_keys` is NOT optional here: SQLite's default is off, and with it off every
 * `on delete cascade` in the schema is a comment. Half these tests would pass against a
 * database that leaks a session row per deleted user.
 */
function open(): AuthStore {
  const db = new Database(":memory:");
  db.run("pragma foreign_keys = on");
  applyAuthSchema(db);
  return new AuthStore(db);
}

let auth: AuthStore;
beforeEach(() => {
  auth = open();
});

describe("users", () => {
  test("a created user is readable and counted", () => {
    const u = auth.createUser({ displayName: "Ada", role: "admin" });
    expect(auth.getUser(u.id)?.displayName).toBe("Ada");
    expect(auth.userCount()).toBe(1);
    expect(auth.adminCount()).toBe(1);
  });

  test("a disabled admin is not counted as one -- the last-admin guard depends on it", () => {
    const u = auth.createUser({ displayName: "A", role: "admin" });
    auth.updateUser(u.id, { disabled: true });
    expect(auth.adminCount()).toBe(0);
    expect(auth.userCount()).toBe(1);
  });

  test("a plex account can only be linked to one user", () => {
    auth.createUser({ displayName: "A", role: "user", plexId: "42" });
    expect(() => auth.createUser({ displayName: "B", role: "user", plexId: "42" })).toThrow();
  });

  test("deleting a user cascades to credentials and sessions", () => {
    const u = auth.createUser({ displayName: "A", role: "user" });
    auth.addCredential({ id: "c1", userId: u.id, publicKey: "pk", counter: 0 });
    auth.createSession({ userId: u.id, expiresAt: isoIn(60_000) });
    expect(auth.credentialsFor(u.id)).toHaveLength(1);
    expect(auth.sessionCount()).toBe(1);

    auth.deleteUser(u.id);
    expect(auth.credentialsFor(u.id)).toHaveLength(0);
    expect(auth.sessionCount()).toBe(0);
  });
});

/**
 * THE SETTINGS AN ADMIN DECIDES, and the migration that has to reach a live database.
 *
 * `create table if not exists` is a no-op on a deployed file, so both columns exist only as
 * ALTERs in `AUTH_ADDED_COLUMNS`. Every test in this file goes through `applyAuthSchema`, so
 * the statement the NAS will run is the statement the suite runs -- which is the whole point
 * of there being one spelling of each column rather than two.
 */
describe("per-user settings", () => {
  test("a new account follows the site quota and may use the assistant", () => {
    const u = auth.createUser({ displayName: "Ada", role: "user" });
    expect(u.quotaPerDay).toBeNull();
    expect(u.assistantAllowed).toBe(true);
    // What `createUser` RETURNS and what the row READS BACK as must agree -- the return
    // value is assembled in TypeScript and the row comes from the column defaults.
    expect(auth.getUser(u.id)).toEqual(u);
  });

  test("both are settable, and an absent field is untouched", () => {
    const u = auth.createUser({ displayName: "Ada", role: "user" });

    auth.updateUser(u.id, { quotaPerDay: 3 });
    auth.updateUser(u.id, { assistantAllowed: false });
    expect(auth.getUser(u.id)).toMatchObject({ quotaPerDay: 3, assistantAllowed: false });

    // A patch about the name says nothing about either, so neither moves.
    auth.updateUser(u.id, { displayName: "Ada Lovelace" });
    expect(auth.getUser(u.id)).toMatchObject({ quotaPerDay: 3, assistantAllowed: false });
  });

  test("null clears the quota override -- it is not the same as leaving it out", () => {
    const u = auth.createUser({ displayName: "Ada", role: "user" });
    auth.updateUser(u.id, { quotaPerDay: 3 });
    auth.updateUser(u.id, { quotaPerDay: null });
    expect(auth.getUser(u.id)?.quotaPerDay).toBeNull();
  });

  test("a database that predates the columns gains them, with everybody still allowed", () => {
    /*
      THE MIGRATION, run against the shape a deployed instance actually has. Only the
      `create table` half is applied first, so this is a database from before these columns
      existed; `applyAuthSchema` then has to add them WITHOUT disturbing the row.

      `assistant_allowed` carries `not null default 1` precisely so SQLite fills it in for
      every existing row: a feature that had been available yesterday must not disappear
      because of an upgrade nobody asked for.
    */
    const db = new Database(":memory:");
    db.run("pragma foreign_keys = on");
    db.run(AUTH_SCHEMA);
    db.query(
      "insert into app_user (id, display_name, role, created_at) values ('old', 'Ada', 'user', '2026-01-01T00:00:00.000Z')",
    ).run();

    applyAuthSchema(db);

    const migrated = new AuthStore(db).getUser("old");
    expect(migrated).toMatchObject({ displayName: "Ada", quotaPerDay: null, assistantAllowed: true });
  });
});

describe("credentials", () => {
  test("the public key round-trips as text, never as a blob", () => {
    const u = auth.createUser({ displayName: "A", role: "user" });
    const key = Buffer.from([1, 2, 3, 250, 251]).toString("base64url");
    auth.addCredential({ id: "c1", userId: u.id, publicKey: key, counter: 0, transports: ["internal"] });
    const c = auth.getCredential("c1");
    expect(c?.publicKey).toBe(key);
    expect(typeof c?.publicKey).toBe("string");
    expect(c?.transports).toEqual(["internal"]);
  });

  test("a counter that never moves is stored, not refused -- Apple passkeys pin it at 0", () => {
    const u = auth.createUser({ displayName: "A", role: "user" });
    auth.addCredential({ id: "c1", userId: u.id, publicKey: "pk", counter: 0 });
    auth.markCredentialUsed("c1", 0);
    const c = auth.getCredential("c1");
    expect(c?.counter).toBe(0);
    expect(c?.lastUsedAt).not.toBeNull();
  });

  test("a credential can only be deleted by its owner", () => {
    const a = auth.createUser({ displayName: "A", role: "user" });
    const b = auth.createUser({ displayName: "B", role: "user" });
    auth.addCredential({ id: "c1", userId: a.id, publicKey: "pk", counter: 0 });
    expect(auth.deleteCredential("c1", b.id)).toBe(false);
    expect(auth.deleteCredential("c1", a.id)).toBe(true);
  });

  test("a credential can only be renamed by its owner", () => {
    // Same rule as deleting, and it matters for the same reason: a credential id is not a
    // secret, so holding one must never be authority over it.
    const a = auth.createUser({ displayName: "A", role: "user" });
    const b = auth.createUser({ displayName: "B", role: "user" });
    auth.addCredential({ id: "c1", userId: a.id, publicKey: "pk", counter: 0, label: "Mac" });

    expect(auth.renameCredential("c1", b.id, "stolen")).toBe(false);
    expect(auth.getCredential("c1")?.label).toBe("Mac");
    expect(auth.renameCredential("c1", a.id, "work laptop")).toBe(true);
    expect(auth.getCredential("c1")?.label).toBe("work laptop");
  });

  test("renaming an id that does not exist is false, not a throw", () => {
    const a = auth.createUser({ displayName: "A", role: "user" });
    expect(auth.renameCredential("nope", a.id, "x")).toBe(false);
  });

  test("an emptied name is stored as NULL, so the row falls back to its device type", () => {
    // Two spellings of "no name" would drift: the account page renders `label ?? deviceType`,
    // and an empty string is truthy enough to win that and draw a blank row.
    const u = auth.createUser({ displayName: "A", role: "user" });
    auth.addCredential({ id: "c1", userId: u.id, publicKey: "pk", counter: 0, label: "Mac" });

    auth.renameCredential("c1", u.id, "   ");
    expect(auth.getCredential("c1")?.label).toBeNull();

    auth.renameCredential("c1", u.id, "phone");
    auth.renameCredential("c1", u.id, null);
    expect(auth.getCredential("c1")?.label).toBeNull();
  });

  test("a name is trimmed", () => {
    const u = auth.createUser({ displayName: "A", role: "user" });
    auth.addCredential({ id: "c1", userId: u.id, publicKey: "pk", counter: 0 });
    auth.renameCredential("c1", u.id, "  work laptop  ");
    expect(auth.getCredential("c1")?.label).toBe("work laptop");
  });
});

describe("linking a Plex account to an existing user", () => {
  test("linkPlex attaches an id and a username", () => {
    // Declared since the auth work landed and called by nothing until the account page
    // needed it -- this is the first exercise it has ever had.
    const u = auth.createUser({ displayName: "A", role: "user" });
    expect(u.plexId).toBeNull();

    auth.linkPlex(u.id, "plex-123", "ada");
    const linked = auth.getUser(u.id);
    expect(linked?.plexId).toBe("plex-123");
    expect(linked?.plexUsername).toBe("ada");
    expect(auth.getUserByPlexId("plex-123")?.id).toBe(u.id);
  });

  test("a Plex account with no username still links, and is still findable by id", () => {
    // Plex does not promise a username. The account page must not read this as unconnected
    // -- see `plexConnected` in auth.ts, which is why that field exists.
    const u = auth.createUser({ displayName: "A", role: "user" });
    auth.linkPlex(u.id, "plex-456", null);
    expect(auth.getUser(u.id)?.plexId).toBe("plex-456");
    expect(auth.getUser(u.id)?.plexUsername).toBeNull();
    expect(auth.getUserByPlexId("plex-456")?.id).toBe(u.id);
  });

  test("unlinkPlex clears both halves, so the account is no longer findable by plex id", () => {
    const u = auth.createUser({ displayName: "A", role: "user" });
    auth.linkPlex(u.id, "plex-789", "ada");
    auth.unlinkPlex(u.id);
    expect(auth.getUser(u.id)?.plexId).toBeNull();
    expect(auth.getUser(u.id)?.plexUsername).toBeNull();
    expect(auth.getUserByPlexId("plex-789")).toBeNull();
  });

  test("re-linking after an unlink works -- the row is not poisoned", () => {
    const u = auth.createUser({ displayName: "A", role: "user" });
    auth.linkPlex(u.id, "plex-1", "ada");
    auth.unlinkPlex(u.id);
    auth.linkPlex(u.id, "plex-2", "ada2");
    expect(auth.getUser(u.id)?.plexId).toBe("plex-2");
  });
});

describe("invites", () => {
  test("only the hash is stored, so the table holds nothing anybody can sign in with", () => {
    const { token, invite } = auth.createInvite({ role: "user", expiresAt: isoIn(3_600_000) });
    expect(invite.tokenHash).toBe(hashToken(token));
    expect(auth.getInvite(invite.tokenHash)?.role).toBe("user");
    expect(auth.getInvite(token)).toBeNull();
  });

  /*
    The race the single-statement claim exists to decide. With select-then-update, two
    people opening the same link milliseconds apart both pass the check and both get an
    account.
  */
  test("two claims of one invite: exactly one wins", () => {
    const { token } = auth.createInvite({ role: "user", expiresAt: isoIn(3_600_000) });
    const h = hashToken(token);
    const first = auth.claimInvite(h);
    const second = auth.claimInvite(h);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  test("an expired invite cannot be claimed", () => {
    const { token } = auth.createInvite({ role: "user", expiresAt: isoIn(-1000) });
    expect(auth.claimInvite(hashToken(token))).toBeNull();
  });

  /*
    THE FOREIGN KEY ORDERING. `redeemed_by` points at a user row that does not exist at
    claim time, so writing it in the claim fails the constraint -- claim, create, then
    attribute.
  */
  test("attribution succeeds only after the user exists", () => {
    const { token } = auth.createInvite({ role: "user", expiresAt: isoIn(3_600_000) });
    const h = hashToken(token);
    auth.claimInvite(h);
    expect(() => auth.attributeInvite(h, "a-user-that-was-never-created")).toThrow();

    const u = auth.createUser({ displayName: "A", role: "user" });
    auth.attributeInvite(h, u.id);
    expect(auth.getInvite(h)?.redeemedBy).toBe(u.id);
  });

  test("resetting an invite makes it usable again, which is the botched-signup fix", () => {
    const { token } = auth.createInvite({ role: "user", expiresAt: isoIn(3_600_000) });
    const h = hashToken(token);
    auth.claimInvite(h);
    auth.resetInvite(h);
    expect(auth.claimInvite(h)).not.toBeNull();
  });
});

describe("sessions", () => {
  test("the cookie value is not what is stored", () => {
    const u = auth.createUser({ displayName: "A", role: "user" });
    const token = auth.createSession({ userId: u.id, expiresAt: isoIn(60_000) });
    expect(auth.readSession(token)?.user.id).toBe(u.id);
    expect(auth.sessionsFor(u.id)[0]?.idHash).toBe(hashToken(token));
  });

  test("an expired session is swept on the read that finds it", () => {
    const u = auth.createUser({ displayName: "A", role: "user" });
    const token = auth.createSession({ userId: u.id, expiresAt: isoIn(-1000) });
    expect(auth.readSession(token)).toBeNull();
    expect(auth.sessionCount()).toBe(0);
  });

  test("a disabled user's live session stops resolving", () => {
    const u = auth.createUser({ displayName: "A", role: "user" });
    const token = auth.createSession({ userId: u.id, expiresAt: isoIn(60_000) });
    auth.updateUser(u.id, { disabled: true });
    expect(auth.readSession(token)).toBeNull();
  });
});

describe("challenges", () => {
  test("read-once: a challenge that survives its own use is a replay", () => {
    const id = auth.putChallenge({ challenge: "abc", kind: "login", expiresAt: isoIn(60_000) });
    expect(auth.takeChallenge(id)?.challenge).toBe("abc");
    expect(auth.takeChallenge(id)).toBeNull();
  });

  test("an expired challenge is refused and swept", () => {
    const id = auth.putChallenge({ challenge: "abc", kind: "login", expiresAt: isoIn(-1000) });
    expect(auth.takeChallenge(id)).toBeNull();
  });

  test("the invite and the pending user id travel with the challenge, not with the client", () => {
    const id = auth.putChallenge({
      challenge: "abc",
      kind: "register",
      userId: "pending-1",
      inviteHash: "deadbeef",
      displayName: "A",
      expiresAt: isoIn(60_000),
    });
    const c = auth.takeChallenge(id);
    expect(c?.userId).toBe("pending-1");
    expect(c?.inviteHash).toBe("deadbeef");
  });
});

describe("plex pins", () => {
  test("a pin is peeked repeatedly while the user types, then deleted explicitly", () => {
    auth.putPin({ id: "p1", clientId: "c", inviteHash: "h", expiresAt: isoIn(60_000) });
    expect(auth.peekPin("p1")?.clientId).toBe("c");
    expect(auth.peekPin("p1")?.inviteHash).toBe("h");
    auth.deletePin("p1");
    expect(auth.peekPin("p1")).toBeNull();
  });

  test("an expired pin is gone", () => {
    auth.putPin({ id: "p1", clientId: "c", expiresAt: isoIn(-1000) });
    expect(auth.peekPin("p1")).toBeNull();
  });
});

describe("push subscriptions", () => {
  const sub = (endpoint: string, userId: string) => ({
    endpoint,
    userId,
    p256dh: "key",
    auth: "secret",
  });

  test("a subscription round-trips and is counted", () => {
    const u = auth.createUser({ displayName: "Ada", role: "user" });
    auth.putPushSubscription(sub("https://push.example/1", u.id));
    expect(auth.listPushSubscriptions(u.id).map((s) => s.endpoint)).toEqual(["https://push.example/1"]);
    expect(auth.pushSubscriptionCount()).toBe(1);
  });

  /**
   * A browser re-subscribes routinely -- a push service may rotate an endpoint's keys, and
   * the app re-checks on every load. Insert-only would make each of those a duplicate row,
   * and one arrival would then be delivered to the same device several times.
   */
  test("re-subscribing the same endpoint updates rather than duplicating", () => {
    const u = auth.createUser({ displayName: "Ada", role: "user" });
    auth.putPushSubscription(sub("https://push.example/1", u.id));
    auth.putPushSubscription({ ...sub("https://push.example/1", u.id), p256dh: "rotated" });
    const rows = auth.listPushSubscriptions(u.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.p256dh).toBe("rotated");
  });

  /**
   * A SHARED DEVICE. One person signs out, another signs in, and the browser re-subscribes
   * with the endpoint it already had. The row has to change hands, or one person's arrivals
   * are pushed to the other's phone.
   */
  test("an endpoint that changes owner follows the new one", () => {
    const ana = auth.createUser({ displayName: "Ana", role: "user" });
    const ben = auth.createUser({ displayName: "Ben", role: "user" });
    auth.putPushSubscription(sub("https://push.example/shared", ana.id));
    auth.putPushSubscription(sub("https://push.example/shared", ben.id));
    expect(auth.listPushSubscriptions(ana.id)).toHaveLength(0);
    expect(auth.listPushSubscriptions(ben.id)).toHaveLength(1);
  });

  /**
   * An endpoint URL is not a secret from the push service's point of view, so a delete
   * keyed on it alone would be a stranger's off switch for somebody else's notifications.
   */
  test("unsubscribing is scoped to the owner", () => {
    const ana = auth.createUser({ displayName: "Ana", role: "user" });
    const ben = auth.createUser({ displayName: "Ben", role: "user" });
    auth.putPushSubscription(sub("https://push.example/ana", ana.id));
    expect(auth.deletePushSubscription(ben.id, "https://push.example/ana")).toBe(false);
    expect(auth.deletePushSubscription(ana.id, "https://push.example/ana")).toBe(true);
  });

  /** The 404/410 path: the push service has said this endpoint is gone, whoever owned it. */
  test("forgetting a dead endpoint does not need to know whose it was", () => {
    const u = auth.createUser({ displayName: "Ada", role: "user" });
    auth.putPushSubscription(sub("https://push.example/dead", u.id));
    auth.forgetPushEndpoint("https://push.example/dead");
    expect(auth.pushSubscriptionCount()).toBe(0);
  });

  /**
   * The reason the table is declared beside `app_user` rather than with the rest of the
   * request machinery: a subscription is a device that will be pushed to on somebody's
   * behalf, and leaving one behind means going on notifying a phone about an account that
   * no longer exists.
   */
  test("deleting a user takes their subscriptions with it", () => {
    const u = auth.createUser({ displayName: "Ada", role: "user" });
    auth.putPushSubscription(sub("https://push.example/1", u.id));
    auth.deleteUser(u.id);
    expect(auth.pushSubscriptionCount()).toBe(0);
  });

  /**
   * "Turn it off everywhere", and the reason it cannot be a loop of `deletePushSubscription`
   * in the browser: an endpoint lives in the browser that owns it, so a phone that was sold
   * or reset can never unsubscribe itself. This is the only reach the account has over it.
   */
  test("every device at once, scoped to the one account", () => {
    const ana = auth.createUser({ displayName: "Ana", role: "user" });
    const ben = auth.createUser({ displayName: "Ben", role: "user" });
    auth.putPushSubscription(sub("https://push.example/ana-1", ana.id));
    auth.putPushSubscription(sub("https://push.example/ana-2", ana.id));
    auth.putPushSubscription(sub("https://push.example/ben", ben.id));

    expect(auth.deletePushSubscriptionsFor(ana.id)).toBe(2);
    expect(auth.listPushSubscriptions(ana.id)).toHaveLength(0);
    expect(auth.listPushSubscriptions(ben.id)).toHaveLength(1);
  });
});

/**
 * ASKED ONCE, EVER -- aannarr, 2026-09-07: *"USER TO OPT IN ... we NEVER repeat, so once
 * only"*.
 *
 * On the ACCOUNT rather than in the browser's storage, which is what makes it survive a new
 * device and a cleared cache. The offer is `PushOffer` on `/requests`; this column is the
 * only thing standing between it and being a nag.
 */
describe("the notifications question is put to a person once", () => {
  test("a new account has never been asked", () => {
    const u = auth.createUser({ displayName: "Ada", role: "user" });
    expect(u.pushOfferedAt).toBeNull();
    expect(auth.getUser(u.id)?.pushOfferedAt).toBeNull();
  });

  test("marking it sticks, and is read back off the row", () => {
    const u = auth.createUser({ displayName: "Ada", role: "user" });
    auth.markPushOffered(u.id, new Date("2026-09-07T10:00:00.000Z"));
    expect(auth.getUser(u.id)?.pushOfferedAt).toBe("2026-09-07T10:00:00.000Z");
  });

  /*
    FIRST WRITE WINS. Every route that records an answer calls this -- subscribing, declining
    and dismissing -- so a reader who says yes on a phone and then dismisses on a laptop
    would otherwise walk the timestamp forward. The first time we asked is the fact worth
    keeping.
  */
  test("asking again never moves the date", () => {
    const u = auth.createUser({ displayName: "Ada", role: "user" });
    auth.markPushOffered(u.id, new Date("2026-09-07T10:00:00.000Z"));
    auth.markPushOffered(u.id, new Date("2026-09-08T10:00:00.000Z"));
    expect(auth.getUser(u.id)?.pushOfferedAt).toBe("2026-09-07T10:00:00.000Z");
  });

  /** Turning notifications off is an ANSWER, not a reason to ask again. */
  test("de-registering every device leaves the question answered", () => {
    const u = auth.createUser({ displayName: "Ada", role: "user" });
    auth.markPushOffered(u.id);
    auth.putPushSubscription({
      endpoint: "https://push.example/1",
      userId: u.id,
      p256dh: "p",
      auth: "a",
    });
    auth.deletePushSubscriptionsFor(u.id);
    expect(auth.getUser(u.id)?.pushOfferedAt).not.toBeNull();
  });
});

describe("the hot path stays cheap without ever trusting the sweep", () => {
  test("an expired session is refused even when the sweep already ran this minute", () => {
    const u = auth.createUser({ displayName: "A", role: "user" });
    const live = auth.createSession({ userId: u.id, expiresAt: isoIn(60_000) });
    // Arms the once-a-minute sweep; the next read within the window must not rely on it.
    expect(auth.readSession(live)).not.toBeNull();
    const stale = auth.createSession({ userId: u.id, expiresAt: isoIn(-1000) });
    expect(auth.readSession(stale)).toBeNull();
  });

  test("touching a session writes at minute granularity, not per request", () => {
    const u = auth.createUser({ displayName: "A", role: "user" });
    const token = auth.createSession({ userId: u.id, expiresAt: isoIn(3_600_000) });
    const idHash = hashToken(token);
    const before = auth.sessionsFor(u.id)[0]?.lastSeenAt;

    auth.touchSession(idHash, new Date(Date.now() + 30_000));
    expect(auth.sessionsFor(u.id)[0]?.lastSeenAt).toBe(before as string);

    const later = new Date(Date.now() + 120_000);
    auth.touchSession(idHash, later);
    expect(auth.sessionsFor(u.id)[0]?.lastSeenAt).toBe(later.toISOString());
  });

  test("beginning a ceremony sweeps expired challenges -- finishing one is not the only exit", () => {
    // Own database handle: the row count is the observable, and AuthStore's is private.
    const db = new Database(":memory:");
    db.run("pragma foreign_keys = on");
    applyAuthSchema(db);
    const store = new AuthStore(db);
    store.putChallenge({ challenge: "old", kind: "login", expiresAt: isoIn(-1000) });
    store.putChallenge({ challenge: "new", kind: "login", expiresAt: isoIn(60_000) });
    const n = db.query("select count(*) as n from webauthn_challenge").get() as { n: number };
    expect(n.n).toBe(1);
  });
});

/*
  THE ONE MIGRATION IN THIS SCHEMA THAT `ADDED_COLUMNS` CANNOT DO, and the suite could not
  otherwise see it run.

  Every other test in this file goes through `applyAuthSchema`, which builds the CURRENT
  shape -- so `migrateAgentKeys` is a no-op in all of them and would stay green having done
  nothing. That is the exact class of check that passes without working. These build the
  pre-2026-09-07 table by hand, which is what a deployed database actually has.

  What is being defended is not the column list: it is that a LIVE CREDENTIAL keeps
  authenticating across the upgrade. A migration that dropped the token hashes would sign
  out every agent on the deployment at once, and the keys are re-mintable only by a person
  who notices.
*/
describe("agent_key, migrated from one-key-per-user", () => {
  /** The table exactly as it was before named keys. */
  function withOldShape(): { db: Database; auth: AuthStore } {
    const db = new Database(":memory:");
    db.run("pragma foreign_keys = on");
    applyAuthSchema(db);
    db.run("drop table agent_key");
    db.run(`create table agent_key (
      user_id      text primary key references app_user(id) on delete cascade,
      token_hash   text not null unique,
      created_at   text not null,
      last_used_at text,
      read_only    integer not null default 0
    )`);
    return { db, auth: new AuthStore(db) };
  }

  test("a token minted before the upgrade still resolves after it, with its facts intact", () => {
    const { db, auth } = withOldShape();
    const u = auth.createUser({ displayName: "old", role: "user" });
    const token = "a-live-token-from-before-the-upgrade";
    db.run(
      "insert into agent_key (user_id, token_hash, created_at, last_used_at, read_only) values (?,?,?,?,?)",
      [u.id, hashToken(token), "2026-01-01T00:00:00.000Z", "2026-02-02T00:00:00.000Z", 1],
    );

    migrateAgentKeys(db);

    const found = auth.getAgentKeyByHash(hashToken(token));
    expect(found).not.toBeNull();
    expect(found?.readOnly).toBe(true);
    expect(found?.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(found?.lastUsedAt).toBe("2026-02-02T00:00:00.000Z");
    expect(found?.id.length).toBeGreaterThan(0);
    // NULL rather than something like "Agent key": a name nobody chose is a fact this table
    // would be inventing, and every reader falls back to the kind.
    expect(found?.name).toBeNull();
    expect(auth.agentKeysFor(u.id)).toHaveLength(1);
  });

  /** It runs on EVERY boot, so running twice must not duplicate a row or throw. */
  test("it is idempotent, and a second key can then exist beside the migrated one", () => {
    const { db, auth } = withOldShape();
    const u = auth.createUser({ displayName: "old", role: "user" });
    db.run("insert into agent_key (user_id, token_hash, created_at, read_only) values (?,?,?,?)", [
      u.id,
      hashToken("t"),
      "2026-01-01T00:00:00.000Z",
      0,
    ]);

    migrateAgentKeys(db);
    migrateAgentKeys(db);
    expect(auth.agentKeysFor(u.id)).toHaveLength(1);

    // The whole point of the rebuild: a SECOND key, which the old primary key forbade.
    auth.putAgentKey({ userId: u.id, name: "new one", readOnly: false });
    expect(auth.agentKeysFor(u.id).map((k) => k.name)).toEqual(["new one", null]);
  });
});
