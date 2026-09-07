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
  lang: null,
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

  /**
   * The ladder, in the order the component reads it: the FILE outranks everything, a verdict
   * outranks a bare library row, and a bare library row outranks only the offer to ask.
   *
   * The middle row is the regression. `if (t.inLibrary)` came first until 2026-09-07, so a
   * title the arr had accepted -- which is every title, about sixty seconds after Request --
   * said "Monitored" and lost the verdict, the progress bar and the ETA for the whole time
   * anybody was watching.
   */
  test.each([
    [{ inLibrary: true, hasFile: true }, "Available"],
    [{ inLibrary: true, hasFile: false }, "Requested"],
    [{ inLibrary: false, hasFile: false }, "Requested"],
  ])("a requested title reads %o as its own state", (over, expected) => {
    expect(render({ ...TITLE, ...requestStatePatch("queued"), ...over })).toContain(expected);
  });

  /**
   * The other half of the same rule: monitored with NO request row is the arr watching on its
   * own -- an unreleased title a list sync pulled in -- and it keeps its own word. Renaming
   * this one "Requested" would claim a requester that `requested_by` says does not exist.
   */
  test("monitored with nobody having asked is still Monitored", () => {
    const html = render({ ...TITLE, inLibrary: true, hasFile: false });
    expect(html).toContain("Monitored");
    expect(html).not.toContain("data-card-request");
  });

  /** A dead end on a monitored title is reported, where it used to be shrugged off as owned. */
  test("a monitored title whose request found nothing says so", () => {
    const html = render({ ...TITLE, ...requestStatePatch("no_release"), inLibrary: true });
    expect(html).toContain("No releases found");
    expect(html).not.toContain("Monitored");
  });
});
