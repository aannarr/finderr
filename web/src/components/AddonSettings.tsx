/**
 * One addon's settings, GENERATED from what it declared rather than written per addon.
 *
 * Everything on screen comes out of `AddonConfigReport` -- the label, the sentence under the
 * control, which of the two sources won, and whether there is anything to clear. An addon
 * dropped into `src/plugins/` gets a working form by declaring `meta.config`, and nothing in
 * `web/` is edited to give it one. That is the whole point of the card this file closes; a
 * `switch (pluginId)` anywhere in here would have thrown it away.
 *
 * > [!CAUTION] A SECRET IS WRITE-ONLY, and this component must never soften that
 * > `report()` sends no `value` for a `secret`, so there is nothing here to draw one from --
 * > the box starts empty however long the key has been stored, and it is emptied again the
 * > moment a save lands. What the reader gets instead is the status line: set or not, and
 * > where the value in effect came from. Do NOT add a "reveal" affordance; the server has
 * > nothing to reveal, and a masked field a GET could still fill is the hole the whole
 * > arrangement exists to close. `src/lib/addon-config.ts` owns the rule.
 *
 * ## ONE FIELD AT A TIME, SAVED ON SUBMIT
 *
 * Each control saves itself, and the PATCH carries only that field. Two reasons, and neither
 * is layout: the server's `PATCH` leaves an absent field alone precisely so two people
 * editing different settings cannot revert each other, and a whole-form write could not
 * carry a `secret` at all -- there is no value on screen to send back for one, so an
 * untouched key would be cleared by the form that redrew it.
 *
 * On SUBMIT, never on change. A configuration change moves the addon's `configVersion` at
 * the next load and prunes what the old configuration bought; a control that saved per
 * keystroke would re-buy the world one character at a time. `configFingerprint` in
 * `src/lib/addon-config.ts` carries the measurement.
 */

import { useState } from "react";
import type {
  AddonConfigFieldReport,
  AddonConfigReport,
  AddonConfigSource,
  AddonConfigValue,
} from "../lib/auth-api";
import { LINK_BUTTON } from "../lib/ui";
import { useSaving } from "../lib/use-saving";
import { ConfirmAction } from "./ConfirmAction";

/** Save one field, or clear it with `null`. Rejecting puts the server's words on the control. */
export type SaveAddonField = (key: string, value: AddonConfigValue | null) => Promise<void>;

/**
 * What the status line says about each source. A RECORD rather than a switch, so a fifth
 * source added to the server is a compile error here instead of a field that quietly says
 * nothing about where its value came from.
 */
const SOURCE_NOTE: Record<AddonConfigSource, string> = {
  store: "Set on this page.",
  env: "Seeded by an environment variable on the host. Saving here replaces it for good.",
  default: "Using the value this addon ships with.",
  unset: "Not set.",
};

/** The `<input type>` each typed-into kind takes. `boolean` is a select and never reaches it. */
const INPUT_TYPE = { string: "text", secret: "password", number: "number" } as const;

const FIELD_BOX = "rounded-lg border border-line bg-surface px-2 py-1 text-sm";

export function AddonSettings({ addon, save }: { addon: AddonConfigReport; save: SaveAddonField }) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h2 className="text-sm font-medium">{addon.pluginId}</h2>
        {/*
          Only the UNCONFIGURED state is worth a badge. "Everything it needs is set" is the
          ordinary case and a green tick beside every addon would make the one that is
          waiting harder to find rather than easier.
        */}
        {!addon.configured && <span className="text-xs text-danger">waiting on a setting</span>}
      </div>

      {addon.fields.length === 0 ? (
        // Said out loud rather than left off the page: "what is installed" is half the
        // question this screen answers, and an addon that is simply absent reads as missing.
        <p className="text-xs text-muted">Nothing to configure. This addon runs as it ships.</p>
      ) : (
        addon.fields.map((field) => (
          <AddonField
            key={field.key}
            id={`${addon.pluginId}-${field.key}`}
            field={field}
            save={(value) => save(field.key, value)}
          />
        ))
      )}
    </section>
  );
}

/**
 * One declared field: a box to type in, what it is for, and what is in effect right now.
 *
 * The BOX and the STATUS LINE answer different questions, deliberately. The box is what you
 * would set; the line is what the server currently resolves. They agree for a stored string
 * and they cannot agree for a secret, which is why the line -- not the box -- is what a
 * reader checks to see whether an addon has its key.
 */
function AddonField({
  id,
  field,
  save,
}: {
  /** Unique across the page: several addons can declare a field of the same name. */
  id: string;
  field: AddonConfigFieldReport;
  save: (value: AddonConfigValue | null) => Promise<void>;
}) {
  const [draft, setDraft] = useState(() => initialDraft(field));
  const [invalid, setInvalid] = useState<string | null>(null);
  const { busy, error, run } = useSaving();

  return (
    <div>
      <form
        className="flex flex-wrap items-baseline gap-x-3 gap-y-1"
        onSubmit={(e) => {
          e.preventDefault();
          const parsed = parseDraft(field, draft);
          if ("error" in parsed) {
            setInvalid(parsed.error);
            return;
          }
          setInvalid(null);
          run(async () => {
            await save(parsed.value);
            // The typed secret leaves the DOM the moment it is stored. Nothing can put it
            // back, which is the promise this surface makes about a `secret`.
            if (field.type === "secret") setDraft("");
          });
        }}
      >
        {/*
          The "required" marker sits OUTSIDE the label, and that is not styling: everything
          inside a `<label>` becomes the control's accessible name, so a marker in there would
          make the box announce itself as "API key · required" and no longer match the words
          beside it.
        */}
        <label htmlFor={id} className="text-sm">
          {field.label}
        </label>
        {field.required && <span className="text-xs text-muted">required</span>}

        <FieldInput id={id} field={field} draft={draft} onChange={setDraft} />

        {/*
          The accessible name carries the FIELD, because a page listing three addons has a
          row of buttons all reading "Save" and nothing but position to tell them apart. The
          visible word stays "Save" and the name still starts with it, so the two agree.
        */}
        <button type="submit" disabled={busy} aria-label={`Save ${field.label}`} className={LINK_BUTTON}>
          {busy ? "Saving…" : "Save"}
        </button>
        {(invalid ?? error) && <span className="text-xs text-danger">{invalid ?? error}</span>}
      </form>

      <p className="mt-1 text-xs text-muted">
        {field.description && `${field.description} `}
        {SOURCE_NOTE[field.source]}
      </p>

      {/*
        A clear is offered only where it CHANGES something: a value this page stored, or one
        the host's environment is seeding. There is nothing to clear off a field that is
        already sitting on its default.

        `ConfirmAction` on all four kinds rather than on secrets alone, because the
        surprising half is the same whatever the type: clearing stores an EMPTY row, which
        takes the environment variable out of the decision as well. An operator who expected
        `.env` to take back over would otherwise find out by watching nothing happen.
      */}
      {(field.source === "store" || field.source === "env") && (
        <div className="mt-1">
          <ConfirmAction
            // Named for the same reason the Save button is: on a page of three addons there
            // is otherwise a column of identical "Clear"s, and this one is destructive.
            label={`Clear ${field.label}`}
            question={`Clear ${field.label}? It falls back to what this addon ships with, and an environment variable that was seeding it stops applying.`}
            confirmLabel="Yes, clear"
            busyLabel="Clearing…"
            onConfirm={async () => {
              await save(null);
              setDraft("");
            }}
          />
        </div>
      )}
    </div>
  );
}

/** The control the declared kind is typed into. */
function FieldInput({
  id,
  field,
  draft,
  onChange,
}: {
  id: string;
  field: AddonConfigFieldReport;
  draft: string;
  onChange: (next: string) => void;
}) {
  const { type } = field;

  if (type === "boolean") {
    return (
      <select id={id} value={draft} onChange={(e) => onChange(e.target.value)} className={FIELD_BOX}>
        <option value="true">On</option>
        <option value="false">Off</option>
      </select>
    );
  }

  return (
    <input
      id={id}
      name={id}
      type={INPUT_TYPE[type]}
      value={draft}
      onChange={(e) => onChange(e.target.value)}
      // `new-password` and not `off`: a browser offered the chance will otherwise fill a
      // stored credential of its own into a password box, and the operator saves it without
      // noticing. Nothing here is a login.
      autoComplete={type === "secret" ? "new-password" : "off"}
      placeholder={type === "secret" && field.set ? "stored -- type to replace" : undefined}
      className={`${FIELD_BOX} w-64 max-w-full`}
    />
  );
}

/**
 * What the box starts with: the value in effect, and NEVER a secret.
 *
 * There is no secret to start from -- the report carries none -- so the box is empty however
 * long one has been stored, and the status line is what says whether it is set.
 */
function initialDraft(field: AddonConfigFieldReport): string {
  if (field.type === "secret") return "";
  // A select needs one of its own options even when nothing is configured; "off" is the
  // reading of an absent boolean that every addon's own `c.config.boolean()` also gets.
  if (field.type === "boolean") return String(field.value ?? false);
  return field.value === undefined ? "" : String(field.value);
}

/**
 * The draft as the value this field would store, or why it cannot be one.
 *
 * A FLOOR rather than the rule: `parseAddonConfigPatch` on the server refuses the same
 * values with better reasons, and the minimum length of a secret is deliberately NOT
 * repeated here -- it belongs to the redactor and a second copy would be the one that drifts
 * when the floor moves. What is checked here is only what a round trip should not be spent
 * on: an empty box, and text where a number goes.
 */
function parseDraft(
  field: AddonConfigFieldReport,
  draft: string,
): { value: AddonConfigValue } | { error: string } {
  if (field.type === "boolean") return { value: draft === "true" };

  if (field.type === "number") {
    const n = Number(draft);
    // The STRING is tested first, and that is the scar `QuotaField` carries too: `Number("")`
    // is 0, so an empty box would save a deliberate-looking zero nobody typed.
    if (draft.trim() === "" || !Number.isFinite(n)) return { error: "a number" };
    return { value: n };
  }

  if (draft === "") return { error: "type a value, or clear the setting" };
  return { value: draft };
}
