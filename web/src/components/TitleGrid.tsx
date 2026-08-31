/**
 * The one grid.
 *
 * Search results, discover shelves, genre browse, and every discovery view still to
 * come (person, decade, franchise, curated list) are the same thing: a header
 * describing a filter, then a grid of titles. Building it once is what makes each new
 * edge in the discovery graph cheap instead of another bespoke page.
 */

import { memo } from "react";
import type { Title } from "../lib/api";
import { useApp } from "../lib/app-context";
import { TitleCard } from "./TitleCard";

export const TitleGrid = memo(function TitleGrid({ titles }: { titles: Title[] }) {
  const { request } = useApp();
  return (
    <div className="card-grid grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {titles.map((t) => (
        <TitleCard key={t.tconst} title={t} onRequest={request} />
      ))}
    </div>
  );
});

/**
 * A named shelf: one HORIZONTALLY SCROLLING row of titles.
 *
 * A row, not a wrapping grid. A grid of 30 pushes every later shelf off the screen,
 * so you can only ever see one -- the whole point of shelves is that you scan several
 * without scrolling past any of them.
 *
 * `snap-x` so a flick lands on a card edge rather than mid-poster, and the scrollbar
 * is hidden because a visible one under every row is noise (keyboard and trackpad
 * scrolling still work, and each card is focusable, so this is not a keyboard trap).
 */
export function Shelf({
  title,
  subtitle,
  titles,
  action,
}: {
  title: string;
  subtitle?: string;
  titles: Title[];
  action?: React.ReactNode;
}) {
  if (titles.length === 0) return null;
  return (
    <section className="mb-8">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="text-sm font-medium text-ink">{title}</h2>
          {subtitle && <span className="truncate text-xs text-muted">{subtitle}</span>}
        </div>
        {action}
      </div>

      {/* A real ul/li: a shelf IS a list, and the semantics come free. */}
      <ul className="shelf-row -mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2">
        {titles.map((t) => (
          <li key={t.tconst} className="w-36 shrink-0 snap-start sm:w-40 lg:w-44">
            <ShelfCard title={t} />
          </li>
        ))}
      </ul>
    </section>
  );
}

const ShelfCard = memo(function ShelfCard({ title }: { title: Title }) {
  const { request } = useApp();
  return <TitleCard title={title} onRequest={request} />;
});
