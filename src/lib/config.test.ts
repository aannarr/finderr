/**
 * The invite-free Plex sign-in, at the two points where "is it live?" is decided.
 *
 * The feature relaxes the invite-only rule, so the thing worth pinning is not that it
 * works -- `auth-routes.test.ts` owns that -- but that it CANNOT be switched on without a
 * Plex server to check membership against. A flag with no `machineIdentifier` would degrade
 * to "any Plex account on earth may sign in", so both the OFF state and the refusal are
 * asserted here, on the predicate every caller shares.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { ConfigError, loadConfig, plexOpenSignupActive } from "./config";

const OPEN_SIGNUP = "FINDERR_PLEX_OPEN_SIGNUP";
const MACHINE_ID = "FINDERR_PLEX_MACHINE_ID";

/**
 * `loadConfig` caches, and the cache is module-level and shared with every other test in
 * this process -- so each case restores the environment AND forces a reload, or it leaves a
 * config behind that nobody else asked for.
 */
function loadWith(env: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return loadConfig(true);
}

afterEach(() => {
  delete process.env[OPEN_SIGNUP];
  delete process.env[MACHINE_ID];
  loadConfig(true);
});

describe("plexOpenSignupActive", () => {
  test("is false by default -- a checkout of this repo opens no door", () => {
    const cfg = loadConfig();
    expect(cfg.plex.openSignup).toBe(false);
    expect(plexOpenSignupActive(cfg.plex)).toBe(false);
  });

  test("a machine identifier ALONE does not open it -- gate two stays a second filter", () => {
    expect(
      plexOpenSignupActive({ enabled: true, productName: "f", openSignup: false, machineIdentifier: "ours" }),
    ).toBe(false);
  });

  /*
    THE WHOLE RISK OF THE FEATURE, in one assertion. Without a server to belong to,
    `hasServerAccess` has nothing to check, so a true flag would admit anybody who can make
    a Plex account in a minute. It must read false even when asked for.
  */
  test("the flag alone does NOT open it -- there is no server to be a member of", () => {
    expect(plexOpenSignupActive({ enabled: true, productName: "f", openSignup: true })).toBe(false);
  });

  test("both together is the one live combination", () => {
    expect(
      plexOpenSignupActive({ enabled: true, productName: "f", openSignup: true, machineIdentifier: "ours" }),
    ).toBe(true);
  });
});

describe("the boot refuses an open-signup flag that cannot work", () => {
  test("FINDERR_PLEX_OPEN_SIGNUP with no FINDERR_PLEX_MACHINE_ID is a ConfigError", () => {
    expect(() => loadWith({ [OPEN_SIGNUP]: "true", [MACHINE_ID]: undefined })).toThrow(ConfigError);
    // Naming the missing variable is the point: the operator reads this line in the
    // container log and knows which one to set.
    expect(() => loadWith({ [OPEN_SIGNUP]: "true", [MACHINE_ID]: undefined })).toThrow(
      /FINDERR_PLEX_MACHINE_ID/,
    );
  });

  test("with both set it loads, and the feature reads as live", () => {
    const cfg = loadWith({ [OPEN_SIGNUP]: "true", [MACHINE_ID]: "our-server" });
    expect(plexOpenSignupActive(cfg.plex)).toBe(true);
  });

  test("an explicit false with no machine identifier is fine -- that is every install", () => {
    const cfg = loadWith({ [OPEN_SIGNUP]: "false", [MACHINE_ID]: undefined });
    expect(plexOpenSignupActive(cfg.plex)).toBe(false);
  });
});
