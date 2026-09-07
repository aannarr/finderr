/**
 * What the request control says, and -- the part that was broken -- what it says NEXT.
 *
 * Rendered with `react-dom/server` like `Poster.test.tsx` and for the same reason: every
 * question here is "which words appear for this state", and static markup answers it with
 * no DOM and no click simulation. The click itself is `RootLayout`'s; what this pins is
 * that the patch that click applies is one the control can actually read.
 *
 * The live defect: `patchTitleState(tconst, { requestStatus: "queued" })` wrote a field
 * NOTHING renders. The control has read `requestVerdict` since `VerdictChip` landed, so a
 * card on the shelves page kept saying "Request" after a successful request -- until the
 * next full page load, minutes later, when the server sent a verdict of its own.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { requestStatePatch, type Title } from "../lib/api";
import { RequestAction } from "./RequestAction";

const TITLE: Title = {
  tconst: "tt1375666",
  title: "The Inception",
  orig: null,
  year: 2010,
  kind: "movie",
  votes: 2_400_000,
  rating: 8.4,
  genres: "Action,Sci-Fi",
  runtime: 148,
  inLibrary: false,
  hasFile: false,
  progress: null,
  requestStatus: null,
  requestError: null,
  requestVerdict: null,
  requestProgress: null,
  requestEtaAt: null,
  requestEvidence: null,
  service: "radarr",
  posterUrl: null,
  studio: null,
  studioLogo: null,
  plex: null,
  award: null,
};

const render = (t: Title) => renderToStaticMarkup(<RequestAction title={t} onRequest={() => {}} />);

describe("RequestAction", () => {
  test("offers the request when nobody has asked for this", () => {
    const html = render(TITLE);
    expect(html).toContain("Request");
    // The affordance, not a chip: the keyboard finds a requestable card by this attribute.
    expect(html).toContain("data-card-request");
  });

  /**
   * The regression. `requestStatePatch` is what every optimistic writer applies, so asking
   * the control to render its output is asking the exact question the shelves page asks.
   */
  test("says Requested the moment the request goes out", () => {
    const html = render({ ...TITLE, ...requestStatePatch("queued") });
    expect(html).toContain("Requested");
    // No longer a button: there is nothing left to press until a verdict changes.
    expect(html).not.toContain("data-card-request");
  });

  test("clearing the request puts the button back", () => {
    const requested = { ...TITLE, ...requestStatePatch("queued") };
    const html = render({ ...requested, ...requestStatePatch(null) });
    expect(html).toContain("data-card-request");
    expect(html).not.toContain("Requested");
  });

  /** Owned beats requested, and the arr monitoring something it has not got is its own word. */
  test.each([
    [{ inLibrary: true, hasFile: true }, "Available"],
    [{ inLibrary: true, hasFile: false }, "Monitored"],
  ])("a title we already hold reads %o as its own state", (over, expected) => {
    expect(render({ ...TITLE, ...requestStatePatch("queued"), ...over })).toContain(expected);
  });
});
