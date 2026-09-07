/**
 * `/admin/addons` as a whole page, driven against a stubbed `fetch`.
 *
 * What only this file can prove is the WIRING, which is where the risk lives: the page has to
 * read `GET /api/admin/addons`, send a save to `PATCH /api/admin/addons/<that addon>` carrying
 * only the field that changed, and then REDRAW from the server's answer rather than from what
 * was typed. A form pointed at the wrong addon renders perfectly and configures somebody else.
 *
 * `fetch` is replaced rather than the API module mocked, so the paths and methods the client
 * actually sends are what is asserted. Same idiom, and same reasons, as
 * `AdminOverviewRoute.test.tsx`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AddonConfigReport } from "../lib/auth-api";
import { fireEvent, render, screen, waitFor } from "../test/interact";
import { AdminAddonsRoute } from "./AdminAddonsRoute";

interface Call {
  path: string;
  method: string;
  body: unknown;
}

const realFetch = globalThis.fetch;
let calls: Call[];

/** Answer every call from `answer`, which sees the call and may reply out of its own state. */
function stubFetch(answer: (call: Call) => { status?: number; body: unknown }): void {
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      path: String(input).split("?")[0] ?? "",
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const { status = 200, body } = answer(call);
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

const TMDB: AddonConfigReport = {
  pluginId: "tmdb",
  configured: false,
  fields: [
    {
      key: "apiKey",
      type: "secret",
      label: "API key",
      required: true,
      set: false,
      source: "unset",
    },
  ],
};

const QUIET: AddonConfigReport = { pluginId: "servarr-metadata", configured: true, fields: [] };

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("it lists every installed addon, including one with nothing to configure", async () => {
  stubFetch(() => ({ body: { addons: [TMDB, QUIET] } }));
  render(<AdminAddonsRoute />);

  await waitFor(() => expect(screen.getByText("tmdb")).toBeDefined());
  expect(screen.getByText("servarr-metadata")).toBeDefined();
  expect(screen.getByText(/Nothing to configure/)).toBeDefined();
  expect(calls).toEqual([{ path: "/api/admin/addons", method: "GET", body: undefined }]);
});

/**
 * The round trip: type, PATCH the right addon with the one field, reload, redraw.
 *
 * The stub REMEMBERS, so the reload is answered with the new state rather than with the
 * fixture -- against a fixture this test passes even if the page never reloaded, which is the
 * failure that leaves an operator looking at "Not set" after a save that worked.
 */
test("a save PATCHes that addon alone, then redraws from what the server now says", async () => {
  let stored = false;
  stubFetch((call) => {
    if (call.method === "PATCH") {
      stored = true;
      return { body: { addon: { ...TMDB, configured: true }, restartRequired: true } };
    }
    const apiKey = { ...TMDB.fields[0], set: stored, source: stored ? "store" : "unset" };
    return { body: { addons: [{ ...TMDB, configured: stored, fields: [apiKey] }] } };
  });
  render(<AdminAddonsRoute />);

  await waitFor(() => expect(screen.getByText("waiting on a setting")).toBeDefined());
  fireEvent.change(screen.getByLabelText("API key"), { target: { value: "a-real-tmdb-key" } });
  fireEvent.click(screen.getByRole("button", { name: "Save API key" }));

  await waitFor(() =>
    expect(calls.filter((c) => c.method === "PATCH")).toEqual([
      { path: "/api/admin/addons/tmdb", method: "PATCH", body: { apiKey: "a-real-tmdb-key" } },
    ]),
  );
  // Redrawn from the reload: the badge is gone and the status line says where it now comes
  // from. Both come from the SERVER's answer; nothing here promotes the draft.
  await waitFor(() => expect(screen.getByText("Set on this page.")).toBeDefined());
  expect(screen.queryByText("waiting on a setting")).toBeNull();
  // And the key itself is nowhere -- not in the box it was typed into, and not in the report.
  expect(document.body.innerHTML).not.toContain("a-real-tmdb-key");
});

describe("when the server refuses", () => {
  /**
   * A non-admin gets a 404 from every `/api/admin/*` route -- the admin API does not announce
   * itself, and `asAdmin` in `src/server/auth-routes.ts` owns that. What this page owes is to
   * say so rather than to draw an empty list that reads as "no addons are installed".
   */
  test("a 404 is shown as the server's own words, not as an empty page", async () => {
    stubFetch(() => ({ status: 404, body: { error: "not found" } }));
    render(<AdminAddonsRoute />);

    await waitFor(() => expect(screen.getByText("not found")).toBeDefined());
    expect(screen.queryByText(/No addons are installed/)).toBeNull();
  });

  test("a refused save lands beside the control and leaves the page alone", async () => {
    stubFetch((call) =>
      call.method === "PATCH"
        ? { status: 400, body: { error: "apiKey must be at least 4 characters" } }
        : { body: { addons: [TMDB] } },
    );
    render(<AdminAddonsRoute />);

    await waitFor(() => expect(screen.getByLabelText("API key")).toBeDefined());
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Save API key" }));

    await waitFor(() => expect(screen.getByText("apiKey must be at least 4 characters")).toBeDefined());
    // No reload was attempted: the server is exactly where it was, and a reload here would
    // wipe the refusal on its way to re-drawing the same rows.
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(1);
  });
});
