import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { AuthStore, applyAuthSchema } from "./auth-store";
import {
  applySeerrImport,
  displayNameFor,
  isSeerrAdmin,
  normalisePlexId,
  planSeerrImport,
  readSeerrUsers,
  type SeerrUser,
} from "./seerr-import";

function seerrUser(over: Partial<SeerrUser> & { id: number }): SeerrUser {
  return {
    plexId: null,
    plexUsername: null,
    username: null,
    permissions: 0,
    ...over,
  };
}

/** A Seerr `user` table shaped like the real one, for the reader test. */
function seerrFixture(): Database {
  const db = new Database(":memory:");
  db.run(`create table "user" (
    "id" integer primary key autoincrement not null,
    "email" varchar not null,
    "username" varchar,
    "plexId" integer,
    "plexToken" varchar,
    "permissions" integer not null default (0),
    "avatar" varchar not null,
    "plexUsername" varchar,
    "password" varchar
  )`);
  return db;
}

describe("normalisePlexId", () => {
  test("keeps a positive integer, as a string", () => {
    expect(normalisePlexId(2326453)).toBe("2326453");
    expect(normalisePlexId("2326453")).toBe("2326453");
  });

  test("treats null, 0 and empty as absent -- Seerr uses all three for a local user", () => {
    expect(normalisePlexId(null)).toBeNull();
    expect(normalisePlexId(undefined)).toBeNull();
    expect(normalisePlexId(0)).toBeNull();
    expect(normalisePlexId("0")).toBeNull();
    expect(normalisePlexId("")).toBeNull();
    expect(normalisePlexId("   ")).toBeNull();
  });

  test("refuses anything that is not a plain number", () => {
    expect(normalisePlexId("nm12345")).toBeNull();
    expect(normalisePlexId("12 or 1=1")).toBeNull();
    expect(normalisePlexId(-5)).toBeNull();
    expect(normalisePlexId(Number.NaN)).toBeNull();
  });
});

describe("displayNameFor", () => {
  test("prefers the Plex username -- it is the name they sign in under", () => {
    expect(displayNameFor(seerrUser({ id: 1, plexUsername: "mangemus", username: "Mange" }))).toBe(
      "mangemus",
    );
  });

  test("falls back to Seerr's own username, then to something generic", () => {
    expect(displayNameFor(seerrUser({ id: 1, username: "Mange" }))).toBe("Mange");
    expect(displayNameFor(seerrUser({ id: 1 }))).toBe("finderr user");
    expect(displayNameFor(seerrUser({ id: 1, plexUsername: "  ", username: "  " }))).toBe("finderr user");
  });
});

describe("planSeerrImport", () => {
  test("creates a row per Plex-linked user, always as role user", () => {
    const plan = planSeerrImport({
      users: [
        seerrUser({ id: 2, plexId: "2326453", plexUsername: "mangemus" }),
        seerrUser({ id: 3, plexId: "176703326", plexUsername: "andretimms" }),
      ],
      existingPlexIds: [],
    });
    expect(plan.creates).toHaveLength(2);
    expect(plan.creates.map((c) => c.plexId)).toEqual(["2326453", "176703326"]);
    expect(plan.creates.every((c) => c.role === "user")).toBe(true);
  });

  test("a Seerr ADMIN is imported as a plain user, and flagged rather than promoted", () => {
    const plan = planSeerrImport({
      users: [seerrUser({ id: 1, plexId: "1847206", plexUsername: "boss", permissions: 2 })],
      existingPlexIds: [],
    });
    expect(plan.creates[0]?.role).toBe("user");
    expect(plan.creates[0]?.seerrAdmin).toBe(true);
  });

  test("skips a user with no Plex account -- there is nothing to sign in with", () => {
    const plan = planSeerrImport({
      users: [seerrUser({ id: 9, plexId: null, username: "local-only" })],
      existingPlexIds: [],
    });
    expect(plan.creates).toHaveLength(0);
    expect(plan.skips[0]?.reason).toBe("no-plex-id");
  });

  test("skips an excluded id, and reports the operator's own reason for it", () => {
    const plan = planSeerrImport({
      users: [
        seerrUser({ id: 1, plexId: "1847206", plexUsername: "boss" }),
        seerrUser({ id: 2, plexId: "2326453", plexUsername: "mangemus" }),
      ],
      existingPlexIds: [],
      exclude: ["1847206"],
    });
    expect(plan.creates.map((c) => c.plexId)).toEqual(["2326453"]);
    expect(plan.skips[0]).toMatchObject({ plexId: "1847206", reason: "excluded" });
  });

  test("exclusion beats already-linked, so the operator sees their own instruction", () => {
    const plan = planSeerrImport({
      users: [seerrUser({ id: 1, plexId: "1847206" })],
      existingPlexIds: ["1847206"],
      exclude: ["1847206"],
    });
    expect(plan.skips[0]?.reason).toBe("excluded");
  });

  /**
   * The whole point of the job being re-runnable. A second run must plan zero writes.
   */
  test("is idempotent: a plex id finderr already holds is skipped", () => {
    const users = [
      seerrUser({ id: 2, plexId: "2326453", plexUsername: "mangemus" }),
      seerrUser({ id: 3, plexId: "176703326", plexUsername: "andretimms" }),
    ];
    const first = planSeerrImport({ users, existingPlexIds: [] });
    expect(first.creates).toHaveLength(2);

    // Second run, with the ids the first run would have written now present.
    const second = planSeerrImport({
      users,
      existingPlexIds: first.creates.map((c) => c.plexId),
    });
    expect(second.creates).toHaveLength(0);
    expect(second.skips.every((s) => s.reason === "already-linked")).toBe(true);
  });

  test("a duplicate plex id inside ONE source only ever creates one row", () => {
    const plan = planSeerrImport({
      users: [
        seerrUser({ id: 2, plexId: "2326453", plexUsername: "mangemus" }),
        seerrUser({ id: 7, plexId: "2326453", plexUsername: "mangemus-again" }),
      ],
      existingPlexIds: [],
    });
    expect(plan.creates).toHaveLength(1);
    expect(plan.skips[0]?.reason).toBe("duplicate-in-source");
  });

  /**
   * A username is editable by its owner; the id is not. Matching on the name would let a
   * rename collect somebody else's account, so a changed username must be a no-op.
   */
  test("matches on the id alone -- a renamed Plex account is still already-linked", () => {
    const plan = planSeerrImport({
      users: [seerrUser({ id: 2, plexId: "2326453", plexUsername: "a-brand-new-name" })],
      existingPlexIds: ["2326453"],
    });
    expect(plan.creates).toHaveLength(0);
    expect(plan.skips[0]?.reason).toBe("already-linked");
  });

  test("an integer id from SQLite and a string id from finderr are one identity", () => {
    const plan = planSeerrImport({
      users: [{ ...seerrUser({ id: 2 }), plexId: 2326453 as unknown as string }],
      existingPlexIds: ["2326453"],
    });
    expect(plan.creates).toHaveLength(0);
    expect(plan.skips[0]?.reason).toBe("already-linked");
  });
});

describe("readSeerrUsers", () => {
  test("reads the five deciding columns and never a credential", () => {
    const db = seerrFixture();
    db.run(
      `insert into "user" (email, username, plexId, plexToken, permissions, avatar, plexUsername, password)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["a@example.test", "Mange", 2326453, "SECRET-PLEX-TOKEN", 32, "", "mangemus", "SECRET-HASH"],
    );
    db.run(
      `insert into "user" (email, username, plexId, permissions, avatar, plexUsername)
       values (?, ?, ?, ?, ?, ?)`,
      ["b@example.test", null, null, 0, "", null],
    );

    const users = readSeerrUsers(db);
    expect(users).toHaveLength(2);
    expect(users[0]).toEqual({
      id: 1,
      plexId: "2326453",
      plexUsername: "mangemus",
      username: "Mange",
      permissions: 32,
    });
    // The integer column arrives as a string, which is what finderr stores.
    expect(typeof users[0]?.plexId).toBe("string");
    expect(users[1]?.plexId).toBeNull();
    // No credential field is even present on the returned shape.
    expect(JSON.stringify(users)).not.toContain("SECRET");
  });

  /**
   * `permissions` is `integer NOT NULL DEFAULT 0` in Seerr's real schema, so the `?? 0`
   * in `readSeerrUsers` cannot fire against a current Overseerr. It stays as cheap
   * defence for an older dump, and this test pins the constraint that makes it dead code
   * today -- so if a future Seerr drops NOT NULL, this goes red and says why.
   */
  test("permissions is NOT NULL in Seerr's schema, so the admin check always has a number", () => {
    const db = seerrFixture();
    db.run(`insert into "user" (email, avatar) values ('c@example.test', '')`);
    // The column defaults to 0 and refuses to be emptied, on a row that exists.
    expect(readSeerrUsers(db)[0]?.permissions).toBe(0);
    expect(() => db.run(`update "user" set permissions = null`)).toThrow(/NOT NULL/);
  });
});

describe("isSeerrAdmin", () => {
  test("reads the ADMIN bit, not the whole field", () => {
    expect(isSeerrAdmin({ permissions: 2 })).toBe(true);
    expect(isSeerrAdmin({ permissions: 32 })).toBe(false);
    expect(isSeerrAdmin({ permissions: 160 })).toBe(false);
    // The one real account carrying a very large bitfield, which does not include ADMIN.
    expect(isSeerrAdmin({ permissions: 8388768 })).toBe(false);
  });
});

describe("applySeerrImport against a real AuthStore", () => {
  /** The app's own schema, never a hand-copy -- a copy would drift out of the product. */
  function freshStore(): AuthStore {
    const db = new Database(":memory:");
    db.run("pragma foreign_keys = on");
    applyAuthSchema(db);
    return new AuthStore(db);
  }

  test("writes exactly the creates, and a second apply writes nothing", () => {
    const auth = freshStore();

    const users = [
      seerrUser({ id: 2, plexId: "2326453", plexUsername: "mangemus" }),
      seerrUser({ id: 3, plexId: "176703326", plexUsername: "andretimms" }),
    ];

    const plan = planSeerrImport({ users, existingPlexIds: [] });
    const created = applySeerrImport(auth, plan);
    expect(created).toHaveLength(2);

    // The rows are real, carry the Plex id, and are plain users.
    const andre = auth.getUserByPlexId("176703326");
    expect(andre?.role).toBe("user");
    expect(andre?.plexUsername).toBe("andretimms");
    expect(andre?.disabledAt).toBeNull();

    // Re-run: plan from the CURRENT database, which is what the job does.
    const existing = auth
      .listUsers()
      .map((u) => u.plexId)
      .filter((id): id is string => id !== null);
    const again = planSeerrImport({ users, existingPlexIds: existing });
    expect(applySeerrImport(auth, again)).toHaveLength(0);
    expect(auth.listUsers()).toHaveLength(2);
  });

  /**
   * The reason the whole migration is possible, pinned so a refactor of the sign-in
   * ceremony cannot quietly remove it.
   *
   * `/api/auth/plex/finish` takes the `getUserByPlexId` branch BEFORE it looks for an
   * invite. A migrated row has redeemed nothing and holds no credential, so if that
   * lookup did not answer, every migrated user would be refused a 403 on first sign-in.
   */
  test("a migrated row is found by plex id with no invite and no credential", () => {
    const auth = freshStore();
    applySeerrImport(
      auth,
      planSeerrImport({
        users: [seerrUser({ id: 3, plexId: "176703326", plexUsername: "andretimms" })],
        existingPlexIds: [],
      }),
    );

    const found = auth.getUserByPlexId("176703326");
    expect(found).not.toBeNull();
    // The three things the sign-in branch actually reads.
    expect(found?.plexId).toBe("176703326");
    expect(found?.disabledAt).toBeNull();
    expect(found?.role).toBe("user");
    // And the things it deliberately does NOT need.
    expect(auth.credentialsFor(found?.id ?? "")).toHaveLength(0);
    expect(auth.listInvites()).toHaveLength(0);
  });
});
