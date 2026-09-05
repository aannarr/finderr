/**
 * The controls on a request row: Withdraw, and the Play links an arrived one earns.
 *
 * `react-dom/server` like every other component test here, so what is asserted is the
 * MARKUP: which affordances exist before anybody clicks anything. That is exactly the
 * property worth pinning -- one click must not withdraw -- and it needs no DOM to check,
 * because "the destructive verb is not on the page yet" is a fact about the initial render.
 *
 * The state change behind the first click is React's own and is not re-tested here, for the
 * same reason `SeasonRequestDialog.test.tsx` does not drive `showModal()`.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { isWithdrawable } from "../../../src/lib/request-withdrawal";
import type { MediaRequest } from "../lib/api";
import { RequestActions, WithdrawControl } from "./RequestsRoute";

const request = (over: Partial<MediaRequest> = {}): MediaRequest => ({
  id: 1,
  tconst: "tt1375666",
  title: "Inception",
  year: 2010,
  kind: "movie",
  service: "radarr",
  status: "downloading",
  error: null,
  created_at: "2026-09-05T00:00:00.000Z",
  updated_at: "2026-09-05T00:00:00.000Z",
  seasons: null,
  requestVerdict: "downloading",
  requestProgress: 0.4,
  requestEtaAt: null,
  requestEvidence: null,
  plex: null,
  ...over,
});

const render = (over: Partial<MediaRequest> = {}) =>
  renderToStaticMarkup(<WithdrawControl request={request(over)} onWithdrawn={() => {}} />);

describe("the withdraw control", () => {
  test("offers Withdraw on a request that has not arrived", () => {
    expect(render()).toContain("Withdraw");
  });

  /*
    THE CONFIRMATION, ASSERTED AS AN ABSENCE.

    Withdrawing undoes somebody's ask and cannot be undone in turn, so the first click must
    only ever ARM it. If "Yes, withdraw" is already in the markup, the guard has been lost --
    which is precisely the regression a later restyle would introduce without noticing.
  */
  test("the confirming button is not on the page until the reader asks for it", () => {
    const html = render();
    expect(html).not.toContain("Yes, withdraw");
    expect(html).not.toContain("Keep it");
  });

  test("a request that already arrived offers no control at all", () => {
    expect(render({ status: "available", requestVerdict: "imported" })).toBe("");
  });

  test("every other state a request can reach is withdrawable", () => {
    for (const status of [
      "queued",
      "sent",
      "grabbed",
      "downloading",
      "no_release",
      "failed",
      "manual_import",
    ]) {
      expect(isWithdrawable(status)).toBe(true);
      expect(render({ status })).toContain("Withdraw");
    }
  });
});

const PLEX = {
  web: "https://app.plex.tv/desktop#!/server/abc/details?key=%2Flibrary%2Fmetadata%2F42",
  app: "plex://preplay/?metadataKey=%2Flibrary%2Fmetadata%2F42&server=abc",
};

/** Up to the first `&`, because React escapes one in an attribute. See `PlayOnPlex.test`. */
const APP_PREFIX = PLEX.app.split("&")[0] ?? "";

const actions = (over: Partial<MediaRequest> = {}) =>
  renderToStaticMarkup(<RequestActions request={request(over)} onWithdrawn={() => {}} />);

describe("what an arrived request offers", () => {
  /*
    THE DEFECT THIS PINS: a row reading "Arrived" with nothing to click.

    It is the whole point of the Plex mirror, and it looks entirely correct in a screenshot
    of the state above it, which is why it went unnoticed.
  */
  test("a request Plex holds offers both ways to play it", () => {
    const html = actions({ status: "available", requestVerdict: "imported", plex: PLEX });
    expect(html).toContain(PLEX.web);
    expect(html).toContain(APP_PREFIX);
  });

  /*
    `plex` is null until Plex has SCANNED the file, which is later than the arr importing it.
    Offering a link before then would offer a dead one -- it opens the server's home screen
    rather than failing, so nothing would tell the reader it had not worked.
  */
  test("an arrived request Plex has not scanned yet offers no link at all", () => {
    const html = actions({ status: "available", requestVerdict: "imported", plex: null });
    expect(html).toBe("");
  });

  /*
    Play and Withdraw are not alternatives: a series with its early seasons in Plex and a
    later one downloading is both playable now and still worth being able to call off.
  */
  test("a still-downloading request Plex partly holds offers both", () => {
    const html = actions({ plex: PLEX });
    expect(html).toContain(PLEX.web);
    expect(html).toContain("Withdraw");
  });
});
