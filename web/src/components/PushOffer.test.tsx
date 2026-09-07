/**
 * The contextual push offer: when it appears, when it says nothing, and what pressing it does.
 *
 * DRIVEN rather than drawn, because every assertion here is about a state this component is
 * IN rather than about markup -- and because the browser run could not reach it: headless
 * Chrome reports no `PushManager`, so `pushSupport()` answers `unsupported` and the offer
 * correctly renders nothing on the one instance a seat can drive. Without this file the
 * placement rule -- the whole of R8 -- would have shipped unexercised.
 *
 * `usePush` is replaced wholesale rather than stubbed at the browser APIs beneath it. What is
 * worth pinning here is the PLACEMENT rule (offered only while something is moving, only to
 * somebody not already subscribed, and never as an explanation of why push is unavailable);
 * the machine itself belongs to `usePush` and is shared with `PushToggle`.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { PushControl } from "../lib/use-push";

let control: PushControl;
mock.module("../lib/use-push", () => ({ usePush: () => control }));

const { PushOffer } = await import("./PushOffer");
const { fireEvent, render, screen } = await import("../test/interact");

const OFFER = "Notify me when it lands";

beforeEach(() => {
  control = {
    support: { kind: "available", publicKey: "k" },
    subscribed: false,
    offered: false,
    devices: 0,
    busy: false,
    error: null,
    toggle: async () => {},
    disableAll: async () => {},
    dismiss: async () => {},
  };
});

describe("when the offer is made", () => {
  test("something is downloading and this device is not subscribed", () => {
    render(<PushOffer when={true} />);
    expect(screen.getByRole("button", { name: OFFER })).toBeDefined();
  });

  /*
    THE PLACEMENT IS THE FEATURE. Asking somebody with nothing in flight is a nag, and it is
    what the account page's permanent switch is already for.
  */
  test("nothing in flight, nothing offered", () => {
    render(<PushOffer when={false} />);
    expect(screen.queryByRole("button", { name: OFFER })).toBeNull();
  });

  test("a device already subscribed is not asked again", () => {
    control = { ...control, subscribed: true };
    render(<PushOffer when={true} />);
    expect(screen.queryByRole("button", { name: OFFER })).toBeNull();
  });

  /*
    ONCE PER PERSON, and this is the assertion that makes it true across devices. `offered`
    is an account column, so a reader who answered on their phone is not asked on their
    laptop -- where `subscribed` is honestly false and the test above would let it through.
  */
  test("somebody already asked is never asked again, on any device", () => {
    control = { ...control, offered: true };
    render(<PushOffer when={true} />);
    expect(screen.queryByRole("button", { name: OFFER })).toBeNull();
  });

  /*
    Each of the four unavailable reasons renders NOTHING here, and that is the other half of
    not being a nag: explaining iOS home screens above somebody's downloads is `PushToggle`'s
    job on a page they went to on purpose.
  */
  test("a browser that cannot do this says nothing, rather than explaining why", () => {
    for (const kind of ["unsupported", "install-first", "denied", "server-off"] as const) {
      control = { ...control, support: { kind } };
      render(<PushOffer when={true} />);
      expect(screen.queryByRole("button", { name: OFFER })).toBeNull();
    }
  });

  test("nothing at all until the first read finishes", () => {
    control = { ...control, support: null };
    render(<PushOffer when={true} />);
    expect(screen.queryByRole("button", { name: OFFER })).toBeNull();
  });
});

describe("pressing it", () => {
  test("runs the toggle exactly once", () => {
    let toggled = 0;
    control = {
      ...control,
      toggle: async () => {
        toggled += 1;
      },
    };
    render(<PushOffer when={true} />);
    fireEvent.click(screen.getByRole("button", { name: OFFER }));

    expect(toggled).toBe(1);
  });

  test("while it is in flight the button reads present-tense and does not answer", () => {
    control = { ...control, busy: true };
    render(<PushOffer when={true} />);

    const busy = screen.getByRole("button", { name: "One moment…" });
    expect(busy.hasAttribute("disabled")).toBe(true);
  });

  /*
    THE ONE THING THAT OUTLIVES `when`. The browser will not ask twice on its own, so
    somebody who tapped this and then declined at the system prompt is owed the sentence --
    even if the download they were watching finished in the meantime. Silently reverting to
    the offer would read as a dead button.
  */
  test("a refusal is shown, and is shown even once nothing is moving", () => {
    control = { ...control, error: "You declined notifications." };
    render(<PushOffer when={false} />);

    expect(screen.getByText("You declined notifications.")).toBeDefined();
  });
});

/*
  SAYING NO WITHOUT ANSWERING A SYSTEM PROMPT. Without this control the only way to stop
  being asked is to open the browser's own permission dialog and refuse it -- a heavier and
  more permanent act than the question deserves, and one that also blocks the account page's
  switch forever.
*/
describe("declining the offer", () => {
  test("records the answer, so it is never put again", () => {
    let dismissed = 0;
    control = {
      ...control,
      dismiss: async () => {
        dismissed += 1;
      },
    };
    render(<PushOffer when={true} />);
    fireEvent.click(screen.getByRole("button", { name: "No thanks" }));

    expect(dismissed).toBe(1);
  });

  test("it is not offered while the other button is working", () => {
    control = { ...control, busy: true };
    render(<PushOffer when={true} />);
    expect(screen.queryByRole("button", { name: "No thanks" })).toBeNull();
  });
});
