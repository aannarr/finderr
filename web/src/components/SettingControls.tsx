/**
 * The two shapes every admin setting takes: a daily limit, and a switch you flip.
 *
 * Four call sites and they arrived in two pairs -- the per-person quota and assistant switch on
 * `/admin/users/:id`, and the site-wide defaults for both on `/admin`. The pairs differ only in
 * their WORDS, which is what makes them props rather than four components: a daily title limit
 * is edited the same way whoever it binds, and a second implementation to change a label is the
 * copy that later disagrees about whether 2.5 is a number of titles.
 *
 * What each control owns is the ceremony, and it is the same ceremony both times: disable while
 * the request is in flight, put the SERVER's refusal on the control that provoked it rather than
 * at the top of the page, and leave the reload to the caller. What it does not own is the
 * decision -- neither of these knows what a quota means, and neither may.
 *
 * NO CONFIRMATION on either, deliberately. `ConfirmAction` guards the destructive verbs; a
 * setting is undone by pressing the same button again or retyping a number, and a page where
 * everything asks is a page where nothing is asked.
 *
 * > [!IMPORTANT] THE CONTROL IS ON THE LEFT AND ITS WORDS ARE TO THE RIGHT -- `[control] {text}`
 * > aannarr, 2026-09-07, in as many words. It applies to the radios and to the switch alike, and
 * > the switch previously sat at the far RIGHT of its row on the argument that a card of
 * > settings then has one column of controls to run an eye down. That argument is real and it
 * > loses to a bigger one: a reader binds a control to the label it is NEXT to, and a switch
 * > separated from its own words by a paragraph of explanation is a switch you have to check
 * > twice. One rule for every control on these screens beats a per-control optimisation.
 */

import { type ReactNode, useId, useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";
import { Switch } from "./ui/switch";

/**
 * The in-flight state every control here shares: busy while saving, and the server's own words
 * if it refused.
 *
 * `run` never throws. A rejected save is a message beside the control, not an unhandled
 * rejection that takes the page down -- these are settings, and the failure a person needs to
 * see is "that setting could not be saved", in the place they were looking.
 */
function useSaving(): { busy: boolean; error: string | null; run: (save: () => Promise<void>) => void } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (save: () => Promise<void>): void => {
    setBusy(true);
    setError(null);
    void save()
      .catch((e: unknown) => setError((e as Error).message))
      .finally(() => setBusy(false));
  };

  return { busy, error, run };
}

/**
 * What a daily limit can BE, as a closed set rather than as a number with magic values.
 *
 * - `inherit` -- follow whatever the site says. Only a PERSON can be in this state; there is
 *   nothing above a site default to follow, which is why the site-wide caller does not offer it.
 * - `none` -- no limit at all.
 * - `capped` -- a number, which is the only mode that carries one.
 */
export type QuotaMode = "inherit" | "none" | "capped";

/**
 * Which mode a stored value represents.
 *
 * > [!CAUTION] `0` MEANT UNLIMITED AND THAT IS THE WHOLE REASON THIS COMPONENT WAS REWRITTEN
 * > The field was a bare number with a hint reading *"0 means no limit"*, so the difference
 * > between "nobody is limited" and "everybody may have zero titles" was one character, in a
 * > box, explained in prose underneath. A reader who did not read the hint had no way to tell,
 * > and a reader who did still had to hold it in their head. aannarr, 2026-09-07: *"can we make
 * > it friendly? ... PROPER UI UX PLEASE"*.
 * >
 * > **The wire format is unchanged** -- `null` is still inherit and `0` is still unlimited, and
 * > `src/lib/request-quota.ts` still owns what they mean. This is a rendering of that rule, not
 * > a second copy of it: `modeOf` and `storedFor` are the two halves of one mapping and are
 * > exported so a test can pin that they round-trip.
 */
export function modeOf(stored: number | null): QuotaMode {
  if (stored === null) return "inherit";
  return stored === 0 ? "none" : "capped";
}

/** The value to SEND for a mode. `capped` is the only one that reads the typed number. */
export function storedFor(mode: QuotaMode, typed: number): number | null {
  if (mode === "inherit") return null;
  return mode === "none" ? 0 : typed;
}

/** One radio: the control on the left, its words to the right, on one baseline. */
function Choice({
  value,
  children,
  disabled,
}: {
  value: QuotaMode;
  children: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-2.5">
      <RadioGroupItem value={value} id={id} disabled={disabled} className="mt-0.5 shrink-0" />
      <label htmlFor={id} className="text-sm leading-5">
        {children}
      </label>
    </div>
  );
}

/**
 * A daily title limit, as three named states rather than as a number with magic values.
 *
 * SAVING IS EXPLICIT and it is one button for the whole control. Choosing a radio does not
 * save: `inherit` and `none` would each be a write on a stray click, and `capped` cannot save
 * on selection at all because there is no number typed yet. One Save also means one place for
 * the server's refusal to land.
 *
 * The number field APPEARS with `capped` and is absent otherwise -- aannarr's own shape, and
 * the reason is that a greyed-out number still reads as a value that applies. Nothing shown is
 * nothing to misread.
 *
 * `modes` is what differs between the two callers and is the only thing that does: a person may
 * follow the site, and the site may not follow anything.
 */
export function QuotaField(props: {
  /** Unique on the page -- both fields can be on screen at once in principle. */
  id: string;
  label: string;
  /** The stored value: `null` inherits, `0` is unlimited, a number is the cap. */
  value: number | null;
  /** What `inherit` resolves to, worded for the reader. Omitted where inherit is not offered. */
  inheritLabel?: string;
  save: (value: number | null) => Promise<void>;
  /** The sentence under the control, explaining what this binds. */
  children: ReactNode;
}) {
  const [mode, setMode] = useState<QuotaMode>(modeOf(props.value));
  /**
   * The number, kept as a STRING and remembered across a mode change.
   *
   * A string because an empty box is not zero -- `Number("")` is `0`, and zero here is a
   * different mode entirely, so reading the box as a number is how "I have not typed yet"
   * became "no limit". Remembered because switching to `none` and back should not silently
   * wipe what somebody had typed; the draft outlives the radio.
   *
   * It seeds from a stored cap, or from an empty box when there is not one to seed from.
   */
  const [draft, setDraft] = useState(props.value !== null && props.value > 0 ? String(props.value) : "");
  const { busy, error, run } = useSaving();
  const [invalid, setInvalid] = useState<string | null>(null);
  const numberId = `${props.id}-per-day`;

  const stored = modeOf(props.value);
  // Nothing to save until something differs from what the server already holds. A Save that is
  // always live invites a write that changes nothing and reloads the page for it.
  const changed = mode !== stored || (mode === "capped" && draft.trim() !== String(props.value ?? ""));

  return (
    <div>
      <fieldset>
        <legend className="text-sm font-medium">{props.label}</legend>

        <form
          className="mt-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (mode === "capped") {
              const n = Number(draft);
              // The STRING is tested first, deliberately: an empty box is the one invalid
              // value the browser's own `min`/`step` validation calls valid.
              if (draft.trim() === "" || !Number.isInteger(n) || n < 1) {
                setInvalid("a whole number, 1 or more");
                return;
              }
            }
            setInvalid(null);
            run(() => props.save(storedFor(mode, Number(draft))));
          }}
        >
          <RadioGroup
            value={mode}
            onValueChange={(v) => setMode(v as QuotaMode)}
            disabled={busy}
            className="gap-2.5"
          >
            {props.inheritLabel && <Choice value="inherit">{props.inheritLabel}</Choice>}
            <Choice value="none">No limit</Choice>
            <Choice value="capped">Limit the number of requests a day</Choice>
          </RadioGroup>

          {/*
            Indented under its own radio, because it belongs to that choice and to no other.
            The margin lines it up with the radio labels above rather than with the radios.
          */}
          {mode === "capped" && (
            <div className="mt-2.5 ml-6 flex flex-wrap items-center gap-2">
              <Input
                id={numberId}
                name={numberId}
                type="number"
                min={1}
                step={1}
                value={draft}
                // Autofocused because this field only exists once somebody has chosen the
                // radio above it -- they are already reaching for it.
                // biome-ignore lint/a11y/noAutofocus: it appears on an explicit choice, never on load
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
                aria-invalid={invalid !== null || undefined}
                aria-label="Requests a day"
                className="w-20 tabular-nums"
              />
              <label htmlFor={numberId} className="text-sm text-muted">
                a day
              </label>
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button type="submit" size="sm" disabled={busy || !changed}>
              {busy ? "Saving…" : "Save"}
            </Button>
            {(invalid ?? error) && <span className="text-xs text-danger">{invalid ?? error}</span>}
          </div>
        </form>
      </fieldset>

      <p className="mt-2.5 text-xs text-muted">{props.children}</p>
    </div>
  );
}

/**
 * A setting that is on or off, flipped by a real switch.
 *
 * > [!IMPORTANT] IT WAS A LINK READING "Turn off for this person", and the switch is not a restyle
 * > A boolean drawn as a text link has to state the INVERSE of its own value to be useful --
 * > the words on screen describe the state you are NOT in. That reads backwards, it cannot be
 * > scanned down a column of settings, and there is nothing on the page saying which way the
 * > setting currently points except by implication. A switch shows the STATE, which is the
 * > thing a reader came for, and the action is the affordance rather than the label.
 *
 * **`action` survives as the ACCESSIBLE name and is still a prop**, because the two live
 * instances mean different things -- one is about a person, the other about every account made
 * from now on -- and a switch announced only as "Assistant" is a switch somebody flips on the
 * wrong screen. A sighted reader gets that from the label beside it; a screen reader gets it
 * from here.
 */
export function ToggleSetting(props: {
  label: string;
  on: boolean;
  /** What pressing it does, given the current state. e.g. `(on) => on ? "Turn off" : "Turn on"`. */
  action: (on: boolean) => string;
  save: (on: boolean) => Promise<void>;
  /** The sentence under it, which states what the CURRENT setting means rather than the button. */
  children: ReactNode;
}) {
  const { busy, error, run } = useSaving();
  // `useId` rather than a caller-supplied one: unlike `QuotaField` there is nothing here a
  // caller needs to address, and two of these are on screen together on `/account`.
  const id = useId();

  return (
    <div className="flex items-start gap-2.5">
      {/* Control LEFT, words right -- the rule at the top of this file. */}
      <Switch
        id={id}
        checked={props.on}
        disabled={busy}
        aria-label={props.action(props.on)}
        onCheckedChange={(on) => run(() => props.save(on))}
        className="mt-0.5 shrink-0"
      />
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium">
          {props.label}
        </label>
        <p className="mt-1 text-xs text-muted">{props.children}</p>
        {error && <p className="mt-1 text-xs text-danger">{error}</p>}
      </div>
    </div>
  );
}
