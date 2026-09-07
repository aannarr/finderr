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
import { modeOf, QuotaField, storedFor, ToggleSetting } from "./SettingControls";

const press = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

/** A save that never resolves, so the in-flight state can be asserted rather than raced. */
const pending = () => new Promise<void>(() => {});

/*
  REWRITTEN 2026-09-07 WHEN THE NUMBER FIELD BECAME THREE NAMED CHOICES.

  It was one box whose magic values carried the meaning -- `null` inherit, `0` unlimited, `n`
  a cap -- with the last two explained in a hint underneath. Every premise below survived the
  change; only the mechanism moved. The one that got STRONGER is the empty-field guard: an
  empty box used to be indistinguishable from "no limit", and now they are not even the same
  control.
*/
describe("modeOf / storedFor", () => {
  /*
    The wire format is unchanged and `src/lib/request-quota.ts` still owns what it means, so
    the mapping this component renders through has to round-trip exactly. A drift here would
    show up as a setting that reads back differently from how it was saved -- silently.
  */
  test("every stored value names a mode, and every mode returns to its value", () => {
    expect(modeOf(null)).toBe("inherit");
    expect(modeOf(0)).toBe("none");
    expect(modeOf(3)).toBe("capped");

    expect(storedFor("inherit", 3)).toBe(null);
    expect(storedFor("none", 3)).toBe(0);
    expect(storedFor("capped", 3)).toBe(3);
  });

  /** `none` ignores whatever is in the box, which is what makes the draft safe to remember. */
  test("choosing no limit sends zero whatever was typed", () => {
    expect(storedFor("none", 99)).toBe(0);
  });
});

describe("QuotaField", () => {
  const field = (over: Partial<Parameters<typeof QuotaField>[0]> = {}) => (
    <QuotaField
      id="q"
      label="Daily request limit"
      value={5}
      inheritLabel="Follow the site default (no limit)"
      save={async () => {}}
      {...over}
    >
      the hint
    </QuotaField>
  );

  const choose = (name: string) => fireEvent.click(screen.getByRole("radio", { name }));

  test("the stored value selects its own choice, and a cap shows the number", () => {
    render(field({ value: 5 }));
    expect(
      screen.getByRole("radio", { name: "Limit the number of requests a day" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect((screen.getByLabelText("Requests a day") as HTMLInputElement).value).toBe("5");
  });

  /*
    ZERO IS A CHOICE, NOT A BLANK -- the same property the old test asserted about a "0" in a
    box, now asserted about the control that says it in words. This is the whole point of the
    rewrite: nothing on screen requires the reader to know what zero means.
  */
  test("no limit is its own choice, and draws no number at all", () => {
    render(field({ value: 0 }));
    expect(screen.getByRole("radio", { name: "No limit" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByLabelText("Requests a day")).toBeNull();
  });

  test("following the site default is offered where there is one to follow", () => {
    render(field({ value: null }));
    expect(screen.getByRole("radio", { name: "Follow the site default (no limit)" })).toBeDefined();
  });

  /** The site-wide caller passes no `inheritLabel`: there is nothing above a site default. */
  test("and is absent entirely without an inheritLabel", () => {
    render(field({ inheritLabel: undefined, value: 0 }));
    expect(screen.queryByRole("radio", { name: "Follow the site default (no limit)" })).toBeNull();
  });

  test("saving a cap sends the number that was typed", async () => {
    const saved: (number | null)[] = [];
    render(field({ save: async (n) => void saved.push(n) }));

    fireEvent.change(screen.getByLabelText("Requests a day"), { target: { value: "12" } });
    press("Save");
    await waitFor(() => expect(saved).toEqual([12]));
  });

  test("choosing no limit sends zero, and following the site sends null", async () => {
    const saved: (number | null)[] = [];
    render(field({ save: async (n) => void saved.push(n) }));

    choose("No limit");
    press("Save");
    await waitFor(() => expect(saved).toEqual([0]));

    choose("Follow the site default (no limit)");
    press("Save");
    await waitFor(() => expect(saved).toEqual([0, null]));
  });

  /**
   * THE REGRESSION, and it still matters. `Number("")` is `0`, which used to mean UNLIMITED --
   * so clearing the box and pressing Save REMOVED the limit while looking like a form somebody
   * had not filled in. The browser's own `min`/`step` validation cannot catch it: an empty
   * optional number field is valid, which is why a fraction never reaches the handler and this
   * does. The guard tests the STRING before it is ever a number.
   */
  test("an emptied box is refused rather than read as zero", async () => {
    let calls = 0;
    render(field({ save: async () => void calls++ }));

    fireEvent.change(screen.getByLabelText("Requests a day"), { target: { value: "" } });
    press("Save");
    await waitFor(() => expect(screen.getByText("a whole number, 1 or more")).toBeDefined());
    expect(calls).toBe(0);
  });

  /*
    A cap of zero is not a cap -- that is the "No limit" choice, and it has its own radio.

    The refusal is the BROWSER's here rather than ours: `min={1}` on the field means
    constraint validation blocks the submit before the handler runs, so what is asserted is
    that nothing was saved, not that our own message appeared. Both floors exist on purpose --
    the attribute stops the spinner going below 1 and gives the native refusal, and the string
    check in the handler catches the empty box the attribute calls valid.
  */
  test("a cap of zero never reaches the server, because zero is a different choice", async () => {
    let calls = 0;
    render(field({ save: async () => void calls++ }));

    fireEvent.change(screen.getByLabelText("Requests a day"), { target: { value: "0" } });
    press("Save");
    await waitFor(() => expect(calls).toBe(0));
  });

  test("the server's own refusal lands on the control, in its own words", async () => {
    render(
      field({
        save: async () => {
          throw new Error("that setting could not be saved");
        },
      }),
    );
    fireEvent.change(screen.getByLabelText("Requests a day"), { target: { value: "6" } });
    press("Save");
    await waitFor(() => expect(screen.getByText("that setting could not be saved")).toBeDefined());
  });

  test("Save is disabled while the request is in flight, so it cannot be sent twice", () => {
    render(field({ save: pending }));
    fireEvent.change(screen.getByLabelText("Requests a day"), { target: { value: "6" } });
    press("Save");
    expect((screen.getByRole("button", { name: "Saving…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  /*
    A Save that is always live invites a write that changes nothing and reloads the page for
    it -- and on this control that write would be indistinguishable from a real edit in the
    log. Nothing has changed at rest, so there is nothing to send.
  */
  test("Save is dead until something actually differs from what is stored", () => {
    render(field({ value: 5 }));
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Requests a day"), { target: { value: "6" } });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  });

  /** Switching away and back must not silently wipe what somebody had already typed. */
  test("the typed number survives a trip through another choice", () => {
    render(field({ value: 5 }));
    fireEvent.change(screen.getByLabelText("Requests a day"), { target: { value: "9" } });

    choose("No limit");
    expect(screen.queryByLabelText("Requests a day")).toBeNull();

    choose("Limit the number of requests a day");
    expect((screen.getByLabelText("Requests a day") as HTMLInputElement).value).toBe("9");
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

  /*
    REWRITTEN 2026-09-06 WHEN THE TEXT LINK BECAME A REAL SWITCH, and every premise survived.

    These four asserted a `<button>` whose LABEL was the inverse of the state -- "Turn off"
    while the setting was on. The control is now a switch, so the state is what is drawn and
    the action is the affordance; the four things worth defending are unchanged and are what
    each test still says. Only the mechanism moved, which is exactly when a test is edited
    rather than deleted.
  */
  const flip = () => fireEvent.click(screen.getByRole("switch"));

  test("the switch shows the STATE, and still announces what flipping it would do", () => {
    render(toggle({ on: true }));
    const sw = screen.getByRole("switch", { name: "Turn off" });
    // The state is the thing a reader came for, and `aria-checked` is where a switch keeps it.
    expect(sw.getAttribute("aria-checked")).toBe("true");
  });

  test("an off setting draws an off switch rather than an inverted label", () => {
    render(toggle({ on: false }));
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
  });

  test("pressing it sends the OPPOSITE of the current state", async () => {
    const sent: boolean[] = [];
    render(toggle({ on: true, save: async (on) => void sent.push(on) }));
    flip();
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
    flip();
    await waitFor(() => expect(screen.getByText("that is the last admin")).toBeDefined());
  });

  /*
    A switch has no "Saving…" to read, so the in-flight state is the DISABLED attribute and
    nothing else -- which makes this the one of the four that would silently stop meaning
    anything if it were left asserting a label. Two flips racing one save is the bug.
  */
  test("it cannot be flipped again while the first save is in flight", () => {
    render(toggle({ save: pending }));
    flip();
    expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
  });
});
