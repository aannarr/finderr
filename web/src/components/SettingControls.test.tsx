/**
 * The two setting controls, driven rather than drawn.
 *
 * The behaviour idiom (`web/src/test/interact.ts`), because every assertion here is about the
 * SECOND render: what a control does after the save resolves, and what it shows after the save
 * is refused. A static render of either one proves nothing -- the resting state is a label and
 * an input, and both of those are correct in the broken version too.
 *
 * The one that would otherwise ship broken is the REFUSAL. Four call sites rely on the server's
 * own words landing beside the control that provoked them, and a `catch` that swallowed would
 * look exactly like a save that worked.
 */

import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen, waitFor } from "../test/interact";
import { QuotaField, ToggleSetting } from "./SettingControls";

const press = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

/** A save that never resolves, so the in-flight state can be asserted rather than raced. */
const pending = () => new Promise<void>(() => {});

describe("QuotaField", () => {
  const field = (over: Partial<Parameters<typeof QuotaField>[0]> = {}) => (
    <QuotaField id="q" label="Titles a day" value={5} save={async () => {}} {...over}>
      the hint
    </QuotaField>
  );

  test("the current value is the draft, and zero is a value rather than a blank field", () => {
    render(field({ value: 0 }));
    expect((screen.getByLabelText("Titles a day") as HTMLInputElement).value).toBe("0");
  });

  test("saving sends the number that was typed", async () => {
    const saved: number[] = [];
    render(field({ save: async (n) => void saved.push(n) }));

    fireEvent.change(screen.getByLabelText("Titles a day"), { target: { value: "12" } });
    press("Save");
    await waitFor(() => expect(saved).toEqual([12]));
  });

  /**
   * THE REGRESSION. `Number("")` is `0`, and zero means UNLIMITED -- so clearing the box and
   * pressing Save used to REMOVE the limit while looking like a form somebody had not filled
   * in. The browser's own `min`/`step` validation cannot catch this one: an empty optional
   * number field is valid, which is why a fraction never reaches the handler and this does.
   */
  test("an emptied field is refused rather than read as zero, which would mean unlimited", async () => {
    let calls = 0;
    render(field({ save: async () => void calls++ }));

    fireEvent.change(screen.getByLabelText("Titles a day"), { target: { value: "" } });
    press("Save");
    await waitFor(() => expect(screen.getByText("a whole number of titles, 0 or more")).toBeDefined());
    expect(calls).toBe(0);
  });

  test("the server's own refusal lands on the control, in its own words", async () => {
    render(
      field({
        save: async () => {
          throw new Error("that setting could not be saved");
        },
      }),
    );
    press("Save");
    await waitFor(() => expect(screen.getByText("that setting could not be saved")).toBeDefined());
  });

  test("both buttons are disabled while a save is in flight, so it cannot be sent twice", () => {
    render(field({ save: pending, secondary: { label: "Follow the site default (0)", run: pending } }));
    press("Save");

    expect(screen.getByRole("button", { name: "Saving…" })).toBeDefined();
    expect(
      (screen.getByRole("button", { name: "Follow the site default (0)" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test("the secondary action runs its own work, not the save", async () => {
    let cleared = 0;
    let saved = 0;
    render(
      field({
        save: async () => void saved++,
        secondary: { label: "Follow the site default (0)", run: async () => void cleared++ },
      }),
    );
    press("Follow the site default (0)");

    await waitFor(() => expect(cleared).toBe(1));
    expect(saved).toBe(0);
  });

  test("with no secondary, only Save is offered", () => {
    render(field());
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
});

describe("ToggleSetting", () => {
  const toggle = (over: Partial<Parameters<typeof ToggleSetting>[0]> = {}) => (
    <ToggleSetting
      label="Assistant"
      on={true}
      action={(on) => (on ? "Turn off" : "Turn on")}
      save={async () => {}}
      {...over}
    >
      the hint
    </ToggleSetting>
  );

  test("the button says what pressing it would do, not what the state is", () => {
    render(toggle({ on: true }));
    expect(screen.getByRole("button", { name: "Turn off" })).toBeDefined();
  });

  test("pressing it sends the OPPOSITE of the current state", async () => {
    const sent: boolean[] = [];
    render(toggle({ on: true, save: async (on) => void sent.push(on) }));
    press("Turn off");
    await waitFor(() => expect(sent).toEqual([false]));
  });

  test("a refusal lands beside the switch rather than taking the page down", async () => {
    render(
      toggle({
        save: async () => {
          throw new Error("that is the last admin");
        },
      }),
    );
    press("Turn off");
    await waitFor(() => expect(screen.getByText("that is the last admin")).toBeDefined());
  });

  test("it is disabled while saving", () => {
    render(toggle({ save: pending }));
    press("Turn off");
    expect((screen.getByRole("button", { name: "Saving…" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
