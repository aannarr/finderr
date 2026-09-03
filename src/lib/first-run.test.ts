import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { isoIn } from "./auth";
import { AUTH_SCHEMA, AuthStore } from "./auth-store";
import { FIRST_RUN_CLOSED_KEY, FirstRun } from "./first-run";
import type { KeyValueStore } from "./store";

function memoryKv(): KeyValueStore {
  const rows = new Map<string, string>();
  return {
    getKv: (key) => rows.get(key) ?? null,
    setKv: (key, value) => void rows.set(key, value),
  };
}

let auth: AuthStore;
let kv: KeyValueStore;
let firstRun: FirstRun;

beforeEach(() => {
  const db = new Database(":memory:");
  db.run("pragma foreign_keys = on");
  db.run(AUTH_SCHEMA);
  auth = new AuthStore(db);
  kv = memoryKv();
  firstRun = new FirstRun({ auth, kv, log: () => {} });
});

describe("whether the door is open", () => {
  test("an empty server is claimable", () => {
    expect(firstRun.open()).toBe(true);
  });

  test("a server with an account is not", () => {
    auth.createUser({ displayName: "A", role: "admin" });
    expect(firstRun.open()).toBe(false);
  });

  /*
    The latch is the whole reason this is not a `userCount() === 0` check written inline.
    Both situations show zero users; only one of them is a first install.
  */
  test("once closed it stays closed, even with the user table empty again", () => {
    const u = auth.createUser({ displayName: "A", role: "admin" });
    expect(firstRun.open()).toBe(false);
    auth.deleteUser(u.id);
    expect(auth.userCount()).toBe(0);
    expect(firstRun.open()).toBe(false);
  });

  test("closing is PERSISTED, so a restart cannot reopen it", () => {
    auth.createUser({ displayName: "A", role: "admin" });
    firstRun.open();
    expect(kv.getKv(FIRST_RUN_CLOSED_KEY)).not.toBeNull();

    // A fresh instance is what the next boot builds: same database, same kv, no memory.
    expect(new FirstRun({ auth, kv, log: () => {} }).open()).toBe(false);
  });
});

describe("the claim it hands the sign-up ceremonies", () => {
  test("it is an admin invite, minted by first-run", () => {
    const hash = firstRun.claimHash();
    expect(hash).not.toBeNull();
    const invite = auth.getInvite(hash as string);
    expect(invite?.role).toBe("admin");
    expect(invite?.createdBy).toBe("first-run");
    expect(invite?.redeemedAt).toBeNull();
  });

  test("asking twice reuses the live one rather than minting a second", () => {
    const first = firstRun.claimHash();
    expect(firstRun.claimHash()).toBe(first as string);
    expect(auth.listInvites()).toHaveLength(1);
  });

  /*
    A claim that has been redeemed is spent, and the next asker gets a NEW one rather than
    nothing. That is the recovery path for a sign-up that died between claiming the invite
    and writing the user row -- refusing here would brick the only door over a crash.
  */
  test("a spent claim is replaced, so a half-finished sign-up cannot brick the door", () => {
    const hash = firstRun.claimHash() as string;
    auth.claimInvite(hash);
    expect(firstRun.claimHash()).not.toBe(hash);
  });

  test("an expired claim is replaced rather than resurrected", () => {
    const { invite } = auth.createInvite({
      role: "admin",
      createdBy: "first-run",
      expiresAt: isoIn(-1000),
    });
    expect(firstRun.claimHash()).not.toBe(invite.tokenHash);
  });

  test("a closed door hands out nothing", () => {
    auth.createUser({ displayName: "A", role: "admin" });
    expect(firstRun.claimHash()).toBeNull();
  });

  /*
    An abandoned claim is a LIVE ADMIN INVITE. Nobody holds its token -- only the hash ever
    leaves this class -- but leaving the row behind would put an unexplained admin invitation
    in the admin UI and outlive the window that justified it.
  */
  test("closing the door revokes an abandoned claim", () => {
    firstRun.claimHash();
    auth.createUser({ displayName: "A", role: "admin" });
    firstRun.open();
    expect(auth.listInvites()).toHaveLength(0);
  });

  test("but it leaves the bootstrap invite alone, because that door is still real", () => {
    firstRun.claimHash();
    auth.createInvite({ role: "admin", createdBy: "bootstrap", expiresAt: isoIn(60_000) });
    auth.createUser({ displayName: "A", role: "admin" });
    firstRun.open();
    expect(auth.listInvites().map((i) => i.createdBy)).toEqual(["bootstrap"]);
  });

  test("and it leaves a REDEEMED claim alone, because that is the receipt for who got in", () => {
    const hash = firstRun.claimHash() as string;
    auth.claimInvite(hash);
    auth.createUser({ displayName: "A", role: "admin" });
    firstRun.open();
    expect(auth.listInvites().map((i) => i.tokenHash)).toEqual([hash]);
  });
});
