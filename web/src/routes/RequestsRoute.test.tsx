/**
 * The controls on a request row: Withdraw, the Play links an arrived one earns, and the Try
 * again a dead-ended one earns.
 *
 * TWO IDIOMS, and which one each block uses is the rule in `web/src/test/interact.ts`.
 * `react-dom/server` for what a row DRAWS -- which affordances exist before anybody clicks
 * anything, which is exactly the property worth pinning for Withdraw ("one click must not
 * withdraw") and needs no DOM. The harness for what Retry DOES, because "renders a button
 * and calls nothing" is the failure that shipped here three times: the endpoint has existed
 * since requests did and this page had never called it.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { isWithdrawable } from "../../../src/lib/request-withdrawal";
import type { MediaRequest } from "../lib/api";
import { fireEvent, render, screen } from "../test/interact";
import { RequestActions, RetryControl, WithdrawControl } from "./RequestsRoute";

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
  posterUrl: "/img/t/tt1375666",
  seasonProgress: [],
  ...over,
});

/** Named for its subject rather than `render`, which is now the DOM harness's. */
const withdrawal = (over: Partial<MediaRequest> = {}) =>
  renderToStaticMarkup(<WithdrawControl request={request(over)} onWithdrawn={() => {}} />);

describe("the withdraw control", () => {
  test("offers Withdraw on a request that has not arrived", () => {
    expect(withdrawal()).toContain("Withdraw");
  });

  /*
    THE CONFIRMATION, ASSERTED AS AN ABSENCE.

    Withdrawing undoes somebody's ask and cannot be undone in turn, so the first click must
    only ever ARM it. If "Yes, withdraw" is already in the markup, the guard has been lost --
    which is precisely the regression a later restyle would introduce without noticing.
  */
  test("the confirming button is not on the page until the reader asks for it", () => {
    const html = withdrawal();
    expect(html).not.toContain("Yes, withdraw");
    expect(html).not.toContain("Keep it");
  });

  test("a request that already arrived offers no control at all", () => {
    expect(withdrawal({ status: "available", requestVerdict: "imported" })).toBe("");
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
      expect(withdrawal({ status })).toContain("Withdraw");
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

describe("which rows may be asked for again", () => {
  const retry = (over: Partial<MediaRequest> = {}) =>
    renderToStaticMarkup(<RetryControl request={request(over)} onRetried={() => {}} />);

  /*
    THE TONE AND NEVER A LIST OF VERDICTS. Both dead ends earn the control for the same
    reason -- nothing further will happen on its own -- and a verdict added to `VERDICT_COPY`
    with a `dead_end` tone lands here without this file or the component being edited.
  */
  test("a dead end offers a way to ask again", () => {
    for (const verdict of ["no_releases", "nothing_accepted", "failed", "needs_manual_import"] as const) {
      expect(retry({ requestVerdict: verdict })).toContain("Try again");
    }
  });

  /*
    A retry re-queues the request, which on something already downloading would cancel a
    download in progress and start the search over. The control is absent rather than
    disabled: there is nothing here for a reader to want.
  */
  test("nothing still moving, and nothing that arrived, offers it", () => {
    for (const verdict of ["queued", "searching", "downloading", "imported"] as const) {
      expect(retry({ requestVerdict: verdict })).toBe("");
    }
  });

  test("a row with no verdict at all offers nothing", () => {
    expect(retry({ requestVerdict: null })).toBe("");
  });
});

/**
 * THE DEFECT THIS PINS: a Retry button that renders and calls nothing.
 *
 * `POST /api/requests/:tconst/retry` has existed since requests did, and until this card
 * NOTHING on this page reached it. That is precisely the "draws correctly, does nothing"
 * shape `web/src/test/interact.ts` was added for -- a static render of the button proves
 * only that the word is on the screen.
 */
describe("asking again, driven", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** Stand in for the network, and record what the component asked it for. */
  function stubFetch(answer: () => Promise<Response>) {
    const calls: string[] = [];
    globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(url)}`);
      return answer();
    }) as unknown as typeof fetch;
    return calls;
  }

  test("pressing it POSTs the retry and tells the page to reload", async () => {
    const calls = stubFetch(async () => new Response("{}", { status: 200 }));
    let reloaded = 0;

    render(
      <RetryControl
        request={request({ requestVerdict: "no_releases", status: "no_release" })}
        onRetried={() => {
          reloaded += 1;
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("button", { name: "Try again" });

    expect(calls).toEqual(["POST /api/requests/tt1375666/retry"]);
    expect(reloaded).toBe(1);
  });

  /*
    A refused retry leaves the row exactly as it was and says why, rather than reloading a
    list that has not changed. The reader can press it again, which is why the verb comes back.
  */
  test("a refusal is shown and the page is not reloaded", async () => {
    stubFetch(async () => new Response("nope", { status: 500 }));
    let reloaded = 0;

    render(
      <RetryControl
        request={request({ requestVerdict: "failed", status: "failed" })}
        onRetried={() => {
          reloaded += 1;
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("retry failed: 500")).toBeDefined();
    expect(reloaded).toBe(0);
    expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
  });

  test("while it is in flight the button reads present-tense and does not answer twice", async () => {
    // Held open on purpose: the busy state exists only between the click and the promise
    // settling, so the test has to own when that happens.
    const inFlight = Promise.withResolvers<Response>();
    const calls = stubFetch(() => inFlight.promise);

    render(
      <RetryControl request={request({ requestVerdict: "failed", status: "failed" })} onRetried={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    const busy = screen.getByRole("button", { name: "Asking again…" });
    expect(busy.hasAttribute("disabled")).toBe(true);
    fireEvent.click(busy);
    expect(calls).toHaveLength(1);

    inFlight.resolve(new Response("{}", { status: 200 }));
    // Settled before the test ends, so the last render happens while React is still watching.
    await screen.findByRole("button", { name: "Try again" });
  });
});
