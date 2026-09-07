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

import { type ReactNode, useState } from "react";
import { LINK_BUTTON } from "../lib/ui";
import { useSaving } from "../lib/use-saving";

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
        <label htmlFor={props.id} className="text-sm">
          {props.label}
        </label>
        <input
          id={props.id}
          name={props.id}
          type="number"
          min={0}
          step={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="w-20 rounded-lg border border-line bg-surface px-2 py-1 text-sm tabular-nums"
        />
        <button type="submit" disabled={busy} className={LINK_BUTTON}>
          {busy ? "Saving…" : "Save"}
        </button>
        {secondary && (
          <button type="button" disabled={busy} onClick={() => run(secondary.run)} className={LINK_BUTTON}>
            {secondary.label}
          </button>
        )}
        {(invalid ?? error) && <span className="text-xs text-danger">{invalid ?? error}</span>}
      </form>
      <p className="mt-1 text-xs text-muted">{props.children}</p>
    </div>
  );
}

/**
 * A setting that is on or off, flipped by a button that says what pressing it would do.
 *
 * The button's words are a prop rather than "On"/"Off", because the two live instances mean
 * different things -- one is about a person, the other about every account made from now on --
 * and a switch whose label does not say who it affects is a switch somebody flips twice.
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

  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm">{props.label}</span>
        <button
          type="button"
          disabled={busy}
          onClick={() => run(() => props.save(!props.on))}
          className={LINK_BUTTON}
        >
          {busy ? "Saving…" : props.action(props.on)}
        </button>
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
      <p className="mt-1 text-xs text-muted">{props.children}</p>
    </div>
  );
}
