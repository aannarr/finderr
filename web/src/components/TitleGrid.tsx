/**
 * The one grid.
 *
 * Search results, discover shelves, genre browse, and every discovery view still to
 * come (person, decade, franchise, curated list) are the same thing: a header
 * describing a filter, then a grid of titles. Building it once is what makes each new
 * edge in the discovery graph cheap instead of another bespoke page.
 */

import { type KeyboardEvent, memo, type ReactNode } from "react";
import type { Title } from "../lib/api";
import { useApp } from "../lib/app-context";
import { CARD_LINK_SELECTOR, CARD_REQUEST_SELECTOR, CARD_SELECTOR } from "../lib/card-dom";
import { ariaKeyShortcuts, HOST_PLATFORM, KEYMAP, matchesBinding } from "../lib/keymap";
import { Skeleton } from "./FacetPane";
import { moveRovingFocus, type RovingItems } from "./RovingFocus";
import { TitleCard } from "./TitleCard";

/**
 * The one grid class list, shared with `GridSkeleton` so the two cannot drift apart.
 *
 * It led with `card-grid`, which existed for one rule -- `content-visibility: auto` -- and
 * that rule is gone because it broke Back on every grid in the product. `styles.css` carries
 * the measurement above where the rule used to be. The hook is dropped with it rather than
 * left behind as a class nothing styles.
 */
const GRID_CLASS = "grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5";

/** Arrows move between CARDS; the element that takes focus is the card's primary link. */
const CARD_ITEMS: RovingItems = { selector: CARD_SELECTOR, focusable: CARD_LINK_SELECTOR };

/** Announced on every card's request button, from the same binding the handler matches. */
const REQUEST_SHORTCUT = ariaKeyShortcuts(KEYMAP.request, HOST_PLATFORM);

/**
 * Drive a grid or a shelf from the keyboard: arrows move, `⌘⏎` asks for what has focus.
 *
 * Plain `Enter` is deliberately not handled. Focus lands on the card's own link, and the
 * browser has followed a focused link on Enter since before any of us started -- a handler
 * here would be a second implementation of the one thing already working, and `firesFrom`
 * already keeps the page-level `loadMore` off a focused link for the same reason.
 *
 * `⌘⏎` is handled, because nothing else could be: it is the app's `request` action, but the
 * grid draws sixty requestable titles and a global binding cannot say which one is meant.
 * Focus is what says so. It presses the card's OWN request button rather than calling
 * `request` with the row it rendered, which is not squeamishness -- `RequestAction` draws
 * that button only for a title that can actually be requested, so pressing it inherits
 * "owned beats requested, a dead end is not a retry" instead of re-deriving it here.
 *
 * `Shelf` shares this handler. A row is a grid with one line in it, which is exactly what
 * `columnsInGrid` reports for a flex container, so ↑ and ↓ decline to move and scroll the
 * page -- the only way to reach the next shelf.
 *
 * The related-titles row on the title page draws these same cards and deliberately does NOT
 * get this: ← and → are bound there to step the season selector, and two meanings for one
 * key on one screen is the collision this file exists on the right side of.
 */
function onCardKeyDown(event: KeyboardEvent<HTMLElement>): void {
  if (matchesBinding(event, KEYMAP.request, HOST_PLATFORM)) {
    const card = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(CARD_SELECTOR);
    const button = card?.querySelector<HTMLElement>(CARD_REQUEST_SELECTOR);
    if (!button) return;
    // Without this the browser opens the focused link in a new tab, which is what ⌘⏎ means
    // to it -- so the request would land AND the reader would lose the page.
    event.preventDefault();
    button.click();
    return;
  }
  // A modified arrow is the browser's (⌘← is Back on a Mac), and `⌘/` opens navigation
  // mode from anywhere; swallowing either would make the grid a trap.
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (moveRovingFocus(event.currentTarget, CARD_ITEMS, event.key)) event.preventDefault();
}

export const TitleGrid = memo(function TitleGrid({
  titles,
  onOpen,
}: {
  titles: Title[];
  /**
   * A card in THIS grid was opened, with its position.
   *
   * The position is passed here rather than looked up by the caller because the grid is what
   * decides the order -- asking a route to find a title's index in the array it just handed
   * over would be a second copy of the ranking, and the copy is what goes wrong when a grid
   * later filters or reorders. Only `SearchRoute` supplies it.
   */
  onOpen?: (title: Title, rank: number) => void;
}) {
  const { request } = useApp();
  return (
    /*
      The handler does not make this container a control -- it delegates to the cards' own
      links and buttons, which are what a reader focuses and what the browser activates. A
      `role` to satisfy the rule would be a lie: this is not a `grid` widget with rows and
      gridcells, it is a plain list of links whose arrow keys have been taught the layout.
    */
    // biome-ignore lint/a11y/noStaticElementInteractions: the focusable children are the controls; see above
    <div className={GRID_CLASS} onKeyDown={onCardKeyDown}>
      {titles.map((t, rank) => (
        <TitleCard
          key={t.tconst}
          title={t}
          onRequest={request}
          onOpen={onOpen && (() => onOpen(t, rank))}
          requestShortcut={REQUEST_SHORTCUT}
        />
      ))}
    </div>
  );
});

/**
 * What a search looks like before its FIRST results exist.
 *
 * Beside the real grid and sharing its class list for the reason `ShelfSkeleton` spells out
 * at length: a placeholder whose geometry disagrees with the real thing is a layout SHIFT,
 * which is worse than the blank screen it replaces.
 *
 * Only for the first query of a session, or the first after clearing the box. A search that
 * is REFINING already has results on screen and keeps them -- replacing a grid the reader is
 * reading with a wall of grey boxes on every keystroke is the flicker this whole change
 * exists to remove.
 */
export function GridSkeleton({ count = 10 }: { count?: number }) {
  return (
    <output aria-label="Searching" className="block">
      <div className={GRID_CLASS}>
        {Array.from({ length: count }, (_, i) => i).map((i) => (
          // Same frame as `TitleCard`: poster block, two title lines, one meta line.
          <div key={i} className="overflow-hidden rounded-xl border border-line bg-surface">
            <Skeleton className="aspect-2/3 w-full rounded-none" />
            <div className="flex flex-col gap-1 p-2.5">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="mt-1 h-3 w-1/2" />
            </div>
          </div>
        ))}
      </div>
    </output>
  );
}

/**
 * The answer already on screen, kept there while its replacement is in flight.
 *
 * Stale-while-revalidate, drawn. A reader who refines a search or picks a role has a grid
 * in front of them and wants the NEXT one; taking this one away in the meantime replaces
 * something readable with nothing, and -- on a page whose controls sit above the grid --
 * unmounts the control they just pressed, which takes their focus with it.
 *
 * Fade rather than a skeleton, because the rows are still true: they are the previous
 * question's answer, not a placeholder for this one. `aria-busy` says the same thing to a
 * screen reader, and `motion-reduce` drops the transition for anyone who asked for that.
 *
 * Lives here, beside `GridSkeleton`, because the two are the pair: a skeleton for a view
 * with nothing to keep, this for a view with something.
 */
const STALE_CLASS = "opacity-50 transition-opacity duration-150 motion-reduce:transition-none";

export function StaleResults({ stale, children }: { stale: boolean; children: ReactNode }) {
  return (
    <div aria-busy={stale} className={stale ? STALE_CLASS : undefined}>
      {children}
    </div>
  );
}

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
      {/* Same handler as the grid, and the same reasoning: the keys act on the cards' own
          links rather than on the list. */}
      <ul
        className="shelf-row -mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2"
        onKeyDown={onCardKeyDown}
      >
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
  return <TitleCard title={title} onRequest={request} requestShortcut={REQUEST_SHORTCUT} />;
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
