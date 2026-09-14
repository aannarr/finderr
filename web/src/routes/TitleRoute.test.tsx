/**
 * The title page's ONE primary slot, and which control wins it.
 *
 * `PrimaryAction` is the only part of this route that renders from props alone -- the rest is
 * a fetch, a router and a dialog -- and it is where the whole hierarchy decision lives, so it
 * is the piece worth pinning. Static markup: every assertion here is about what is DRAWN, and
 * the behaviour of the controls themselves is pinned in their own files.
 *
 * WHAT THIS DEFENDS: an owned title used to spend this slot on a muted "Available in your
 * library" span -- a fact, with no action -- while "Play here" sat underneath it in grey. The
 * ladder below is the fix, and its ORDER is the thing a later edit is most likely to get
 * wrong, so each rung is asserted from both sides.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { KeyAction } from "../components/Kbd";
import { requestStatePatch, type Title } from "../lib/api";
import { makeTitle } from "../test/title-fixture";
import { PrimaryAction } from "./TitleRoute";

const PLEX = { web: "https://app.plex.tv/#!/x", app: "plex://x" };

/** No shortcut bound, which is what a title already in the library gets. */
const NO_KEY: KeyAction = { props: {}, hint: null };

const render = (title: Title, isAdmin: boolean, choosable = false) =>
  renderToStaticMarkup(
    <PrimaryAction
      title={title}
      isAdmin={isAdmin}
      choosable={choosable}
      onRequest={() => {}}
      requestKey={NO_KEY}
      arrLink={null}
    />,
  );

describe("a title we hold the file for", () => {
  test("an admin is offered PLAY, and is not told what they can already see", () => {
    const html = render(makeTitle({ inLibrary: true, hasFile: true }), true);
    expect(html).toContain("Play here");
    expect(html).not.toContain("Available in your library");
  });

  /**
   * The regression this slot is most likely to grow: `PlayHere` draws nothing for a
   * non-admin, so a branch that checked `hasFile` alone would leave the slot EMPTY for
   * everybody who is not one.
   */
  test("a non-admin still gets something, rather than an empty slot", () => {
    const html = render(makeTitle({ inLibrary: true, hasFile: true }), false);
    expect(html).toContain("Available in your library");
    expect(html).not.toContain("Play here");
  });

  /**
   * aannarr, 2026-09-14: Plex is the default half of the split button, and "Play here" waits in
   * its menu. The menu is closed at rest, so the item is not in the markup -- `PlayMenu.test`
   * pins that it is offered.
   */
  test("Plex is the default even for an admin who could play it here", () => {
    const html = render(makeTitle({ inLibrary: true, hasFile: true, plex: PLEX }), true);
    expect(html).toContain("Play on Plex");
    expect(html).toContain("More ways to play");
  });

  test("a non-admin whose Plex holds it is sent there instead of to a dead end", () => {
    const html = render(makeTitle({ inLibrary: true, hasFile: true, plex: PLEX }), false);
    expect(html).toContain("Play on Plex");
    expect(html).not.toContain("Available in your library");
  });

  /**
   * `hasFile` and `title.plex` are different signals on purpose: Plex can hold a scanned item
   * the arr never imported. An admin with no file has nothing to stream, so Plex takes the
   * slot for them too.
   */
  test("Plex without a file is the primary action even for an admin", () => {
    const html = render(makeTitle({ inLibrary: true, plex: PLEX }), true);
    expect(html).toContain("Play on Plex");
    expect(html).not.toContain("Play here");
  });
});

describe("a title we do not hold the file for", () => {
  test("a verdict about a real request outranks the bare library row", () => {
    const html = render(
      makeTitle({ inLibrary: true, requestStatus: "queued", requestVerdict: "downloading" }),
      true,
    );
    expect(html).toContain("Downloading");
    expect(html).not.toContain("Monitored, not downloaded");
  });

  /*
    A DEAD END ON THE ONE SCREEN WITH ROOM FOR IT MUST OFFER THE WAY OUT. Reported by aannarr
    2026-09-15 from /title/tt10802170: "Request failed" and nothing to press, while the same
    request on /requests had a Try again beside it.
  */
  test("a request that dead-ended offers Try again under its verdict", () => {
    for (const verdict of ["failed", "no_releases", "nothing_accepted"] as const) {
      const html = render(makeTitle({ requestStatus: "failed", requestVerdict: verdict }), false);
      expect(html).toContain("Try again");
    }
  });

  /*
    Found driving the fix in a browser, 2026-09-15: after Try again the panel read "Requested"
    over "The request could not be sent". The optimistic patch moved the status and left the
    OLD failure's words standing -- a new attempt with the last attempt's verdict on it.
  */
  test("the optimistic patch after Try again drops the old failure's words", () => {
    const failed = makeTitle({
      service: "sonarr",
      requestStatus: "failed",
      requestVerdict: "failed",
      requestError: "The request could not be sent",
    });
    const html = render({ ...failed, ...requestStatePatch("queued") }, false);
    expect(html).toContain("Requested");
    expect(html).not.toContain("could not be sent");
  });

  test("a request still being worked on offers no Try again", () => {
    const html = render(makeTitle({ requestStatus: "sent", requestVerdict: "searching" }), false);
    expect(html).not.toContain("Try again");
  });

  test("monitored with nobody asking says so, with the arr's own percentage", () => {
    const html = render(makeTitle({ inLibrary: true, progress: 0.42 }), true);
    expect(html).toContain("Monitored, not downloaded");
    expect(html).toContain("42%");
  });

  test("nothing at all is the offer to ask, named for the arr that would answer", () => {
    expect(render(makeTitle(), true)).toContain("Request from Radarr");
    expect(render(makeTitle({ service: "sonarr" }), true)).toContain("Request from Sonarr");
  });

  test("a series whose seasons have landed opens the chooser rather than promising to queue", () => {
    expect(render(makeTitle({ service: "sonarr" }), true, true)).toContain("Choose seasons");
  });
});

/**
 * The two accent buttons are ONE look, and the point of sharing it is that the primary slot
 * stays recognisable as one slot however a title's state turns out.
 */
test("PLAY wears the same accent fill the Request button does", () => {
  const play = render(makeTitle({ inLibrary: true, hasFile: true }), true);
  const request = render(makeTitle(), true);
  expect(play).toContain("bg-accent");
  expect(request).toContain("bg-accent");
});
