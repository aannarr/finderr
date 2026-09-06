/**
 * The two-click guard, driven rather than drawn.
 *
 * `web/src/test/interact.ts` rather than the static idiom, and this component is the reason
 * that harness exists: every assertion below is about the SECOND render. The one that
 * matters is "a successful confirm returns to the resting verb" -- the defect fixed in
 * `bb41d4b`, which left the control in the asking state so a label-flipping action ("Disable
 * this account" becoming "Enable this account") sat one click from a primed "Yes, enable"
 * that would undo what had just happened. Static markup renders the resting state and stops,
 * so it could not see it, and did not.
 */

import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen } from "../test/interact";
import { ConfirmAction } from "./ConfirmAction";

/** The wording every test here shares, so an assertion names a role and a label, not a class. */
const WORDS = {
  label: "Disable this account",
  question: "Disable this account?",
  confirmLabel: "Yes, disable",
  busyLabel: "Disabling…",
} as const;

function press(name: string): void {
  fireEvent.click(screen.getByRole("button", { name }));
}

describe("asking", () => {
  test("the resting state is the verb alone -- nothing is asked until it is pressed", () => {
    render(<ConfirmAction {...WORDS} onConfirm={async () => {}} />);

    expect(screen.getByRole("button", { name: WORDS.label })).toBeDefined();
    expect(screen.queryByText(WORDS.question)).toBeNull();
    expect(screen.queryByRole("button", { name: WORDS.confirmLabel })).toBeNull();
  });

  test("pressing the verb asks, and replaces the verb rather than sitting beside it", () => {
    render(<ConfirmAction {...WORDS} onConfirm={async () => {}} />);
    press(WORDS.label);

    expect(screen.getByText(WORDS.question)).toBeDefined();
    expect(screen.getByRole("button", { name: WORDS.confirmLabel })).toBeDefined();
    // The verb is GONE, so the same click cannot mean two different things.
    expect(screen.queryByRole("button", { name: WORDS.label })).toBeNull();
  });

  test("cancelling returns to the verb and never runs the work", () => {
    let ran = 0;
    render(
      <ConfirmAction
        {...WORDS}
        onConfirm={async () => {
          ran += 1;
        }}
      />,
    );
    press(WORDS.label);
    press("Cancel");

    expect(ran).toBe(0);
    expect(screen.getByRole("button", { name: WORDS.label })).toBeDefined();
  });
});

describe("confirming", () => {
  test("the work runs exactly once", async () => {
    let ran = 0;
    render(
      <ConfirmAction
        {...WORDS}
        onConfirm={async () => {
          ran += 1;
        }}
      />,
    );
    press(WORDS.label);
    press(WORDS.confirmLabel);
    await screen.findByRole("button", { name: WORDS.label });

    expect(ran).toBe(1);
  });

  /**
   * THE REGRESSION. Left in the asking state, a control whose label flips after the work
   * lands is a primed confirmation for the OPPOSITE action -- one unguarded click from
   * undoing what just happened. Landing back on the resting verb is what makes the second
   * action ask again.
   */
  test("a successful confirm returns to the resting verb, not to a primed opposite", async () => {
    render(<ConfirmAction {...WORDS} onConfirm={async () => {}} />);
    press(WORDS.label);
    press(WORDS.confirmLabel);

    expect(await screen.findByRole("button", { name: WORDS.label })).toBeDefined();
    expect(screen.queryByRole("button", { name: WORDS.confirmLabel })).toBeNull();
    expect(screen.queryByText(WORDS.question)).toBeNull();
  });

  test("while the work is in flight the confirm reads present-tense and neither button answers", async () => {
    // Held open on purpose: the busy state is the one render that only exists between the
    // click and the promise settling, so the test has to own when that happens.
    const inFlight = Promise.withResolvers<void>();
    render(<ConfirmAction {...WORDS} onConfirm={() => inFlight.promise} />);
    press(WORDS.label);
    press(WORDS.confirmLabel);

    expect(screen.getByRole("button", { name: WORDS.busyLabel }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true);

    inFlight.resolve();
    // Settled before the test ends, so the last render happens while React is still watching.
    await screen.findByRole("button", { name: WORDS.label });
  });

  /**
   * A refusal on these screens is a real answer -- "that is the last admin" -- so it is
   * shown verbatim, and the control goes back to its verb so the reader can act on what
   * they were just told.
   */
  test("a refusal is shown as the server worded it, and the verb comes back", async () => {
    render(
      <ConfirmAction
        {...WORDS}
        onConfirm={async () => {
          throw new Error("that is the last admin");
        }}
      />,
    );
    press(WORDS.label);
    press(WORDS.confirmLabel);

    expect(await screen.findByText("that is the last admin")).toBeDefined();
    expect(screen.getByRole("button", { name: WORDS.label })).toBeDefined();
  });

  test("a second attempt clears the first refusal", async () => {
    let attempt = 0;
    render(
      <ConfirmAction
        {...WORDS}
        onConfirm={async () => {
          attempt += 1;
          if (attempt === 1) throw new Error("that is the last admin");
        }}
      />,
    );
    press(WORDS.label);
    press(WORDS.confirmLabel);
    await screen.findByText("that is the last admin");

    press(WORDS.label);
    press(WORDS.confirmLabel);
    await screen.findByRole("button", { name: WORDS.label });

    expect(screen.queryByText("that is the last admin")).toBeNull();
  });
});
