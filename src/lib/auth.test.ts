import { describe, expect, test } from "bun:test";
import {
  attributedRequest,
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
  quotaPerDay: null,
  assistantAllowed: true,
  pushOfferedAt: null,
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
    // An admin gets every admin-only key, normalised to null when the row carried none.
    // The client can therefore read `row.root_folder_path` without checking it exists.
    expect(visibleRequest(row, "admin")).toEqual({
      tconst: "tt0111161",
      title: "The Shawshank Redemption",
      requested_by: "u9",
      quality_profile_id: null,
      root_folder_path: null,
      search_on_add: null,
      via_agent_key: null,
    });
  });

  /*
    HOW an ask arrived is audit metadata beside WHO asked, so it is stripped by the same
    function for the same audience. Splitting them -- letting a user see the mechanism but
    not the person -- would be a second privacy rule with a second owner, and the second
    owner is always the one that gets forgotten.
  */
  test("via_agent_key rides with requested_by, not on its own", () => {
    const row = { tconst: "tt0111161", title: "x", requested_by: "u9", via_agent_key: 1 };

    expect(visibleRequest(row, "user")).toEqual({ tconst: "tt0111161", title: "x" });
    expect(visibleRequest(row, "admin").via_agent_key).toBe(1);
  });

  test("the arr overrides are admin-only too -- a root folder is a filesystem path", () => {
    // Not a credential, but the same class of fact as a hostname: an ordinary user has no
    // business being handed the server's directory layout by the request log.
    const row = {
      tconst: "tt0111161",
      title: "The Shawshank Redemption",
      requested_by: "u9",
      quality_profile_id: 7,
      root_folder_path: "/media/movies-4k",
      search_on_add: 0,
    };

    expect(visibleRequest(row, "user")).toEqual({
      tconst: "tt0111161",
      title: "The Shawshank Redemption",
    });
    // Normalised to null for the key this row does not carry, like every other admin-only
    // field -- so a client can read it without checking that it exists.
    expect(visibleRequest(row, "admin")).toEqual({ ...row, via_agent_key: null });
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

  /*
    The NAME rides on the same decision as the id. The request log prints a person rather
    than a user id, and resolving that name in whichever route happened to want it would put
    half the privacy rule in `visibleRequest` and half in a handler -- which is how the
    second reader of the log ships without the strip.
  */
  test("the requester's name is present for an admin and ABSENT for everybody else", () => {
    const row = { tconst: "tt0111161", title: "x", requested_by: "u9" };
    const names = (id: string) => (id === "u9" ? "Ada" : null);

    expect(attributedRequest(row, "admin", names).requestedByName).toBe("Ada");
    expect(Object.hasOwn(attributedRequest(row, "user", names), "requestedByName")).toBe(false);
    expect(Object.hasOwn(attributedRequest(row, null, names), "requestedByName")).toBe(false);
  });

  /*
    The absence IS the permission: `LogRoute` decides whether to draw a Who column by asking
    whether the server sent one, so a non-admin's rows must carry neither the name nor the
    id to draw it from.
  */
  test("a non-admin gets neither the name nor the id it would be drawn from", () => {
    const out = attributedRequest({ tconst: "tt1", title: "x", requested_by: "u9" }, "user", () => "Ada");
    expect(out).toEqual({ tconst: "tt1", title: "x" });
  });

  test("an unattributed row is null, and a deleted account is (removed) -- they are not the same fact", () => {
    const gone = attributedRequest({ tconst: "tt1", requested_by: "u404" }, "admin", () => null);
    const nobody = attributedRequest({ tconst: "tt1", requested_by: null }, "admin", () => "Ada");

    // Nobody will ever answer for the first; nobody ever asked in the second.
    expect(gone.requestedByName).toBe("(removed)");
    expect(nobody.requestedByName).toBe(null);
  });

  test("publicUser carries no plex id and no disabled timestamp", () => {
    const p = publicUser(user);
    expect(p).toEqual({
      id: "u1",
      displayName: "Ada",
      role: "admin",
      plexUsername: "ada",
      plexConnected: true,
      createdAt: "2026-08-31T00:00:00.000Z",
      lastSeenAt: null,
      disabled: false,
      quotaPerDay: null,
      assistantAllowed: true,
    });
    expect(Object.hasOwn(p, "plexId")).toBe(false);
  });

  test("plexConnected is about the ID, never about the username", () => {
    /*
      The bug this pins. Plex does not promise a username, so `linkPlex` can store a real
      plex id beside a null name. Deriving "connected" from the NAME would render that
      account as unconnected, beside a Connect button that then 409s with "a Plex account is
      already connected" -- a dead end with no way out but an admin reset.
    */
    expect(publicUser({ ...user, plexUsername: null }).plexConnected).toBe(true);
    expect(publicUser({ ...user, plexId: null, plexUsername: null }).plexConnected).toBe(false);
  });
});
