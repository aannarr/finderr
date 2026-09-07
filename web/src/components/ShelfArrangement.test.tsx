/**
 * The arranging screen, driven rather than drawn.
 *
 * The behaviour idiom (`web/src/test/interact.ts`), because every assertion here is about the
 * SECOND render: a row that moved, a write that happened without anybody pressing Save, and --
 * the one that would otherwise ship broken -- the screen adopting the SERVER's answer rather
 * than the list it just sent. A static render proves none of them; the resting state is a list
 * of shelf names and it is correct in the broken version too.
 *
 * > [!IMPORTANT] `writes()` waits past the debounce, and that is the point of the wait
 * > Every edit is committed on the press and collapsed behind `SHELF_SAVE_DEBOUNCE_MS`, so a
 * > test that asserts on `wire.calls` synchronously after a click sees ONE call -- the initial
 * > GET -- and passes against a screen that never saves anything, which is the exact bug this
 * > file now exists to catch. Assert through `writes()`.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ShelfPreferencePayload } from "../lib/api";
import { act, fireEvent, render, screen, waitFor } from "../test/interact";
import { SHELF_SAVE_DEBOUNCE_MS, ShelfArrangement } from "./ShelfArrangement";

/** Comfortably past the debounce, so a wait that times out means nothing was ever sent. */
const SETTLE_MS = SHELF_SAVE_DEBOUNCE_MS * 3;

const DEFAULT_PAGE: ShelfPreferencePayload = {
  customised: false,
  shelves: [
    { id: "trending", title: "Trending", hidden: false },
    { id: "newest", title: "Newest", hidden: false },
    { id: "horror", title: "Horror", hidden: false },
  ],
};

/** What the server holds once something has been arranged. Answers every write by default. */
const CUSTOMISED: ShelfPreferencePayload = {
  customised: true,
  shelves: [
    { id: "trending", title: "Trending", hidden: false },
    { id: "newest", title: "Newest", hidden: true },
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
 * resolve a save into something other than what was sent; the last answer repeats.
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

/** The writes that have actually gone out, once the debounce has had time to fire. */
async function writes(wire: Wire, n: number): Promise<unknown[]> {
  await waitFor(() => expect(wire.bodies).toHaveLength(n), { timeout: SETTLE_MS });
  return wire.bodies;
}

/** Let the debounce window pass with nothing else happening. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, SETTLE_MS));
  });
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

  /*
    THERE IS NO SAVE BUTTON, ANYWHERE, EVER. It is asserted rather than merely absent from the
    other tests, because the whole reported bug was a Save button that existed and could not be
    seen -- and the honest fix is that there is nothing left to miss.
  */
  test("nothing has to be pressed to commit, so no Save is drawn", async () => {
    const wire = await open(DEFAULT_PAGE, CUSTOMISED);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();

    press("Hide Newest");

    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    await writes(wire, 1);
  });

  test("a page nobody has arranged is offered no reset", async () => {
    await open(DEFAULT_PAGE);

    expect(screen.queryByRole("button", { name: "Reset to the default order" })).toBeNull();
  });
});

describe("arranging", () => {
  test("moving a shelf up swaps it with the one above", async () => {
    const wire = await open(DEFAULT_PAGE, CUSTOMISED);

    press("Move Newest up");

    expect(drawnOrder()).toEqual(["Newest", "Trending", "Horror"]);
    await writes(wire, 1);
  });

  test("moving one down does the mirror of it", async () => {
    const wire = await open(DEFAULT_PAGE, CUSTOMISED);

    press("Move Newest down");

    expect(drawnOrder()).toEqual(["Trending", "Horror", "Newest"]);
    await writes(wire, 1);
  });

  /*
    THE ARROWS AT THE ENDS STAY PRESSABLE. A `disabled` button leaves the tab order the moment
    it becomes disabled, so a keyboard reader who moved a shelf to the top would find focus
    back on `<body>`, mid-task. It is `aria-disabled` and a no-op instead -- and, since every
    real press now writes, a press that moves nothing must NOT.
  */
  test("an arrow with nowhere to go is announced, changes nothing, and writes nothing", async () => {
    const wire = await open(DEFAULT_PAGE, CUSTOMISED);
    const up = screen.getByRole("button", { name: "Move Trending up" });

    expect(up.getAttribute("aria-disabled")).toBe("true");
    expect(up.hasAttribute("disabled")).toBe(false);

    fireEvent.click(up);
    await settle();

    expect(drawnOrder()).toEqual(["Trending", "Newest", "Horror"]);
    expect(screen.getByText("Trending is already first")).toBeDefined();
    expect(wire.bodies).toHaveLength(0);
  });

  test("hiding a shelf marks it in place and offers to show it again", async () => {
    const wire = await open(DEFAULT_PAGE, CUSTOMISED);

    press("Hide Newest");

    expect(drawnOrder()).toEqual(["Trending", "Newest", "Horror"]);
    expect(screen.getByRole("button", { name: "Show Newest" })).toBeDefined();
    await writes(wire, 1);
  });
});

describe("committing on the press", () => {
  /*
    THE REGRESSION TEST FOR THE REPORTED BUG, and it is the reason this file changed shape.

    Measured in a browser on 2026-09-07: pressing Hide on a shelf partway down the list made a
    Save button appear at `top: -217px` -- above the fold, on a page the reader had scrolled
    down. Nothing said "unsaved". Navigating away discarded it. `shelf_pref` held ZERO rows on
    both live deployments with the feature shipped and the API working perfectly.

    So the assertion is exactly the thing that was false: ONE press, no second press, and the
    server has been told.
  */
  test("hiding a shelf reaches the server with nothing else pressed", async () => {
    const wire = await open(DEFAULT_PAGE, CUSTOMISED);

    press("Hide Newest");

    const [body] = await writes(wire, 1);
    expect(wire.calls[1]).toBe("PUT /api/shelves/preference");
    expect(body).toEqual({
      shelves: [
        { id: "trending", hidden: false },
        { id: "newest", hidden: true },
        { id: "horror", hidden: false },
      ],
    });
  });

  test("moving a shelf reaches the server too", async () => {
    const wire = await open(DEFAULT_PAGE, CUSTOMISED);

    press("Move Newest up");

    expect(await writes(wire, 1)).toEqual([
      {
        shelves: [
          { id: "newest", hidden: false },
          { id: "trending", hidden: false },
          { id: "horror", hidden: false },
        ],
      },
    ]);
  });

  /*
    A run of presses is ONE write carrying the final list. Walking a shelf from the bottom of a
    sixteen-row page to the top is fifteen presses, and fifteen round trips for one intention is
    the reason the commit is debounced rather than fired per click.
  */
  test("a run of presses collapses into one write, and it carries the last list", async () => {
    const wire = await open(DEFAULT_PAGE, CUSTOMISED);

    press("Move Horror up");
    press("Move Horror up");
    press("Hide Trending");
    await settle();

    expect(wire.bodies).toEqual([
      {
        shelves: [
          { id: "horror", hidden: false },
          { id: "trending", hidden: true },
          { id: "newest", hidden: false },
        ],
      },
    ]);
  });

  /*
    AN EDIT THAT UNDOES ITSELF WRITES NOTHING. Without this, hiding a shelf and showing it again
    would store a preference identical to the shipped page -- which then reports `customised`
    and offers a reset for an arrangement nobody made.
  */
  test("putting the page back the way the server holds it sends nothing", async () => {
    const wire = await open(DEFAULT_PAGE, CUSTOMISED);

    press("Hide Newest");
    press("Show Newest");
    await settle();

    expect(wire.bodies).toHaveLength(0);
    expect(wire.calls).toEqual(["GET /api/shelves/preference"]);
  });

  /*
    NAVIGATING AWAY MUST NOT EAT THE EDIT. `debouncer.cancel()` on unmount is right for the
    search box, where a pending emit is a request nobody can see the answer to; here the pending
    value IS the reader's change, and cancelling it is the original bug wearing a new hat.
  */
  test("unmounting flushes a pending write instead of dropping it", async () => {
    const wire = stubFetch(DEFAULT_PAGE, CUSTOMISED);
    const { unmount } = render(<ShelfArrangement />);
    await screen.findByText("Trending");

    press("Hide Newest");
    // Well inside the debounce window: nothing has been sent yet, and the reader is leaving.
    expect(wire.bodies).toHaveLength(0);
    unmount();

    await waitFor(() => expect(wire.bodies).toHaveLength(1), { timeout: SETTLE_MS });
    expect(wire.bodies[0]).toEqual({
      shelves: [
        { id: "trending", hidden: false },
        { id: "newest", hidden: true },
        { id: "horror", hidden: false },
      ],
    });
  });
});

describe("what the server says back", () => {
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

    await waitFor(() => expect(drawnOrder()).toEqual(["Newest", "Comedy"]), { timeout: SETTLE_MS });
  });

  test("a refused save leaves the list alone and says why", async () => {
    await open(DEFAULT_PAGE, { status: 400, error: "horror is listed twice" });

    press("Move Newest up");

    await screen.findByText("horror is listed twice", {}, { timeout: SETTLE_MS });
    expect(drawnOrder()).toEqual(["Newest", "Trending", "Horror"]);
  });

  test("it says it is saving, and then that it saved", async () => {
    await open(DEFAULT_PAGE, CUSTOMISED);

    press("Hide Newest");
    expect(screen.getByText("Saving…")).toBeDefined();

    await screen.findByText("Saved", {}, { timeout: SETTLE_MS });
  });
});

describe("resetting", () => {
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
    A RESET CANCELS A PENDING WRITE. Without that, an arrangement queued a moment before the
    reset lands after it and re-creates the preference the reader just asked to be rid of --
    which is worse than not offering a reset at all, because the screen would report success.
  */
  test("an edit still inside the debounce is dropped by a reset rather than landing after it", async () => {
    const wire = stubFetch(CUSTOMISED, DEFAULT_PAGE);
    render(<ShelfArrangement />);
    await screen.findByText("Trending");

    press("Move Horror up");
    press("Reset to the default order");
    press("Yes, reset");
    await settle();

    expect(wire.calls.filter((c) => c.startsWith("PUT"))).toEqual([]);
    expect(wire.calls.filter((c) => c.startsWith("DELETE"))).toHaveLength(1);
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

  expect(await writes(wire, 1)).toEqual([
    {
      shelves: [
        { id: "trending", hidden: false },
        { id: "genre-solarpunk", hidden: false },
      ],
    },
  ]);
});
