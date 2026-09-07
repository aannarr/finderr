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
 *
 * > [!CAUTION] THE FILE OUTRANKS EVERYTHING; A BARE LIBRARY ROW OUTRANKS NOTHING
 * > This read `if (t.inLibrary)` first until 2026-09-07, which is "owned beats requested" --
 * > and it was wrong in a way nothing on screen admitted. The arr accepts a request within
 * > seconds and `libraryRefreshSeconds` is 60, so about a minute after pressing Request the
 * > card stopped saying "Searching", dropped the progress bar and the ETA, and sat on a grey
 * > "Monitored" until the file landed. Every verdict this component exists to draw was
 * > unreachable for exactly the window a reader is watching. Reported by aannarr from a live
 * > shelf: `Monitored` and `Available` were also the same colour, so the two ends of the
 * > ladder were indistinguishable as well.
 * >
 * > So the order is HAVE IT -> WORKING ON IT -> WATCHING FOR IT -> ASK. `hasFile` is a fact
 * > about the disk and nothing outranks it; a verdict is a fact about an ask somebody made;
 * > `inLibrary` alone means only that the arr is watching, which is the weakest of the three
 * > and therefore last. A monitored title with a dead-end request now shows the dead end
 * > instead of shrugging.
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

  // The file is here. Nothing a request could say refines that, so it is read first and the
  // chip is the quiet one -- an answered question needs no colour.
  if (t.hasFile) {
    return <span className={`${shell} border border-line text-muted`}>Available</span>;
  }

  // A dead end and a request still being worked on are both "not yours yet", but only one of
  // them is something the reader can do anything about -- so they are never the same colour.
  // Which is which is `VERDICT_COPY`'s `tone`, read by `VerdictChip`, which the request log
  // draws too: three surfaces, one table, no branch written out here.
  if (t.requestVerdict !== null) {
    return <VerdictChip verdict={t.requestVerdict} progress={t.requestProgress} shell={shell} />;
  }

  /*
    In the library, no file, and nobody asked through finderr -- the arr is watching on its
    own. An unreleased title a list sync pulled in is the ordinary case, which is why this is
    NOT relabelled "Requested": there is no requester, and `requested_by` makes that a claim
    about a person.

    It wears the SAME tone as a working verdict above, deliberately. Amber here means "keep
    waiting", which is exactly what a monitored title asks of a reader, and the alternative --
    matching "Available" -- is the collision this whole change exists to remove.
  */
  if (t.inLibrary) {
    return <span className={`${shell} border border-warn/40 bg-warn/10 text-ink`}>Monitored</span>;
  }

  return (
    <button
      type="button"
      onClick={() => onRequest(t)}
      /*
        Drawn ONLY for a title that can actually be requested -- every branch above
        returns a `<span>` instead -- which is what lets the keyboard ask "may this be
        requested" by looking for this element rather than re-deriving the four-way rule.
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
