/**
 * A ruled list of facts: a name on the left, its value on the right, one baseline each.
 *
 * Written for `/admin` health and now also the player's stats panel, which is why it lives
 * here rather than inside either of them. Both surfaces answer the same shape of question --
 * a screen of small measurements somebody is scanning for the ONE they came for -- and the
 * layout is the whole reason it works.
 */

import type React from "react";

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
 */
export function Fact(props: { label: string; value: string; hint?: string; tone?: "alarm" | "info" }) {
  return (
    <li className="flex flex-col gap-1 py-1.5 not-last:border-b not-last:border-line/60">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 text-sm">
        <span className="text-muted">{props.label}</span>
        <span className="tabular-nums text-ink">{props.value}</span>
      </div>
      {props.hint &&
        ((props.tone ?? "alarm") === "info" ? (
          <p className="text-xs text-muted">{props.hint}</p>
        ) : (
          <p className="rounded-md border border-warn/40 bg-warn/10 px-2 py-1.5 text-xs text-warn">
            {props.hint}
          </p>
        ))}
    </li>
  );
}

export function Facts(props: { children: React.ReactNode }) {
  return <ul className="flex flex-col">{props.children}</ul>;
}
