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
import { Skeleton } from "./FacetPane";
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

/**
 * What the front page looks like before `/api/discover` has answered.
 *
 * Without this the first visit is the header, the search box, and a whole screen of
 * nothing -- `SearchRoute` renders `shelves?.map(...)`, which draws literally zero
 * elements while `shelves` is null. The page looked broken, or looked like a search box
 * that had failed to find anything, on the one view where nobody has typed a query yet.
 *
 * > [!IMPORTANT] It lives HERE, beside the real `Shelf`, and that placement is the point
 * > Every measurement below is copied from the component ten lines up: `mb-8` on the
 * > section, `mb-3` on the heading row, the same `shelf-row` list with the same `gap-3`
 * > and `-mx-4 px-4`, and `w-36 sm:w-40 lg:w-44` on each item. A placeholder whose
 * > geometry disagrees with the real thing is a layout SHIFT, which is worse than the
 * > blank screen it replaced -- the content arrives and everything jumps.
 * >
 * > Keeping the two in one file is what makes that survivable. A skeleton in its own
 * > module drifts the first time somebody adjusts a width here and does not think to look
 * > there.
 *
 * The counts are chosen to fill a first screen and no more: three shelves deep enough to
 * reach the fold, six cards wide enough to run off the right edge on a phone. Drawing
 * more would be work nobody sees.
 */
export function ShelfSkeleton() {
  return (
    <output aria-label="Loading" className="block">
      {/* Keyed on the array's VALUE, which is why no `noArrayIndexKey` suppression is
          needed here: these are literal ids that happen to be small integers, in a list
          with a fixed length that never reorders. */}
      {[0, 1, 2].map((row) => (
        <section key={row} className="mb-8">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            {/* Matches the real `h2 text-sm` line box, so the row below starts at the
                same y as it will once the shelf has a name. */}
            <Skeleton className="h-4 w-32" />
          </div>

          <ul className="shelf-row -mx-4 flex snap-x gap-3 overflow-x-hidden px-4 pb-2">
            {[0, 1, 2, 3, 4, 5].map((card) => (
              <li key={card} className="w-36 shrink-0 sm:w-40 lg:w-44">
                {/* The card's own frame: poster block, then the two text lines
                    `TitleCard` reserves. `min-h-[2.5rem]` there is two lines of title,
                    which is why the title placeholder is two bars rather than one. */}
                <div className="overflow-hidden rounded-xl border border-line bg-surface">
                  <Skeleton className="aspect-2/3 w-full rounded-none" />
                  <div className="flex flex-col gap-1 p-2.5">
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-2/3" />
                    <Skeleton className="mt-1 h-3 w-1/2" />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </output>
  );
}
