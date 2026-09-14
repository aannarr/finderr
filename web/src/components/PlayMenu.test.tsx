/**
 * The split play button.
 *
 * Two things are worth pinning. WHO SEES WHAT is the rule a later edit is most likely to get
 * wrong -- a "Play here" leaking to a non-admin is a control that 404s -- so `playOptions` is
 * asserted for every reader shape. And the menu item has to actually START playback: a menu
 * that opens and closes and does nothing looks exactly like a working one in static markup.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Title } from "../lib/api";
import { fireEvent, render, screen, waitFor } from "../test/interact";
import { makeTitle } from "../test/title-fixture";
import { usePlayHere } from "./PlayHere";
import { PlayMenu, playOptions } from "./PlayMenu";

/** The route owns the player; this stands in for it, with the one hook the page would hold. */
function RoutedPlayMenu({ title }: { title: Title }) {
  const control = usePlayHere({ tconst: title.tconst, title: title.title });
  return (
    <>
      <PlayMenu title={title} isAdmin arrLink={null} control={control} />
      {control.player}
    </>
  );
}

const PLEX = { web: "https://app.plex.tv/desktop#!/x", app: "plex://x" };
const RADARR = { service: "radarr" as const, label: "Radarr", url: "http://radarr.example/movie/1" };

const kinds = (...args: Parameters<typeof playOptions>) => playOptions(...args).map((o) => o.kind);

describe("which ways to play each reader is offered", () => {
  test("a non-admin with Plex gets the app link and nothing that needs a role", () => {
    expect(kinds(makeTitle({ hasFile: true, plex: PLEX }), false, RADARR)).toEqual(["plex-app"]);
  });

  test("an admin with Plex and a file gets Play here, the app, then the arr", () => {
    expect(kinds(makeTitle({ hasFile: true, plex: PLEX }), true, RADARR)).toEqual([
      "here",
      "plex-app",
      "arr",
    ]);
  });

  test("with no Plex, Play here is the default half, so it is not repeated in the menu", () => {
    expect(kinds(makeTitle({ hasFile: true }), true, RADARR)).toEqual(["arr"]);
  });

  test("an admin without a file cannot be offered Play here", () => {
    expect(kinds(makeTitle({ plex: PLEX }), true, null)).toEqual(["plex-app"]);
  });

  test("nothing to play means nothing offered, even with an arr link", () => {
    expect(kinds(makeTitle(), true, RADARR)).toEqual([]);
  });
});

const realFetch = globalThis.fetch;
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

describe("Play here, from the menu", () => {
  test("asks the server for a session for this title", async () => {
    const posted: string[] = [];
    // A refusal, so the test proves the request was made without loading hls.js.
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      posted.push(String(input));
      return new Response(JSON.stringify({ error: "this file cannot be opened" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    render(<RoutedPlayMenu title={makeTitle({ tconst: "tt1375666", hasFile: true, plex: PLEX })} />);
    expect(screen.getByRole("link", { name: "Play on Plex" })).toBeTruthy();

    fireEvent.keyDown(screen.getByRole("button", { name: /more ways to play/i }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: /play here/i }));

    await waitFor(() => expect(posted.some((u) => u.includes("/api/play/tt1375666/session"))).toBe(true));
    await waitFor(() => expect(screen.getByText(/cannot be opened/i)).toBeTruthy());
  });
});
