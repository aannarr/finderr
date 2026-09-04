/**
 * The one control that says whether we hold a title, and offers to ask for it if not.
 *
 * Extracted from `TitleCard` when the awards screens became its second caller. The rule it
 * encodes is three-way and easy to get subtly wrong -- owned beats requested, a dead end is
 * not the same colour as a request still being worked on, and each state has its own words
 * -- so a second copy would have drifted on the first of those three the moment either
 * screen changed. Reuse before you build; the difference between a card and a list row is
 * the `tone` prop, not a fork.
 *
 * The words and the colour BOTH come from `VERDICT_COPY`, which the title page's panel also
 * reads. This component used to spell out "no_release" -> "No release found" and so did
 * `TitleRoute`; they are one table now.
 *
 * `owned` is `inLibrary` and NOT `hasFile`: the arr can be monitoring something it has not
 * downloaded, and "Monitored" is a different answer from "Available" but neither of them
 * is "Request". That distinction is the reason this is a component rather than a ternary.
 */

import type { Title } from "../lib/api";
import { VerdictChip } from "./RequestProgress";

/**
 * `block` fills its container -- a card's footer. `inline` is a chip sized to its text, for
 * a list row where the control sits at the end of a line rather than under a poster.
 */
export type RequestTone = "block" | "inline";

const SHELL: Record<RequestTone, string> = {
  block: "block w-full rounded-lg px-2 py-1.5 text-center text-xs",
  inline: "inline-block shrink-0 rounded-md px-2 py-0.5 text-[0.7rem] leading-5",
};

export function RequestAction({
  title: t,
  onRequest,
  tone = "block",
  shortcut,
}: {
  title: Title;
  onRequest: (t: Title) => void;
  tone?: RequestTone;
  /**
   * The `aria-keyshortcuts` value for a key that requests THIS title while it is focused.
   *
   * A prop rather than a `useKeyAction` here, because a grid draws sixty of these and each
   * one would otherwise hang its own global listener for a key only the focused card may
   * answer. The grid that owns the handler is the one place that knows the key is live, so
   * it is the one place that says so -- a list row on an awards page passes nothing and
   * announces nothing, which is the truth there.
   */
  shortcut?: string;
}) {
  const shell = SHELL[tone];

  if (t.inLibrary) {
    return (
      <span className={`${shell} border border-line text-muted`}>
        {t.hasFile ? "Available" : "Monitored"}
      </span>
    );
  }

  // A dead end and a request still being worked on are both "not yours yet", but only one of
  // them is something the reader can do anything about -- so they are never the same colour.
  // Which is which is `VERDICT_COPY`'s `tone`, read by `VerdictChip`, which the request log
  // draws too: three surfaces, one table, no branch written out here.
  if (t.requestVerdict !== null) {
    return <VerdictChip verdict={t.requestVerdict} progress={t.requestProgress} shell={shell} />;
  }

  return (
    <button
      type="button"
      onClick={() => onRequest(t)}
      /*
        Drawn ONLY for a title that can actually be requested -- the two branches above
        return a `<span>` instead -- which is what lets the keyboard ask "may this be
        requested" by looking for this element rather than re-deriving the three-way rule.
        See `CARD_REQUEST_SELECTOR` in `lib/card-dom.ts`.
      */
      data-card-request=""
      aria-keyshortcuts={shortcut}
      className={`${shell} bg-accent font-medium text-black transition-opacity hover:opacity-90 active:opacity-75`}
    >
      Request
    </button>
  );
}
