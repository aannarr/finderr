/**
 * One addon's generated form, driven rather than drawn.
 *
 * The behaviour idiom (`web/src/test/interact.ts`), because almost everything worth asserting
 * here is the SECOND render: what the box holds after a save lands, what a refusal does, and
 * what a clear sends. The resting state is a label and an input, and those are right in the
 * broken version too.
 *
 * The two properties that must never regress:
 *
 * - A `secret` is WRITE-ONLY. Nothing draws one, because the report carries none -- and the
 *   value an operator types leaves the DOM the moment it is stored. A masked box that a later
 *   render could refill is the hole this whole arrangement exists to close.
 * - The form is GENERATED. Every test below hands it a declaration no addon in this repo has,
 *   which is the point: a new addon gets a working form without a line changing in `web/`.
 */

import { describe, expect, test } from "bun:test";
import type { AddonConfigFieldReport, AddonConfigReport, AddonConfigValue } from "../lib/auth-api";
import { fireEvent, render, screen, waitFor } from "../test/interact";
import { AddonSettings } from "./AddonSettings";

const field = (over: Partial<AddonConfigFieldReport> = {}): AddonConfigFieldReport => ({
  key: "region",
  type: "string",
  label: "Region",
  required: false,
  value: "US",
  set: true,
  source: "store",
  ...over,
});

const report = (over: Partial<AddonConfigReport> = {}): AddonConfigReport => ({
  pluginId: "my-ratings",
  fields: [field()],
  configured: true,
  ...over,
});

/** What the component asked to be saved, in order. */
type Saved = [string, AddonConfigValue | null];

function draw(addon: AddonConfigReport, save?: (k: string, v: AddonConfigValue | null) => Promise<void>) {
  const saved: Saved[] = [];
  render(
    <AddonSettings
      addon={addon}
      save={
        save ??
        (async (key, value) => {
          saved.push([key, value]);
        })
      }
    />,
  );
  return saved;
}

const press = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

describe("what it draws from a declaration", () => {
  test("an addon with no settings says so rather than showing an empty form", () => {
    draw(report({ fields: [] }));
    expect(screen.getByText(/Nothing to configure/)).toBeDefined();
  });

  test("a required field with no value marks the addon as waiting", () => {
    draw(
      report({
        configured: false,
        fields: [
          field({
            key: "apiKey",
            type: "secret",
            label: "API key",
            required: true,
            set: false,
            source: "unset",
            value: undefined,
          }),
        ],
      }),
    );
    expect(screen.getByText("waiting on a setting")).toBeDefined();
    expect(screen.getByText(/Not set/)).toBeDefined();
  });

  /**
   * The status line is the ONLY thing that reports where a value came from, and it is the
   * whole answer for a secret. "Set on this page" and "seeded by an environment variable" are
   * different situations for an operator: saving over the second one is permanent.
   */
  test("it says which source won, and that saving over the environment is permanent", () => {
    draw(report({ fields: [field({ source: "env" })] }));
    expect(screen.getByText(/environment variable on the host/)).toBeDefined();
    expect(screen.getByText(/replaces it for good/)).toBeDefined();
  });

  test("the declaration's own description is what explains the field", () => {
    draw(report({ fields: [field({ description: "Where your ratings come from." })] }));
    expect(screen.getByText(/Where your ratings come from\./)).toBeDefined();
  });

  test("a field sitting on its default offers nothing to clear", () => {
    draw(report({ fields: [field({ source: "default" })] }));
    expect(screen.queryByRole("button", { name: "Clear Region" })).toBeNull();
  });
});

describe("a secret", () => {
  const secret = (over: Partial<AddonConfigFieldReport> = {}) =>
    report({
      fields: [
        field({ key: "apiKey", type: "secret", label: "API key", value: undefined, set: true, ...over }),
      ],
    });

  test("is never drawn, however long it has been stored", () => {
    draw(secret());
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("");
    expect(document.body.innerHTML).not.toContain("s3cret-key-value");
  });

  /**
   * THE ONE THAT WOULD OTHERWISE SHIP BROKEN. The typed key is in the DOM while it is being
   * typed -- it has to be -- and the moment it is stored there is nothing left that could
   * ever put it back. A box that kept it would be a value a later screenshot, a bug report or
   * a shared session hands to somebody else.
   */
  test("leaves the DOM as soon as it is stored", async () => {
    const saved = draw(secret());

    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "s3cret-key-value" } });
    press("Save API key");

    await waitFor(() => expect(saved).toEqual([["apiKey", "s3cret-key-value"]]));
    await waitFor(() => expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe(""));
    expect(document.body.innerHTML).not.toContain("s3cret-key-value");
  });

  /** A refused save must NOT empty the box: the operator would have to retype a key blind. */
  test("stays in the box when the server refuses the save", async () => {
    draw(secret(), async () => {
      throw new Error("apiKey must be at least 4 characters");
    });

    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "abc" } });
    press("Save API key");

    await waitFor(() => expect(screen.getByText("apiKey must be at least 4 characters")).toBeDefined());
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("abc");
  });
});

describe("saving and clearing", () => {
  test("a save carries only the field that was edited", async () => {
    const saved = draw(
      report({ fields: [field(), field({ key: "window", type: "number", label: "Days", value: 7 })] }),
    );

    fireEvent.change(screen.getByLabelText("Region"), { target: { value: "TH" } });
    press("Save Region");

    await waitFor(() => expect(saved).toEqual([["region", "TH"]]));
  });

  test("a number is sent as a number", async () => {
    const saved = draw(
      report({ fields: [field({ key: "window", type: "number", label: "Days", value: 7 })] }),
    );

    fireEvent.change(screen.getByLabelText("Days"), { target: { value: "30" } });
    press("Save Days");

    await waitFor(() => expect(saved).toEqual([["window", 30]]));
  });

  /** `Number("")` is 0, so an empty box would otherwise store a deliberate-looking zero. */
  test("an emptied number is refused rather than read as zero", async () => {
    const saved = draw(
      report({ fields: [field({ key: "window", type: "number", label: "Days", value: 7 })] }),
    );

    fireEvent.change(screen.getByLabelText("Days"), { target: { value: "" } });
    press("Save Days");

    await waitFor(() => expect(screen.getByText("a number")).toBeDefined());
    expect(saved).toEqual([]);
  });

  test("a boolean is sent as a boolean", async () => {
    const saved = draw(
      report({ fields: [field({ key: "verbose", type: "boolean", label: "Verbose", value: false })] }),
    );

    fireEvent.change(screen.getByLabelText("Verbose"), { target: { value: "true" } });
    press("Save Verbose");

    await waitFor(() => expect(saved).toEqual([["verbose", true]]));
  });

  /**
   * Clearing is the only way to un-set a secret, and it is CONFIRMED -- storing an empty row
   * also takes the host's environment variable out of the decision, which is the half an
   * operator does not expect.
   */
  test("clearing asks first, says what else it stops, and sends null", async () => {
    const saved = draw(report());

    press("Clear Region");
    expect(screen.getByText(/environment variable that was seeding it stops applying/)).toBeDefined();
    press("Yes, clear");

    await waitFor(() => expect(saved).toEqual([["region", null]]));
  });

  test("the server's own refusal lands on the control that provoked it", async () => {
    draw(report(), async () => {
      throw new Error("region is not a setting this addon declares");
    });

    press("Save Region");
    await waitFor(() =>
      expect(screen.getByText("region is not a setting this addon declares")).toBeDefined(),
    );
  });
});
