/**
 * How a person is drawn as a tile: a portrait or their initials, at one size.
 *
 * Its own module because there are two surfaces now -- the cast row on a title page and the
 * people row on `/search` -- and they must not drift apart. A second copy sized `w-24` here
 * and `w-28` there is the kind of difference nobody notices until the two rows appear on
 * consecutive screens.
 *
 * The measurements live with the component rather than at each call site for the same
 * reason `ShelfSkeleton` keeps its copies beside `Shelf`: a row and its tile are one
 * decision about how much of the screen a scannable list gets.
 */

import { initialsOf, localImageUrl } from "../lib/facet-panes";

/**
 * A row, not a wrapping grid: a grid of thirty portraits pushes every later pane off the
 * screen. `shelf-row` is the same hidden-scrollbar treatment the discovery shelves use.
 */
export const PERSON_ROW_CLASS = "shelf-row flex snap-x gap-3 overflow-x-auto pb-2";
export const PERSON_TILE_CLASS = "w-24 shrink-0 snap-start";
export const PERSON_PORTRAIT_CLASS = "aspect-2/3 w-full rounded-lg";

/**
 * A headshot, or the person's initials.
 *
 * `localImageUrl` is what keeps an upstream provider URL out of the browser: finderr is
 * internet-facing while its providers are an implementation detail. The server rewrites
 * headshots to its own `/img/f/<key>`, so this normally draws a face; initials remain the
 * fallback for a person the provider had no picture of.
 */
export function PersonPortrait({ name, image }: { name: string; image: string | null }) {
  const src = localImageUrl(image);
  if (src) {
    return (
      <img
        src={src}
        alt=""
        loading="lazy"
        className={`${PERSON_PORTRAIT_CLASS} border border-line object-cover`}
      />
    );
  }
  return (
    <div
      className={`${PERSON_PORTRAIT_CLASS} flex items-center justify-center border border-line bg-surface text-sm text-muted`}
      aria-hidden="true"
    >
      {initialsOf(name)}
    </div>
  );
}
