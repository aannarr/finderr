/**
 * The one control that says whether we hold a title, and offers to ask for it if not.
 *
 * Extracted from `TitleCard` when the awards screens became its second caller. The rule it
 * encodes is three-way and easy to get subtly wrong -- owned beats requested, a FAILED
 * request is not the same colour as a pending one, and `no_release` has its own words --
 * so a second copy would have drifted on the first of those three the moment either screen
 * changed. Reuse before you build; the difference between a card and a list row is the
 * `tone` prop, not a fork.
 *
 * `owned` is `inLibrary` and NOT `hasFile`: the arr can be monitoring something it has not
 * downloaded, and "Monitored" is a different answer from "Available" but neither of them
 * is "Request". That distinction is the reason this is a component rather than a ternary.
 */

import type { Title } from "../lib/api";

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
}: {
  title: Title;
  onRequest: (t: Title) => void;
  tone?: RequestTone;
}) {
  const shell = SHELL[tone];

  if (t.inLibrary) {
    return (
      <span className={`${shell} border border-line text-muted`}>
        {t.hasFile ? "Available" : "Monitored"}
      </span>
    );
  }

  if (t.requestStatus !== null) {
    // A failed request and a queued one are both "not yours yet", but only one of them is
    // something the reader can do anything about -- so they are never the same colour.
    const failed = t.requestStatus === "failed" || t.requestStatus === "no_release";
    return (
      <span
        className={`${shell} ${
          failed
            ? "border border-danger/50 bg-danger/10 text-ink"
            : "border border-warn/40 bg-warn/10 text-ink"
        }`}
      >
        {t.requestStatus === "no_release" ? "No release found" : t.requestStatus}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onRequest(t)}
      className={`${shell} bg-accent font-medium text-black transition-opacity hover:opacity-90 active:opacity-75`}
    >
      Request
    </button>
  );
}
