/**
 * The Withdraw control on a request row.
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
import { WithdrawControl } from "./RequestsRoute";

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
