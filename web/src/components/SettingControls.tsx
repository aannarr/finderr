/**
 * The two shapes every admin setting takes: a number you type, and a switch you flip.
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
 */

import { type ReactNode, useId, useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
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
 * A daily title limit, typed and saved.
 *
 * A form rather than a stepper because the value is a NUMBER an operator means, and the
 * validation is checked HERE as well as on the server -- not as the rule (that is
 * `isQuotaValue` in `src/lib/request-quota.ts`) but so that a typo is answered without a round
 * trip. The server refuses the same values with the same reason if this is bypassed.
 *
 * > [!CAUTION] AN EMPTY FIELD IS NOT ZERO, and reading it as zero was a live bug
 * > `Number("")` is `0`, and zero here means UNLIMITED -- so clearing the box and pressing Save
 * > removed the limit rather than saying nothing had been typed. The browser's own `step`/`min`
 * > validation does not catch it (an empty optional field is valid), so this is the ONE case
 * > the check below actually has to catch; a fraction or a negative never reaches the handler
 * > because the input refuses to submit. That is why the guard tests the STRING first.
 *
 * `secondary` is the per-user page's "Follow the site default", which the site-wide field has
 * no equivalent of: there is nothing above a site default to follow.
 */
export function QuotaField(props: {
  /** Unique on the page -- both fields can be on screen at once in principle. */
  id: string;
  label: string;
  /** The value as it stands. The draft starts here; zero renders as "0", never as blank. */
  value: number;
  save: (titlesPerDay: number) => Promise<void>;
  secondary?: { label: string; run: () => Promise<void> };
  /** The sentence under the field, explaining what this number does to whom. */
  children: ReactNode;
}) {
  const [draft, setDraft] = useState(String(props.value));
  const { busy, error, run } = useSaving();
  const [invalid, setInvalid] = useState<string | null>(null);
  // Bound once so the JSX below closes over a value rather than over `props.secondary`, which
  // narrowing cannot follow into a callback.
  const secondary = props.secondary;

  return (
    <div>
      <form
        className="flex flex-wrap items-baseline gap-x-3 gap-y-1"
        onSubmit={(e) => {
          e.preventDefault();
          const n = Number(draft);
          if (draft.trim() === "" || !Number.isInteger(n) || n < 0) {
            setInvalid("a whole number of titles, 0 or more");
            return;
          }
          setInvalid(null);
          run(() => props.save(n));
        }}
      >
        <label htmlFor={props.id} className="text-sm font-medium">
          {props.label}
        </label>
        <Input
          id={props.id}
          name={props.id}
          type="number"
          min={0}
          step={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          // `aria-invalid` is what turns the field itself red, so the message beside it is
          // a second telling rather than the only one.
          aria-invalid={invalid !== null || undefined}
          className="w-24 tabular-nums"
        />
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
        {secondary && (
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => run(secondary.run)}>
            {secondary.label}
          </Button>
        )}
        {(invalid ?? error) && <span className="text-xs text-danger">{invalid ?? error}</span>}
      </form>
      <p className="mt-1.5 text-xs text-muted">{props.children}</p>
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
 * wrong screen. A sighted reader gets that from the heading above it; a screen reader gets it
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
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium">
          {props.label}
        </label>
        <p className="mt-1.5 text-xs text-muted">{props.children}</p>
        {error && <p className="mt-1 text-xs text-danger">{error}</p>}
      </div>
      {/*
        The switch sits at the END of the row rather than beside the label, so a card of
        several settings has one column of controls to run an eye down -- which is the whole
        reason a switch beats a sentence here.
      */}
      <Switch
        id={id}
        checked={props.on}
        disabled={busy}
        aria-label={props.action(props.on)}
        onCheckedChange={(on) => run(() => props.save(on))}
        className="mt-0.5 shrink-0"
      />
    </div>
  );
}
