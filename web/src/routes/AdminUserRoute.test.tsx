/**
 * One person's page, as markup.
 *
 * `AdminUserView` takes the whole payload as a prop, so every block can be asserted from a
 * plain object -- including the states that are hard to provoke against a live server: a
 * passkey that is not backed up, an account with no way in at all, and a quota that does not
 * apply.
 */

import { describe, expect, test } from "bun:test";
import type { AdminUserDetail } from "../lib/auth-api";
import { renderInRouter } from "../test/render-in-router";
import { AdminUserView } from "./AdminUserRoute";

const detail = (over: Partial<AdminUserDetail> = {}): AdminUserDetail => ({
  user: {
    id: "u1",
    displayName: "Ada",
    role: "user",
    plexUsername: null,
    plexConnected: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    lastSeenAt: "2026-09-04T00:00:00.000Z",
    disabled: false,
  },
  credentials: [
    {
      id: "c1",
      label: "Ada iPhone",
      deviceType: "singleDevice",
      backedUp: true,
      createdAt: "2026-08-01T00:00:00.000Z",
      lastUsedAt: "2026-09-04T00:00:00.000Z",
    },
  ],
  sessions: [
    {
      id: "s1",
      createdAt: "2026-09-01T00:00:00.000Z",
      lastSeenAt: "2026-09-04T00:00:00.000Z",
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Mobile",
      current: false,
    },
  ],
  requests: [
    {
      id: 1,
      tconst: "tt0111161",
      title: "The Shawshank Redemption",
      year: 1994,
      status: "queued",
      seasons: null,
      created_at: "2026-09-03T00:00:00.000Z",
      updated_at: "2026-09-03T00:00:00.000Z",
      requested_by: "u1",
      requestedByName: "Ada",
    },
  ],
  quota: { limitPerDay: 0, usedToday: 1, resetsAt: "2026-09-06T00:00:00.000Z", applies: false },
  agentKey: null,
  ...over,
});

const render = (over: Partial<AdminUserDetail> = {}) =>
  renderInRouter(<AdminUserView detail={detail(over)} />, ["/title/$tconst"]);

describe("identity", () => {
  test("the name, what they may do, and both stamps", async () => {
    const html = await render();
    expect(html).toContain("Ada");
    expect(html).toContain("Member");
    expect(html).toContain("joined");
    expect(html).toContain("last seen");
  });

  test("a disabled account announces it beside the name", async () => {
    expect(await render({ user: { ...detail().user, disabled: true } })).toContain("disabled");
  });

  /**
   * Plex is a way IN, not only a way to watch. An account whose passkeys are all gone but
   * whose Plex link is live is not locked out, and an operator about to reset them needs to
   * know that BEFORE pressing anything.
   */
  test("a Plex link is stated either way, named when there is one", async () => {
    expect(await render()).toContain("No Plex account connected");
    const linked = await render({
      user: { ...detail().user, plexConnected: true, plexUsername: "ada" },
    });
    expect(linked).toContain("Plex connected as ada");
  });
});

describe("access", () => {
  test("every passkey by its name, with when it was added and last used", async () => {
    const html = await render();
    expect(html).toContain("Ada iPhone");
    expect(html).toContain("last used");
  });

  /*
    A passkey that is NOT backed up dies with its device, which is what turns "they have two
    passkeys" into "they have one that survives a lost phone". Said only when it is true, so
    the ordinary case stays quiet -- both halves of that are asserted here.
  */
  test("a passkey that will not survive its device says so, and a backed-up one does not", async () => {
    expect(await render()).not.toContain("this device only");
    const fragile = await render({
      credentials: [{ ...detail().credentials[0], backedUp: false }],
    });
    expect(fragile).toContain("this device only");
  });

  test("a session is named by its device rather than by its user agent", async () => {
    const html = await render();
    expect(html).toContain("phone");
    expect(html).not.toContain("Mozilla/5.0");
  });

  /** True only where an admin is reading their OWN page, and the server decides which. */
  test("'this device' is drawn only for the session holding the cookie", async () => {
    expect(await render()).not.toContain("this device<");
    const mine = await render({ sessions: [{ ...detail().sessions[0], current: true }] });
    expect(mine).toContain("this device");
  });

  test("an account with no passkey and no session says so rather than showing blanks", async () => {
    const html = await render({ credentials: [], sessions: [] });
    expect(html).toContain("No passkeys");
    expect(html).toContain("No open sessions");
  });
});

describe("activity", () => {
  test("a request is the title, the year and the way back to it", async () => {
    const html = await render();
    expect(html).toContain("The Shawshank Redemption");
    expect(html).toContain("1994");
    expect(html).toContain('href="/title/tt0111161"');
  });

  test("nothing requested is a sentence, not an empty list", async () => {
    expect(await render({ requests: [] })).toContain("not asked for anything");
  });

  /*
    THE QUOTA SENTENCE READS THE SERVER'S ANSWER.

    `applies` is the request rule's to decide -- an admin is exempt, and a limit of zero is
    unlimited. This page must never work that out from `limitPerDay` and a role, or it would
    be free to disagree with the endpoint that actually refuses a request.
  */
  test("says the limit does not apply when the server says so, whatever the number is", async () => {
    const html = await render({
      quota: { limitPerDay: 10, usedToday: 4, resetsAt: "2026-09-06T00:00:00.000Z", applies: false },
    });
    expect(html).toContain("4 titles today");
    expect(html).toContain("No daily limit applies");
  });

  test("and names the allowance when it does", async () => {
    const html = await render({
      quota: { limitPerDay: 10, usedToday: 4, resetsAt: "2026-09-06T00:00:00.000Z", applies: true },
    });
    expect(html).toContain("of 10 allowed");
  });

  test("one title today is not '1 titles'", async () => {
    const html = await render();
    expect(html).toContain("1 title today");
    expect(html).not.toContain("1 titles");
  });
});

describe("the agent key", () => {
  test("absent says nothing is acting for them", async () => {
    expect(await render()).toContain("No agent key");
  });

  test("present says which kind, and never carries a credential", async () => {
    const html = await render({
      agentKey: { createdAt: "2026-09-01T00:00:00.000Z", lastUsedAt: null, readOnly: true },
    });
    expect(html).toContain("read-only key exists");
  });
});

/*
  THE READ-ONLY PROMISE, ASSERTED AS AN ABSENCE.

  Promote, disable, reset, remove, and revoking one passkey or one session all land together
  on the follow-up card so that every one of them gets its confirmation at once. One of them
  arriving early -- an unconfirmed Remove beside a list of devices -- is exactly the failure
  this redesign exists to remove, so it fails here first.
*/
describe("nothing on this page acts", () => {
  test("there is no button anywhere, in any state", async () => {
    const html = await render({
      user: { ...detail().user, role: "admin", disabled: true },
      agentKey: { createdAt: "2026-09-01T00:00:00.000Z", lastUsedAt: null, readOnly: false },
    });
    expect(html).not.toContain("<button");
    for (const verb of ["Demote", "Make admin", "Disable", "Enable", "Reset access", "Remove", "Revoke"]) {
      expect(html).not.toContain(verb);
    }
  });
});
