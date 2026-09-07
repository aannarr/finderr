/**
 * THE SETTINGS IDIOM: a labelled section, and rows inside it.
 *
 * This is the template every settings-shaped screen in finderr is built from, and it exists
 * because the version before it was five identical bordered cards stacked down the page, each
 * a heading over a grey sentence over a control. aannarr, 2026-09-07: *"generic, random
 * slop"*, and he was right about the mechanism -- uniform weight is the absence of a design.
 * Nothing on that page told you what mattered, because everything was drawn as if it did.
 *
 * ## THE THREE ACTION ZONES, and every verb belongs to exactly one
 *
 * A control's zone is decided by WHAT IT ACTS ON, and nothing else. Get that right and the
 * placement, the emphasis and the confirmation all follow without a second decision.
 *
 * - **Zone 1, the add action.** Subject is the SECTION. It goes at the END of the list,
 *   left-aligned, in the reading flow -- and it is always ADDITIVE ("Add this device",
 *   "Create a key"). A destructive verb may never live here: it is the one control a reader
 *   can press having read only a noun.
 * - **Zone 2, the row action.** Subject is THAT ROW. Right-aligned inside a FIXED-WIDTH
 *   column, safe verbs first, destructive last and always confirmed.
 * - **Zone 3, the page action.** Subject is the whole page -- "Sign out". Bottom, alone,
 *   with nothing under it.
 *
 * > [!CAUTION] ZONE 1 WAS TOP-RIGHT ON THE SECTION RULE, and that was wrong on a wide screen
 * > aannarr, 2026-09-07: *"why is the create button ALLL THE WAY to the right? should it not
 * > be just under the list of existing keys, or if no keys, just a button?"* -- and he is
 * > right. Top-right is a CARD convention and it works because a card is bounded: the button
 * > is a few hundred pixels from the thing it adds to. These sections are full width, so on a
 * > wide monitor the same slot puts "Create" two thousand pixels from the list it appends to,
 * > and the eye has to travel the width of the screen between reading the list and acting on
 * > it.
 * >
 * > Under the list it is where the reading ends. And where a section is EMPTY it becomes the
 * > whole call to action -- a sentence explaining what a key is for, with the button that
 * > makes one directly beneath it, is far stronger than that sentence and a distant control
 * > the reader has to connect for themselves.
 * >
 * > This holds because these lists are SHORT -- passkeys, sessions, keys, a handful each. A
 * > list of two hundred rows would want the button pinned where it can be reached without
 * > scrolling, and that is the version of this rule to revisit if one ever appears.
 *
 * ## WHY THE ACTION COLUMN IS A FIXED WIDTH
 *
 * This is the single change that stops a list reading as slop, and it is worth stating plainly
 * because the obvious implementation does not do it. With `justify-between`, every row's
 * buttons land wherever that row's text stopped -- so "Remove" sits at a different x on every
 * line and the eye has to hunt for it. A fixed column means one vertical line of controls the
 * whole way down, which is what makes a list scannable rather than merely aligned-ish.
 *
 * True column alignment across siblings would want one CSS grid over all the rows with
 * `display: contents` on each -- and that forfeits per-row borders and backgrounds, which
 * these rows need. A fixed width is the same result for this content and costs nothing.
 *
 * Below `sm` the column becomes full width and wraps under the text: 12rem of buttons beside a
 * device name on a phone leaves neither of them readable.
 */

import type { ReactNode } from "react";

/**
 * The row's action column. Exported because `Row`'s callers build their own contents and the
 * INLINE CONFIRM has to occupy exactly the same box -- see `ConfirmAction`'s `inline` variant,
 * which swaps two buttons in here without the row changing size.
 */
export const ACTION_COL = "flex shrink-0 items-center justify-end gap-2 sm:w-48";

export function Section({
  label,
  add,
  children,
}: {
  label: string;
  /** ZONE 1. Additive only, and it lands UNDER the list -- see the note at the top. */
  add?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mt-8 first:mt-0">
      {/*
        The heading carries the label and nothing else. It was a flex row with the action
        pushed to the far edge; see the zone-1 caution above for why that moved.
      */}
      <h2 className="border-b border-line pb-2 text-xs font-medium uppercase tracking-wider text-muted">
        {label}
      </h2>
      <div className="mt-3">{children}</div>
      {/*
        Left-aligned under the list, so it starts where every row's title starts and the eye
        runs straight down onto it. `mt-3` matches the gap above, so the button reads as the
        next item in the list rather than as furniture attached to the section's bottom edge.
      */}
      {add && <div className="mt-3">{add}</div>}
    </section>
  );
}

/**
 * One row: an icon, two lines of text, and the action column.
 *
 * TWO LINES ALWAYS, and the second is muted. The thing being acted on goes on top at full
 * contrast and everything about it goes underneath -- so a column of names reads as a column
 * of names rather than as sentences that happen to start with one. The old rows put both on
 * one line separated by a middot, which made "MacBook Pro" and "added 1 Aug" the same
 * sentence and gave the eye nothing to run down.
 *
 * `note` is for the thing that is WRONG with this row -- a passkey that dies with its device.
 * It is a third line rather than a clause in the second, and it carries its own colour,
 * because a warning that reads like metadata is a warning nobody acts on.
 *
 * > [!CAUTION] A ROW SWAPPING TO ITS QUESTION MUST KEEP EVERY LINE IT HAD, or the fix is undone
 * > The first draft dropped `note` while asking, on the reasoning that a warning about a
 * > device you are removing is no longer the point. Measured in a browser: the agent-key row
 * > went from **82px to 62px** the instant Revoke was pressed -- so the row shrank, everything
 * > under it jumped up, and the inline variant reintroduced exactly the shift it exists to
 * > prevent. `meta` is SWAPPED for the question rather than added to, and `note` stays; that
 * > is what keeps the box the same size. Anything a row hides while asking has to be replaced
 * > by something the same height.
 */
export function Row({
  icon,
  title,
  meta,
  note,
  action,
}: {
  icon?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  /** Drawn in `warn`, on its own line. Only where something is actually wrong. */
  note?: ReactNode;
  /** ZONE 2. Safe verbs first, destructive last. */
  action?: ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line/60 py-3 last:border-0">
      {icon && <span className="shrink-0 text-muted [&_svg]:size-4">{icon}</span>}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-ink">{title}</div>
        {meta && <div className="mt-0.5 text-xs text-muted">{meta}</div>}
        {note && <div className="mt-1 text-xs text-warn">{note}</div>}
      </div>
      {action && <div className={ACTION_COL}>{action}</div>}
    </li>
  );
}

export function Rows({ children }: { children: ReactNode }) {
  return <ul className="flex flex-col">{children}</ul>;
}

/**
 * What a section says instead of an empty list.
 *
 * It states the CONSEQUENCE rather than the absence: "no passkeys" is a fact a reader can do
 * nothing with, and "add one so you are not relying on a single way in" is the same fact with
 * the reason to act attached. Every empty state on these screens is written that way.
 */
export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-3 text-sm text-muted">{children}</p>;
}
