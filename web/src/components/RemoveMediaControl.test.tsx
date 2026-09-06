/**
 * The destructive control, DRIVEN -- because "renders a button and calls nothing" is the
 * failure this repo has shipped before, and here the button's whole job is to reach an
 * endpoint that deletes files.
 *
 * Two idioms, the same split `RequestsRoute.test.tsx` makes. `react-dom/server` for what the
 * control DRAWS before anybody clicks, which is where the two-click guard lives; the DOM
 * harness for the sequence -- arm, read the facts, choose whether the files go, confirm --
 * because every step of that is state a static render cannot reach.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { MediaRemovalPreview } from "../../../src/lib/media-removal";
import { fireEvent, render, screen } from "../test/interact";
import { RemoveMediaControl } from "./RemoveMediaControl";

const ARRIVED = { tconst: "tt1375666", status: "available" };

const PREVIEW: MediaRemovalPreview = {
  tconst: "tt1375666",
  title: "Inception",
  year: 2010,
  service: "radarr",
  files: 1,
  bytes: 13_000_000_000,
  quality: "Bluray-1080p",
  inPlex: true,
};

const drawn = (over: { status?: string; isAdmin?: boolean } = {}) =>
  renderToStaticMarkup(
    <RemoveMediaControl
      request={{ ...ARRIVED, ...(over.status ? { status: over.status } : {}) }}
      isAdmin={over.isAdmin ?? true}
      onRemoved={() => {}}
    />,
  );

describe("who is offered it, and on what", () => {
  test("an admin looking at something that arrived", () => {
    expect(drawn()).toContain("Remove");
  });

  test("nobody else, and nothing that has not arrived", () => {
    expect(drawn({ isAdmin: false })).toBe("");
    expect(drawn({ status: "downloading" })).toBe("");
    expect(drawn({ status: "removed" })).toBe("");
  });

  /*
    THE GUARD, ASSERTED AS AN ABSENCE. If the confirming button is already in the markup then
    one click deletes a household's file, which is the regression a restyle introduces without
    anybody noticing.
  */
  test("the confirming button and the delete-files choice are not there yet", () => {
    const html = drawn();
    expect(html).not.toContain("Yes, remove it");
    expect(html).not.toContain("Delete the files from disk");
  });
});

describe("arming it, choosing, and confirming", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** Stand in for the network: the preview answers `PREVIEW`, everything else answers 200. */
  function stubFetch(preview: MediaRemovalPreview | null = PREVIEW) {
    const calls: string[] = [];
    globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push(`${method} ${String(url)}`);
      if (method === "GET") {
        return Promise.resolve(
          preview
            ? new Response(JSON.stringify({ preview }), { status: 200 })
            : new Response(JSON.stringify({ error: "radarr does not hold this title" }), { status: 409 }),
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch;
    return calls;
  }

  async function arm(onRemoved: () => void = () => {}): Promise<string[]> {
    const calls = stubFetch();
    render(<RemoveMediaControl request={ARRIVED} isAdmin onRemoved={onRemoved} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    // The facts arrive asynchronously; waiting for them is what makes the rest deterministic.
    await screen.findByText(/Remove .*Inception/);
    return calls;
  }

  /*
    THE DEFECT THIS PINS: a confirmation that says only "are you sure".

    The card's whole argument is that a destructive act against a real filesystem has to state
    what it is about to destroy, and the facts come from the arr rather than from anything
    cached -- so the control has to actually ask.
  */
  test("arming it asks the arr what is on disk, and shows the answer", async () => {
    const calls = await arm();

    expect(calls).toEqual(["GET /api/admin/requests/tt1375666/media"]);
    expect(screen.getByText(/1 file, 13.0 GB, Bluray-1080p/)).toBeDefined();
    expect(screen.getByText("Plex still holds this.")).toBeDefined();
  });

  /*
    DEFAULTS TO KEEPING THE FILES, and the verb says which act it is. A ticked box under a
    button reading "Yes, remove it" would be the confirmation describing the safer of the two
    things it is about to do.
  */
  test("the files stay unless somebody says otherwise, and the verb follows the choice", async () => {
    await arm();

    expect(screen.getByRole("checkbox").hasAttribute("checked")).toBe(false);
    expect(screen.getByRole("button", { name: "Yes, remove it" })).toBeDefined();

    fireEvent.click(screen.getByRole("checkbox"));

    expect(screen.getByRole("button", { name: "Yes, delete the files" })).toBeDefined();
  });

  test("confirming without the box DELETEs with deleteFiles=false and reloads the list", async () => {
    let reloaded = 0;
    const calls = await arm(() => {
      reloaded += 1;
    });

    fireEvent.click(screen.getByRole("button", { name: "Yes, remove it" }));
    await screen.findByRole("button", { name: "Remove" });

    expect(calls).toEqual([
      "GET /api/admin/requests/tt1375666/media",
      "DELETE /api/admin/requests/tt1375666/media?deleteFiles=false",
    ]);
    expect(reloaded).toBe(1);
  });

  test("ticking the box is what puts deleteFiles=true on the wire", async () => {
    const calls = await arm();

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete the files" }));
    await screen.findByRole("button", { name: "Remove" });

    expect(calls[1]).toBe("DELETE /api/admin/requests/tt1375666/media?deleteFiles=true");
  });

  /*
    The arr lookup is a COURTESY. An operator who has already decided to remove something must
    not be locked out of doing it because a metadata call failed -- so the failure is stated
    and the Yes button stays.
  */
  test("a preview that fails says so and still lets the removal through", async () => {
    const calls = stubFetch(null);
    render(<RemoveMediaControl request={ARRIVED} isAdmin onRemoved={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    expect(await screen.findByText(/Could not read what is on disk/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Yes, remove it" }));
    await screen.findByRole("button", { name: "Remove" });

    expect(calls[1]).toBe("DELETE /api/admin/requests/tt1375666/media?deleteFiles=false");
  });

  test("a refused removal is shown and the list is not reloaded", async () => {
    let reloaded = 0;
    await arm(() => {
      reloaded += 1;
    });
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ error: "radarr is having trouble" }), { status: 502 })),
    ) as unknown as typeof fetch;

    fireEvent.click(screen.getByRole("button", { name: "Yes, remove it" }));

    expect(await screen.findByText("radarr is having trouble")).toBeDefined();
    expect(reloaded).toBe(0);
  });
});
