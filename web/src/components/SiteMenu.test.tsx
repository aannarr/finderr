/**
 * The narrow-screen menu is the ONLY way a phone reader reaches a section, so what it holds
 * once opened is the whole feature -- a closed trigger that renders fine proves nothing.
 */

import { describe, expect, test } from "bun:test";
import type { PublicUser } from "../lib/auth-api";
import { fireEvent, render, screen } from "../test/interact";
import { inRouter } from "../test/render-in-router";
import { isCurrentSection, SiteMenu } from "./SiteMenu";

const LINKS = [
  { to: "/lists", label: "Lists" },
  { to: "/requests", label: "Requests" },
];
const PATHS = ["/lists", "/requests", "/admin", "/account"];

const user = (role: PublicUser["role"]) => ({ id: "u1", displayName: "Ada", role }) as PublicUser;

async function open(props: { pathname?: string; me?: PublicUser | null; pendingCount?: number }) {
  render(
    await inRouter(
      <SiteMenu
        links={LINKS}
        pathname={props.pathname ?? "/"}
        me={props.me ?? null}
        pendingCount={props.pendingCount ?? 0}
      />,
      PATHS,
    ),
  );
  fireEvent.keyDown(await screen.findByRole("button", { name: "Menu" }), { key: "Enter" });
  return screen.findByRole("menu");
}

describe("SiteMenu", () => {
  test("lists every section, then Admin and the account for an admin", async () => {
    await open({ me: user("admin") });
    const items = screen.getAllByRole("menuitem").map((el) => el.textContent);
    expect(items).toEqual(["Lists", "Requests", "Admin", "AdaAccount"]);
  });

  test("an ordinary user gets no Admin entry", async () => {
    await open({ me: user("user") });
    expect(screen.queryByRole("menuitem", { name: "Admin" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: /Ada/ })).toBeTruthy();
  });

  test("marks the section the reader is in, including below it", async () => {
    await open({ pathname: "/lists/oscars" });
    expect(screen.getByRole("menuitem", { name: "Lists" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("menuitem", { name: "Requests" }).getAttribute("aria-current")).toBeNull();
  });

  test("carries the queued count the bar hides on a narrow screen", async () => {
    await open({ pendingCount: 3 });
    expect(screen.getByRole("menuitem", { name: /Requests/ }).textContent).toContain("3 queued");
  });
});

describe("isCurrentSection", () => {
  test("matches the section and its children, not a sibling sharing a prefix", () => {
    expect(isCurrentSection("/lists", "/lists")).toBe(true);
    expect(isCurrentSection("/lists/x", "/lists")).toBe(true);
    expect(isCurrentSection("/listsx", "/lists")).toBe(false);
  });
});
