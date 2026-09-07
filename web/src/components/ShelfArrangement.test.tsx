/**
 * The arranging screen, driven rather than drawn.
 *
 * The behaviour idiom (`web/src/test/interact.ts`), because every assertion here is about the
 * SECOND render: a row that moved, a Save that appeared because something changed, and -- the
 * one that would otherwise ship broken -- the screen adopting the SERVER's answer rather than
 * the list it just sent. A static render proves none of them; the resting state is a list of
 * shelf names and it is correct in the broken version too.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ShelfPreferencePayload } from "../lib/api";
import { fireEvent, render, screen, waitFor } from "../test/interact";
import { ShelfArrangement } from "./ShelfArrangement";

const DEFAULT_PAGE: ShelfPreferencePayload = {
  customised: false,
  shelves: [
    { id: "trending", title: "Trending", hidden: false },
    { id: "newest", title: "Newest", hidden: false },
    { id: "horror", title: "Horror", hidden: false },
  ],
};

interface Wire {
  /** Every call made, as `METHOD /path`, in order. */
  calls: string[];
  /** The bodies of the writes, so a save can be asserted on what it actually sent. */
  bodies: unknown[];
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * Stand in for the network. `answers` is consumed in order, so a test can make the server
 * resolve a save into something other than what was sent.
 */
function stubFetch(...answers: (ShelfPreferencePayload | { status: number; error: string })[]): Wire {
  const wire: Wire = { calls: [], bodies: [] };
  const queue = [...answers];
  globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
    wire.calls.push(`${init?.method ?? "GET"} ${String(url)}`);
    if (typeof init?.body === "string") wire.bodies.push(JSON.parse(init.body));
    const answer = queue.length > 1 ? queue.shift() : queue[0];
    if (answer && "status" in answer) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: answer.error }), { status: answer.status }),
      );
    }
    return Promise.resolve(new Response(JSON.stringify(answer), { status: 200 }));
  }) as unknown as typeof fetch;
  return wire;
}

const press = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

/** Render and wait for the first load to land, so every later assertion is deterministic. */
async function open(...answers: Parameters<typeof stubFetch>): Promise<Wire> {
  const wire = stubFetch(...answers);
  render(<ShelfArrangement />);
  await screen.findByText("Trending");
  return wire;
}

/** The shelf names in the order they are drawn. */
const drawnOrder = () =>
  screen
    .getAllByRole("listitem")
    .map((li) => li.textContent?.replace(/[↑↓]|Hide|Show| · hidden/g, "").trim());

describe("loading", () => {
  test("it reads the catalogue on mount and draws it in the server's order", async () => {
    const wire = await open(DEFAULT_PAGE);

    expect(wire.calls).toEqual(["GET /api/shelves/preference"]);
    expect(drawnOrder()).toEqual(["Trending", "Newest", "Horror"]);
  });

  /*
    THE REFUSAL. `/api/shelves/preference` is behind the session, so a signed-out reader gets
    the server's own sentence -- which is actionable where "401" is not.
  */
  test("a refusal is shown in the server's own words", async () => {
    stubFetch({ status: 401, error: "sign in to arrange your front page" });
    render(<ShelfArrangement />);

    await screen.findByText("sign in to arrange your front page");
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  test("nothing is offered to save on a page nobody has touched", async () => {
    await open(DEFAULT_PAGE);

    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset to the default order" })).toBeNull();
  });
});

describe("arranging", () => {
  test("moving a shelf up swaps it with the one above, without saving anything", async () => {
    const wire = await open(DEFAULT_PAGE);

    press("Move Newest up");

    expect(drawnOrder()).toEqual(["Newest", "Trending", "Horror"]);
    expect(wire.calls).toEqual(["GET /api/shelves/preference"]);
  });

  test("moving one down does the mirror of it", async () => {
    await open(DEFAULT_PAGE);

    press("Move Newest down");

    expect(drawnOrder()).toEqual(["Trending", "Horror", "Newest"]);
  });

  /*
    THE ARROWS AT THE ENDS STAY PRESSABLE. A `disabled` button leaves the tab order the moment
    it becomes disabled, so a keyboard reader who moved a shelf to the top would find focus
    back on `<body>`, mid-task. It is `aria-disabled` and a no-op instead.
  */
  test("an arrow with nowhere to go is announced rather than removed, and changes nothing", async () => {
    await open(DEFAULT_PAGE);
    const up = screen.getByRole("button", { name: "Move Trending up" });

    expect(up.getAttribute("aria-disabled")).toBe("true");
    expect(up.hasAttribute("disabled")).toBe(false);

    fireEvent.click(up);

    expect(drawnOrder()).toEqual(["Trending", "Newest", "Horror"]);
    expect(screen.getByText("Trending is already first")).toBeDefined();
  });

  test("hiding a shelf marks it in place and offers to show it again", async () => {
    await open(DEFAULT_PAGE);

    press("Hide Newest");

    expect(drawnOrder()).toEqual(["Trending", "Newest", "Horror"]);
    expect(screen.getByRole("button", { name: "Show Newest" })).toBeDefined();
  });

  test("a change is what makes Save appear", async () => {
    await open(DEFAULT_PAGE);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();

    press("Hide Newest");

    expect(screen.getByRole("button", { name: "Save" })).toBeDefined();
  });

  /** Undoing an edit by hand leaves nothing to save -- the draft matches the server again. */
  test("Save goes away when the reader puts the page back themselves", async () => {
    await open(DEFAULT_PAGE);

    press("Hide Newest");
    press("Show Newest");

    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });
});

describe("saving", () => {
  const CUSTOMISED: ShelfPreferencePayload = {
    customised: true,
    shelves: [
      { id: "newest", title: "Newest", hidden: false },
      { id: "trending", title: "Trending", hidden: true },
      { id: "horror", title: "Horror", hidden: false },
    ],
  };

  test("it PUTs the whole page, in the drawn order, with the hidden flags", async () => {
    const wire = await open(DEFAULT_PAGE, CUSTOMISED);

    press("Move Newest up");
    press("Hide Trending");
    press("Save");
    await waitFor(() => expect(wire.calls).toHaveLength(2));

    expect(wire.calls[1]).toBe("PUT /api/shelves/preference");
    expect(wire.bodies[0]).toEqual({
      shelves: [
        { id: "newest", hidden: false },
        { id: "trending", hidden: true },
        { id: "horror", hidden: false },
      ],
    });
  });

  /*
    THE ONE THAT WOULD OTHERWISE SHIP BROKEN. A save answers with the catalogue the server
    RESOLVED, which is not always the list that was sent: a genre row can retire with the
    nightly index build while this screen is open, and a release can add one. A screen that
    kept drawing its own draft would be claiming to have stored something it had not.
  */
  test("the server's answer replaces the draft, dropped shelves and all", async () => {
    const resolved: ShelfPreferencePayload = {
      customised: true,
      shelves: [
        { id: "newest", title: "Newest", hidden: false },
        { id: "comedy", title: "Comedy", hidden: false },
      ],
    };
    await open(DEFAULT_PAGE, resolved);

    press("Move Newest up");
    press("Save");

    await waitFor(() => expect(drawnOrder()).toEqual(["Newest", "Comedy"]));
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  test("a refused save leaves the draft alone and says why", async () => {
    await open(DEFAULT_PAGE, { status: 400, error: "horror is listed twice" });

    press("Move Newest up");
    press("Save");

    await screen.findByText("horror is listed twice");
    expect(drawnOrder()).toEqual(["Newest", "Trending", "Horror"]);
    expect(screen.getByRole("button", { name: "Save" })).toBeDefined();
  });
});

describe("resetting", () => {
  const CUSTOMISED: ShelfPreferencePayload = {
    customised: true,
    shelves: [
      { id: "newest", title: "Newest", hidden: false },
      { id: "trending", title: "Trending", hidden: false },
      { id: "horror", title: "Horror", hidden: false },
    ],
  };

  test("a reader who has arranged their page is offered the way back", async () => {
    stubFetch(CUSTOMISED);
    render(<ShelfArrangement />);
    await screen.findByText("Trending");

    expect(screen.getByRole("button", { name: "Reset to the default order" })).toBeDefined();
  });

  test("it asks first, then DELETEs, and draws what comes back", async () => {
    const wire = stubFetch(CUSTOMISED, DEFAULT_PAGE);
    render(<ShelfArrangement />);
    await screen.findByText("Trending");

    press("Reset to the default order");
    press("Yes, reset");

    await waitFor(() => expect(drawnOrder()).toEqual(["Trending", "Newest", "Horror"]));
    expect(wire.calls[1]).toBe("DELETE /api/shelves/preference");
    expect(screen.queryByRole("button", { name: "Reset to the default order" })).toBeNull();
  });

  /*
    Unsaved edits are something to put back too. Without this the escape hatch is missing from
    exactly the state a reader is most likely to want it: halfway through arranging, having
    changed their mind, on a page they have never saved.
  */
  test("it is offered for unsaved edits as well as for a stored arrangement", async () => {
    await open(DEFAULT_PAGE);
    expect(screen.queryByRole("button", { name: "Reset to the default order" })).toBeNull();

    press("Hide Newest");

    expect(screen.getByRole("button", { name: "Reset to the default order" })).toBeDefined();
  });
});

/*
  A shelf id this client has never heard of is ORDINARY, not an error: the genre rows rotate
  with the nightly index build, so the catalogue is whatever the server says it is today. The
  screen may not carry a list of known shelves to check against, and nothing here may throw.
*/
test("a catalogue of shelves the client has never seen draws and round-trips", async () => {
  const strange: ShelfPreferencePayload = {
    customised: false,
    shelves: [
      { id: "genre-solarpunk", title: "Solarpunk", hidden: false },
      { id: "trending", title: "Trending", hidden: false },
    ],
  };
  const wire = stubFetch(strange);
  render(<ShelfArrangement />);
  await screen.findByText("Solarpunk");

  press("Move Trending up");
  press("Save");

  await waitFor(() => expect(wire.bodies).toHaveLength(1));
  expect(wire.bodies[0]).toEqual({
    shelves: [
      { id: "trending", hidden: false },
      { id: "genre-solarpunk", hidden: false },
    ],
  });
});
