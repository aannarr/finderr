/**
 * A ruled list of facts: a name on the left, its value on the right, one baseline each.
 *
 * Written for `/admin` health and now also the player's stats panel, which is why it lives
 * here rather than inside either of them. Both surfaces answer the same shape of question --
 * a screen of small measurements somebody is scanning for the ONE they came for -- and the
 * layout is the whole reason it works.
 *
 * `compact` is the panel-over-video shape: small type, no rules, the values in a second grid
 * column rather than pushed to the far edge. Over a moving picture the eye travels from a label to
 * its value, and a full-width rule across a video frame is noise.
 */

import type React from "react";
import { createContext, useContext } from "react";
import { cn } from "../lib/utils";

const Compact = createContext(false);

/**
 * One fact.
 *
 * > [!IMPORTANT] THE COLUMN IS THE POINT, and it is why this is not a sentence
 * > These read `Rows 1,276,669` / `Built Sep 6, 2026` as running prose, label and value in
 * > the same size a word apart, so a screen of twenty of them had no shape at all -- the eye
 * > had to read every line to find the one it wanted. Ruled onto two columns with the values
 * > right-aligned and tabular, a reader scans ONE column and stops at the row they came for.
 * >
 * > **MOST hints name a reading that is WRONG, so they are drawn as alarms.** A refused swap,
 * > a reclaimed prefault, a Plex walk that matched nothing. As a third line of grey they
 * > looked exactly like the two facts above them, which is how a refused index swap sits
 * > unnoticed on a page whose entire job is to report it.
 * >
 * > **`tone: "info"` is for the ones that are NOT.** "The daily refresh has not run in this
 * > process yet" says so and adds *"ordinary for most of a container's life"* -- painting
 * > that yellow puts an alarm on a perfectly healthy server every time it restarts, and an
 * > alarm that is usually nothing is an alarm nobody reads. Which of the two a hint is
 * > belongs to the function that WRITES it, so it travels with the words.
 *
 * `danger` colours the VALUE itself, for a fact whose value is the failure (the last error).
 */
export function Fact(props: {
  label: string;
  value: string;
  hint?: string;
  tone?: "alarm" | "info";
  danger?: boolean;
}) {
  const compact = useContext(Compact);
  const valueClass = cn("tabular-nums", props.danger ? "text-danger" : "text-ink");
  const hint =
    props.hint &&
    ((props.tone ?? "alarm") === "info" ? (
      <p className="text-xs text-muted">{props.hint}</p>
    ) : (
      <p className="rounded-md border border-warn/40 bg-warn/10 px-2 py-1.5 text-xs text-warn">
        {props.hint}
      </p>
    ));

  if (compact) {
    return (
      <li className="contents">
        <span className="text-muted">{props.label}</span>
        <span className={cn(valueClass, "min-w-0 break-words")}>{props.value}</span>
        {hint ? <div className="col-span-2 mb-1">{hint}</div> : null}
      </li>
    );
  }

  return (
    <li className="flex flex-col gap-1 py-1.5 not-last:border-b not-last:border-line/60">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 text-sm">
        <span className="text-muted">{props.label}</span>
        <span className={valueClass}>{props.value}</span>
      </div>
      {hint}
    </li>
  );
}

export function Facts(props: { children: React.ReactNode; compact?: boolean }) {
  if (props.compact) {
    return (
      <Compact.Provider value={true}>
        <ul className="grid grid-cols-[max-content_minmax(0,1fr)] content-start gap-x-4 gap-y-1 text-xs">
          {props.children}
        </ul>
      </Compact.Provider>
    );
  }
  return <ul className="flex flex-col">{props.children}</ul>;
}
