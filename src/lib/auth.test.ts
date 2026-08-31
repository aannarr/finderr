import { describe, expect, test } from "bun:test";
import {
  clearedSessionCookie,
  hashToken,
  isExpired,
  isoIn,
  newToken,
  publicUser,
  readCookie,
  SESSION_COOKIE,
  secretEquals,
  sessionCookie,
  type User,
  visibleRequest,
} from "./auth";

const user: User = {
  id: "u1",
  displayName: "Ada",
  role: "admin",
  plexId: "42",
  plexUsername: "ada",
  createdAt: "2026-08-31T00:00:00.000Z",
  lastSeenAt: null,
  disabledAt: null,
};

describe("secrets", () => {
  test("a token is 32 random bytes and never repeats", () => {
    const seen = new Set(Array.from({ length: 200 }, () => newToken()));
    expect(seen.size).toBe(200);
    expect(Buffer.from([...seen][0], "base64url").length).toBe(32);
  });

  test("the hash is stable and is not the token", () => {
    const t = newToken();
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).not.toBe(t);
    expect(hashToken(t)).toHaveLength(64);
  });

  test("secretEquals refuses a different length instead of throwing", () => {
    // node's timingSafeEqual THROWS on a length mismatch, so the guard is not optional --
    // without it every short candidate is a 500 rather than a refusal.
    expect(secretEquals("abc", "abcd")).toBe(false);
    expect(secretEquals("abcd", "abcd")).toBe(true);
    expect(secretEquals("", "")).toBe(true);
  });
});

describe("cookies", () => {
  test("Secure is a parameter, because a Secure cookie is dropped over plain http", () => {
    expect(sessionCookie("tok", { secure: false, maxAgeSeconds: 60 })).not.toContain("Secure");
    expect(sessionCookie("tok", { secure: true, maxAgeSeconds: 60 })).toContain("; Secure");
  });

  test("SameSite is Lax -- Strict drops the cookie on a followed invite link", () => {
    const c = sessionCookie("tok", { secure: true, maxAgeSeconds: 60 });
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Max-Age=60");
  });

  test("clearing is Max-Age=0 with the same flags", () => {
    expect(clearedSessionCookie({ secure: false })).toContain("Max-Age=0");
  });

  test("readCookie finds one name among several and tolerates junk", () => {
    expect(readCookie(`a=1; ${SESSION_COOKIE}=xyz; b=2`, SESSION_COOKIE)).toBe("xyz");
    expect(readCookie("novalue; a=1", SESSION_COOKIE)).toBeNull();
    expect(readCookie(null, SESSION_COOKIE)).toBeNull();
    expect(readCookie(`${SESSION_COOKIE}=`, SESSION_COOKIE)).toBeNull();
  });
});

describe("expiry", () => {
  test("compares ISO strings, which is why every column is TEXT", () => {
    const now = new Date("2026-08-31T12:00:00.000Z");
    expect(isExpired(isoIn(-1000, now), now)).toBe(true);
    expect(isExpired(isoIn(1000, now), now)).toBe(false);
  });
});

describe("who may see what", () => {
  /*
    THE privacy pin. aannarr, 2026-08-31: only admins may see who requested what, and the
    fact must not leak to a normal user. A component that merely declines to DRAW the name
    still ships the id in the JSON, so the rule has to be enforced on the way out.
  */
  test("requested_by is stripped for a user, absent for anonymous, present for an admin", () => {
    const row = { tconst: "tt0111161", title: "The Shawshank Redemption", requested_by: "u9" };

    expect(visibleRequest(row, "user")).toEqual({
      tconst: "tt0111161",
      title: "The Shawshank Redemption",
    });
    expect(visibleRequest(row, null)).toEqual({
      tconst: "tt0111161",
      title: "The Shawshank Redemption",
    });
    expect(visibleRequest(row, "admin")).toEqual({
      tconst: "tt0111161",
      title: "The Shawshank Redemption",
      requested_by: "u9",
    });
  });

  test("the key is GONE for a user, not merely null", () => {
    const out = visibleRequest({ id: 1, requested_by: "u9" }, "user");
    expect(Object.hasOwn(out, "requested_by")).toBe(false);
  });

  test("it does not mutate the row, so one row can serve two audiences", () => {
    const row = { id: 1, requested_by: "u9" };
    visibleRequest(row, "user");
    expect(row.requested_by).toBe("u9");
  });

  test("publicUser carries no plex id and no disabled timestamp", () => {
    const p = publicUser(user);
    expect(p).toEqual({
      id: "u1",
      displayName: "Ada",
      role: "admin",
      plexUsername: "ada",
      createdAt: "2026-08-31T00:00:00.000Z",
      lastSeenAt: null,
      disabled: false,
    });
    expect(Object.hasOwn(p, "plexId")).toBe(false);
  });
});
