/**
 * The in-browser player control.
 *
 * The property worth the most here is the REFUSAL to draw for a non-admin -- and the test
 * says out loud that it is not the security boundary, because a component that hides itself
 * proves nothing about a route. The server's `requireAdmin` is the wall, pinned in
 * `src/server/playback-routes.test.ts`; this pins that we do not offer a control nobody
 * could use.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen, waitFor } from "../test/interact";
import { PlayHere } from "./PlayHere";

const realFetch = globalThis.fetch;

/**
 * A fetch that answers nothing, installed BETWEEN tests rather than restoring the real one.
 *
 * The component releases its session on unmount, and the preload unmounts between tests --
 * so restoring the real `fetch` in `afterEach` left a genuine request to a relative URL,
 * which resolves to `127.0.0.1:80` and surfaced as an unhandled `ECONNREFUSED` in the
 * suite's output. The suite still passed, which is exactly why it was worth fixing: a test
 * file that emits a connection error on every run trains everybody to ignore one.
 */
const silentFetch = mock(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;

beforeEach(() => {
  globalThis.fetch = silentFetch;
});

afterEach(() => {
  globalThis.fetch = silentFetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

/** A server that starts a session and records what it was asked for. */
function servingSession() {
  const posted: { url: string; body: unknown }[] = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    posted.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(
      JSON.stringify({
        sessionId: "s1",
        playlist: "/api/play/s/s1/index.m3u8",
        durationSec: 100,
        segments: 17,
        plan: {
          video: { action: "copy", sourceIndex: 0, codec: "h264" },
          audio: [
            {
              action: "transcode",
              sourceIndex: 1,
              codec: "aac",
              label: { name: "English", language: "eng" },
            },
          ],
          subtitles: [],
          reasons: [],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return posted;
}

describe("PlayHere draws only for an admin", () => {
  test("a non-admin sees nothing at all", () => {
    const { container } = render(<PlayHere tconst="tt1" isAdmin={false} />);
    expect(container.textContent).toBe("");
  });

  test("an admin gets a play control", () => {
    render(<PlayHere tconst="tt1" isAdmin={true} />);
    expect(screen.getByRole("button", { name: /play here/i })).toBeTruthy();
  });
});

describe("starting a session", () => {
  test("posts the browser's own codec support rather than letting the server guess", async () => {
    const posted = servingSession();
    render(<PlayHere tconst="tt1375666" isAdmin={true} />);

    fireEvent.click(screen.getByRole("button", { name: /play here/i }));
    // The assertion goes INSIDE waitFor, or the wait resolves on the first tick and the
    // test races the fetch it is about to check -- a green line that proves nothing.
    await waitFor(() => expect(posted).toHaveLength(1));

    expect(posted[0]?.url).toContain("/api/play/tt1375666/session");
    const body = posted[0]?.body as { capabilities?: { video: string[]; audio: string[] } };
    expect(body.capabilities).toBeDefined();
    expect(Array.isArray(body.capabilities?.video)).toBe(true);
    expect(Array.isArray(body.capabilities?.audio)).toBe(true);
  });

  test("an episode names its season and number", async () => {
    const posted = servingSession();
    render(<PlayHere tconst="tt4269552" season={6} episode={1} isAdmin={true} />);

    fireEvent.click(screen.getByRole("button", { name: /play here/i }));
    await waitFor(() => expect(posted[0]?.body).toMatchObject({ season: 6, episode: 1 }));
  });

  test("a full server says so in words a person can act on", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ error: "the server is transcoding as much as it can" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    render(<PlayHere tconst="tt1" isAdmin={true} />);
    fireEvent.click(screen.getByRole("button", { name: /play here/i }));
    await waitFor(() => expect(screen.getByText(/try again shortly/i)).toBeTruthy());
    // Still offering the control, because the answer is "later", not "never".
    expect(screen.getByRole("button", { name: /play here/i })).toBeTruthy();
  });

  /**
   * The stats panel is MOUNTED by this toggle rather than hidden by it, which is what stops
   * its two timers -- so what this pins is that the toggle really adds and removes it.
   */
  test("the stats panel is only in the tree while its toggle says so", async () => {
    servingSession();
    render(<PlayHere tconst="tt1" isAdmin={true} />);
    fireEvent.click(screen.getByRole("button", { name: /play here/i }));

    const toggle = await screen.findByRole("button", { name: /stats for nerds/i });
    expect(screen.queryByText(/ready state/i)).toBeNull();

    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByText(/ready state/i)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /hide stats/i }));
    expect(screen.queryByText(/ready state/i)).toBeNull();
  });

  test("a refusal that is not overload shows the server's own message", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ error: "this file cannot be opened" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    render(<PlayHere tconst="tt1" isAdmin={true} />);
    fireEvent.click(screen.getByRole("button", { name: /play here/i }));
    await waitFor(() => expect(screen.getByText(/cannot be opened/i)).toBeTruthy());
  });
});
