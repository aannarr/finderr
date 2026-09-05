/**
 * The people list, as markup.
 *
 * `PeopleList` renders from props alone, so what a row OFFERS can be asserted without a
 * fetch -- and that is the property this file exists for. The page it replaces put four
 * text buttons on every row with the destructive one last and unconfirmed; the guard against
 * that coming back is an assertion that a row contains no button at all.
 */

import { describe, expect, test } from "bun:test";
import type { AdminUser } from "../lib/auth-api";
import { renderInRouter } from "../test/render-in-router";
import { PeopleList } from "./AdminUsersRoute";

const user = (over: Partial<AdminUser> = {}): AdminUser => ({
  id: "u1",
  displayName: "Ada",
  role: "user",
  plexUsername: null,
  plexConnected: false,
  createdAt: "2026-08-01T00:00:00.000Z",
  lastSeenAt: "2026-09-04T00:00:00.000Z",
  disabled: false,
  credentials: 1,
  sessions: 1,
  requestsThisWeek: 3,
  ...over,
});

const render = (users: AdminUser[]) => renderInRouter(<PeopleList users={users} />, ["/admin/users/$id"]);

describe("the people list", () => {
  test("a row is the person, what they may do, when they were here, and how busy", async () => {
    const html = await render([user()]);
    expect(html).toContain("Ada");
    expect(html).toContain("Member");
    expect(html).toContain("last seen");
    expect(html).toContain("3 this week");
  });

  test("the whole row links to that person's page", async () => {
    expect(await render([user()])).toContain('href="/admin/users/u1"');
  });

  /*
    THE REDESIGN'S WHOLE POINT, ASSERTED AS AN ABSENCE.

    "Make admin", "Disable", "Reset access" and "Remove" sat here as four identical-looking
    text buttons, and Remove was one unconfirmed click. They belong on the person's own page,
    together, each with a confirmation. A restyle that reintroduces one to a row would fail
    here rather than in production.
  */
  test("no row carries an action", async () => {
    const html = await render([user({ role: "admin" }), user({ id: "u2", disabled: true })]);
    expect(html).not.toContain("<button");
    for (const verb of ["Make admin", "Demote", "Disable", "Reset access", "Remove"]) {
      expect(html).not.toContain(verb);
    }
  });

  test("a disabled account says so, because that is why they cannot get in", async () => {
    expect(await render([user({ disabled: true })])).toContain("disabled");
  });

  test("an administrator is named as one", async () => {
    expect(await render([user({ role: "admin" })])).toContain("Administrator");
  });

  /** Zero is a fact about a person; a blank cell reads as a column that failed to load. */
  test("nothing this week is drawn as zero rather than omitted", async () => {
    expect(await render([user({ requestsThisWeek: 0 })])).toContain("0 this week");
  });

  test("an empty list says what to do next rather than nothing at all", async () => {
    const html = await render([]);
    expect(html).toContain("Invite somebody");
    expect(html).not.toContain("<li");
  });
});
