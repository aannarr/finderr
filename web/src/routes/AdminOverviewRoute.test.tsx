/**
 * `/admin` as a whole page, driven against a stubbed API.
 *
 * The blocks are asserted individually elsewhere -- `ServerHealth.test.tsx` and
 * `SiteDefaults.test.tsx` prove what each DRAWS from props. What only this file can prove is
 * the WIRING, and the wiring is where this page's real risk lives: three loaders, three
 * endpoints, and a save that has to reach `PATCH /api/admin/settings` and then redraw from the
 * server's answer rather than from what was typed. A block pointed at the wrong endpoint
 * renders perfectly and reports somebody else's numbers.
 *
 * The other property, and the reason the page is built this way at all: THE THREE BLOCKS FAIL
 * INDEPENDENTLY. A `/api/health` that 500s must leave the people tiles on screen -- an
 * unreachable Radarr has nothing to do with the user list, and one combined load would take
 * the whole screen down with it.
 *
 * `fetch` is replaced rather than the API modules mocked, so the paths and methods the client
 * actually sends are what is being asserted.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen, waitFor } from "../test/interact";
import { inRouter } from "../test/render-in-router";
import { AdminOverviewRoute } from "./AdminOverviewRoute";

interface Call {
  path: string;
  method: string;
  body: unknown;
}

const realFetch = globalThis.fetch;
let calls: Call[];

/**
 * What each endpoint answers, by path. A path mapped to `null` answers 500.
 *
 * `stateful` gets first refusal on every call and may answer from state it keeps, which is
 * what the save test needs: a fixture cannot tell a reload that happened from one that did not.
 */
function stubFetch(
  answers: Record<string, unknown | null>,
  stateful?: (call: Call) => unknown | undefined,
): void {
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      path: String(input).split("?")[0] ?? "",
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const answer = stateful?.(call) ?? answers[call.path];
    if (answer === undefined || answer === null) {
      return new Response(JSON.stringify({ error: "nope" }), { status: 500 });
    }
    return new Response(JSON.stringify(answer), { status: 200 });
  }) as unknown as typeof fetch;
}

const HEALTH = {
  index: { rows: 42, builtAt: null, reload: null, warm: null },
  library: { radarr: 1, sonarr: 2, episodes: 3 },
  plex: { items: 0, machineId: null },
  services: { radarr: true, sonarr: false, prowlarr: false },
  plugins: { loaded: [{ id: "servarr-metadata", hosts: [] }] },
  facets: { rows: 0, images: 0, pruned: 0 },
  runtime: { uptimeSeconds: 90, rss: 1_000_000, cgroup: null },
  timings: { slow: [] },
};

const ANSWERS: Record<string, unknown> = {
  "/api/admin/users": { users: [] },
  "/api/admin/invites": { invites: [] },
  "/api/admin/requests": { requests: [] },
  "/api/admin/settings": { settings: { requestQuotaPerDay: 5, assistantAllowedByDefault: true } },
  "/api/health": HEALTH,
};

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the whole page", () => {
  test("it loads each block from its own endpoint", async () => {
    stubFetch(ANSWERS);
    render(await routed());

    await waitFor(() => expect(screen.getByText("Site defaults")).toBeDefined());
    await waitFor(() => expect(screen.getByText("Server")).toBeDefined());
    expect(calls.map((c) => c.path).sort()).toEqual([
      "/api/admin/invites",
      "/api/admin/requests",
      "/api/admin/settings",
      "/api/admin/users",
      "/api/health",
    ]);
  });

  /**
   * The reason there are three loads rather than one. Health talks to nothing the people list
   * touches, so its failure is a message in its own block and nothing else.
   */
  test("a failing health call leaves the settings and the tiles on screen", async () => {
    stubFetch({ ...ANSWERS, "/api/health": null });
    render(await routed());

    await waitFor(() => expect(screen.getByText("Site defaults")).toBeDefined());
    expect(screen.getByText("People")).toBeDefined();
    expect(screen.getByText(/the server did not answer/)).toBeDefined();
  });

  test("a failing settings call leaves the server block on screen", async () => {
    stubFetch({ ...ANSWERS, "/api/admin/settings": null });
    render(await routed());

    await waitFor(() => expect(screen.getByText("Server")).toBeDefined());
    expect(screen.queryByText("Site defaults")).toBeNull();
  });

  /**
   * Health answers 200 with `{ok:true}` and no detail to a caller it does not trust, so the
   * ordinary "the response was not ok" check cannot see it. The message has to say what to do.
   */
  test("health answering without its detail says so rather than drawing an empty panel", async () => {
    stubFetch({ ...ANSWERS, "/api/health": { ok: true } });
    render(await routed());

    await waitFor(() => expect(screen.getByText(/still signed in/)).toBeDefined());
  });
});

describe("saving a site default", () => {
  /**
   * The whole round trip: press, PATCH, reload, redraw. The button's own words are what is
   * asserted at the end because they come from PROPS -- so a page that patched and never
   * reloaded goes on offering "Turn off" for a setting that is already off, which is the
   * failure that reads as the click having done nothing.
   */
  test("it PATCHes the settings endpoint, then redraws from what the server now says", async () => {
    let assistant = true;
    stubFetch(ANSWERS, (call) => {
      if (call.path !== "/api/admin/settings") return undefined;
      // A stub that REMEMBERS, so the reload is answered with the new state rather than with
      // the fixture. Against a fixture this test passes without a reload happening at all.
      if (call.method === "PATCH")
        assistant = (call.body as { assistantAllowedByDefault: boolean }).assistantAllowedByDefault;
      return { settings: { requestQuotaPerDay: 5, assistantAllowedByDefault: assistant } };
    });
    render(await routed());

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Turn off for new accounts" })).toBeDefined(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Turn off for new accounts" }));

    await waitFor(() =>
      expect(calls.filter((c) => c.method === "PATCH")).toEqual([
        { path: "/api/admin/settings", method: "PATCH", body: { assistantAllowedByDefault: false } },
      ]),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Turn on for new accounts" })).toBeDefined(),
    );
  });
});

/** The route in a live throwaway router, because its tiles are `<Link>`s and a bare one throws. */
const routed = () => inRouter(<AdminOverviewRoute />, ["/admin/users", "/admin/invites", "/log"]);
