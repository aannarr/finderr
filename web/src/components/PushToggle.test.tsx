/**
 * The account page's notification section, and the one control on it that acts on devices
 * the reader is not holding.
 *
 * DRIVEN rather than drawn, for the reason `PushOffer.test.tsx` gives: headless Chrome
 * reports no `PushManager`, so a browser run reaches only the `unsupported` sentence and
 * every rule worth pinning here is a state this component is IN. `usePush` is replaced
 * wholesale; the machine itself is tested where it lives.
 *
 * WHAT THIS FILE OWNS is the "everywhere" rule. Whether the per-device switch reads on or
 * off is one ternary; whether somebody is offered a way to reach a phone they no longer have
 * is the decision, and getting it wrong hides the control from exactly the person who needs
 * it.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { PushControl } from "../lib/use-push";

let control: PushControl;
mock.module("../lib/use-push", () => ({ usePush: () => control }));

const { PushToggle } = await import("./PushToggle");
const { fireEvent, render, screen } = await import("../test/interact");

const EVERYWHERE = "Turn off everywhere";

beforeEach(() => {
  control = {
    support: { kind: "available", publicKey: "k" },
    subscribed: false,
    offered: true,
    devices: 0,
    busy: false,
    error: null,
    toggle: async () => {},
    disableAll: async () => {},
    dismiss: async () => {},
  };
});

describe("turning it off everywhere", () => {
  /*
    THE CASE THE FEATURE EXISTS FOR. An endpoint can only be unsubscribed by the browser that
    owns it, so a phone that was sold or reset keeps receiving until a send comes back 410 --
    which for somebody who has stopped requesting things is never. This browser is not
    subscribed, so the per-device switch says nothing about that phone.
  */
  test("a device this browser cannot reach is still offered an off switch", () => {
    control = { ...control, subscribed: false, devices: 1 };
    render(<PushToggle />);
    expect(screen.getByRole("button", { name: EVERYWHERE })).toBeDefined();
  });

  test("several devices, and the count says so", () => {
    control = { ...control, subscribed: true, devices: 3 };
    render(<PushToggle />);
    expect(screen.getByRole("button", { name: EVERYWHERE })).toBeDefined();
    expect(screen.getByText(/3 devices are subscribed/)).toBeDefined();
  });

  /*
    ONE DEVICE AND IT IS THIS ONE: the per-device switch already reaches it, so a second
    control saying the same thing in stronger words is noise.
  */
  test("this device alone is not a fleet", () => {
    control = { ...control, subscribed: true, devices: 1 };
    render(<PushToggle />);
    expect(screen.queryByRole("button", { name: EVERYWHERE })).toBeNull();
  });

  test("nothing subscribed, nothing to turn off", () => {
    render(<PushToggle />);
    expect(screen.queryByRole("button", { name: EVERYWHERE })).toBeNull();
  });

  test("pressing it de-registers, exactly once", () => {
    let calls = 0;
    control = {
      ...control,
      devices: 2,
      disableAll: async () => {
        calls += 1;
      },
    };
    render(<PushToggle />);
    fireEvent.click(screen.getByRole("button", { name: EVERYWHERE }));

    expect(calls).toBe(1);
  });
});

describe("what it says when it cannot offer the switch", () => {
  /*
    THREE OF THE FOUR ARE THINGS THE READER CAN FIX, which is why this rendering exists apart
    from the offer: a greyed control with no sentence sends all of them to one dead end.
  */
  test("iOS in a tab is told to install, not that its browser is too old", () => {
    control = { ...control, support: { kind: "install-first" } };
    render(<PushToggle />);
    expect(screen.getByText(/home screen/)).toBeDefined();
  });

  test("nothing at all until the first read finishes", () => {
    control = { ...control, support: null };
    const { container } = render(<PushToggle />);
    expect(container.textContent).toBe("");
  });
});
