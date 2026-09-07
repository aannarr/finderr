/**
 * A titled card, with an optional control in its header.
 *
 * > [!NOTE] Why this is NOT `Pane variant="panel"`, which is the same bordered box
 * > `Pane` is the title page's furniture and three of its decisions are wrong here rather
 * > than merely different: it hardcodes `mt-8` (these cards sit in a `flex gap` column and a
 * > grid, where a top margin fights the container), it draws an `<h3>` (an admin screen's
 * > `<h1>` is the person, so its sections are `<h2>` and a jump from h1 to h3 is a real
 * > outline defect), and it has nowhere to put the "Invite someone" button a card header
 * > wants. Bending it would take three props to make one component serve two layout systems,
 * > which is a fork wearing prop clothing.
 * >
 * > What is NOT duplicated is the look: the border, radius, surface and padding are copied
 * > from `PANE_CHROME.panel` on purpose so the two read as one product. If that chrome is
 * > ever restyled, this is the second place to change -- which is the price of the split and
 * > is stated here rather than discovered.
 */

import type { ReactNode } from "react";

export function Panel({
  title,
  description,
  action,
  children,
}: {
  title: ReactNode;
  /** One line under the heading saying what the card is FOR, where that is not obvious. */
  description?: ReactNode;
  /** A control that belongs to the whole card -- "Invite someone", "Refresh". */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-ink">{title}</h2>
          {description && <p className="mt-1 text-xs text-muted">{description}</p>}
        </div>
        {action}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/**
 * The sentence a card shows instead of an empty list.
 *
 * Its own component because there are six of them across these screens and they were six
 * different paddings; an empty state that shifts the page as you move between people is the
 * kind of thing that reads as a bug in the data rather than in the layout.
 */
export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-2 text-sm text-muted">{children}</p>;
}
