import { describe, expect, test } from "bun:test";
import { inviteTokenFromPath } from "./AuthScreen";

/**
 * The pre-auth bundle reads ONE thing off the URL, and it hands the result to an endpoint
 * that consumes a bearer secret. A loose pattern here is how `/invite/a/b` becomes a
 * lookup for the token `a`.
 */
describe("inviteTokenFromPath", () => {
  test("reads the token, with or without a trailing slash", () => {
    expect(inviteTokenFromPath("/invite/abc123")).toBe("abc123");
    expect(inviteTokenFromPath("/invite/abc123/")).toBe("abc123");
  });

  test("decodes, because a base64url token can arrive percent-encoded", () => {
    expect(inviteTokenFromPath("/invite/a%2Db")).toBe("a-b");
  });

  test("everything else is not an invite", () => {
    expect(inviteTokenFromPath("/")).toBeNull();
    expect(inviteTokenFromPath("/login")).toBeNull();
    expect(inviteTokenFromPath("/invite")).toBeNull();
    expect(inviteTokenFromPath("/invite/")).toBeNull();
    // Two segments is not one token with a slash in it.
    expect(inviteTokenFromPath("/invite/a/b")).toBeNull();
    expect(inviteTokenFromPath("/x/invite/abc")).toBeNull();
  });
});
