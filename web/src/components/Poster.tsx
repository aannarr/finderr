/**
 * The one thing that draws a poster.
 *
 * Four screens were drawing one before this existed and no two agreed: the grid card had a
 * gradient tile with a monogram and a fade-in, the title page had a bordered box saying "No
 * artwork", the awards timeline had a blank rounded frame, and the ceremony page had none at
 * all. Each was right for its own screen and each had re-decided the same three questions --
 * what fills the space before the image arrives, what happens when there is no image, and
 * what happens when the fetch fails.
 *
 * Those three answers live here now. **The differences between the call sites are PROPS**:
 * `fallback` picks what fills an empty frame, `className` is the caller's frame, and `link`
 * says whether the poster is also a way in. A fifth screen wanting a poster should add a
 * prop here rather than a fifth `<img>`.
 *
 * > [!IMPORTANT] The frame is ALWAYS drawn, and that is the point rather than a detail
 * > Every branch below renders a box of the same size, including the one where there is no
 * > poster and the one where loading it failed. A poster that appears only on success makes
 * > the row above it jump when the image lands and makes a whole grid reflow when it does
 * > not -- so the space is reserved unconditionally and the image fades in over it. The
 * > `aspect-2/3` lives in the default `className` for the same reason: a caller that sizes
 * > by width alone still gets a box of known height before anything is fetched.
 *
 * HOVER IS DELIBERATELY NOT HERE YET. It is coming (aannarr, 2026-09-01) and this is where
 * it goes: one `group`/`group-hover` rule on the frame, applying to every poster in the
 * product at once. That is most of the reason this component exists now rather than after
 * the fourth copy.
 */

import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { posterUrl, type Title } from "../lib/api";

/**
 * The fallback tile's monogram.
 *
 * Posters resolve through the arr metadata proxies, but not every title has one -- the long
 * tail of the IMDb index is full of things nobody has ever made art for. The tile is the
 * permanent background, not a loading state, so those cards look deliberate rather than
 * broken.
 *
 * Moved here from `TitleCard` when this component took over the drawing; it is not used
 * anywhere else and has no reason to be exported.
 */
function initials(t: string): string {
  return t
    .replace(/^(the|a|an) /i, "")
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

/** Deterministic hue per title so a grid is varied but stable across renders. */
function hue(tconst: string): number {
  let h = 0;
  for (let i = 0; i < tconst.length; i++) h = (h * 31 + tconst.charCodeAt(i)) % 360;
  return h;
}

/**
 * What fills the frame when there is no image to show.
 *
 * Three answers because the three screens genuinely want different things, not because
 * nobody could decide. A grid card is MOSTLY poster, so an empty one needs to look
 * intentional (`tile`). A row 40 pixels wide has no room for a monogram and a strip of
 * coloured squares beside a list of names is noise, so it stays quiet (`plain`). The title
 * page is a single large box where silence reads as broken, so it says what happened
 * (`label`).
 */
export type PosterFallback = "tile" | "plain" | "label";

export interface PosterProps {
  /** The row. `undefined` is a title we do not index, and draws an empty frame. */
  title?: Title | null;
  /** TMDB size hint. Match it to the rendered width -- a 40px row does not want `w342`. */
  size?: string;
  /** The FRAME: sizing, rounding, border. The caller owns layout; this component owns fill. */
  className?: string;
  fallback?: PosterFallback;
  /** Wrap the poster in a link to the title. Ignored when there is no row to link to. */
  link?: boolean;
  /**
   * Load immediately instead of lazily.
   *
   * Off by default because most posters are in a long grid or a list of 140 nominations.
   * The title page's own poster sets it: it is the largest thing above the fold and
   * deferring it is the one case where lazy loading is visibly worse.
   */
  eager?: boolean;
  /** Accessible name. Posters are decorative by default -- the title is already in the DOM. */
  alt?: string;
}

export function Poster({
  title,
  size = "w342",
  className = "aspect-2/3 w-full overflow-hidden rounded-xl bg-surface-2",
  fallback = "plain",
  link = false,
  eager = false,
  alt = "",
}: PosterProps) {
  const src = title ? posterUrl(title, size) : null;

  // The image is tracked in state rather than hidden with CSS alone, because a poster whose
  // fetch 404s must fall back to the frame instead of leaving a broken-image glyph. Both
  // flags reset naturally when React remounts the node for a different title.
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const body = (
    <>
      {fallback === "tile" && title && (
        <span
          className="absolute inset-0 flex items-center justify-center"
          style={{
            background: `linear-gradient(155deg, oklch(0.32 0.07 ${hue(title.tconst)}), oklch(0.20 0.03 ${hue(title.tconst)}))`,
          }}
        >
          <span className="text-3xl font-bold tracking-tight text-white/25 select-none">
            {initials(title.title)}
          </span>
        </span>
      )}

      {fallback === "label" && !src && (
        <span className="absolute inset-0 flex items-center justify-center text-xs text-muted">
          No artwork
        </span>
      )}

      {src && !failed && (
        <img
          src={src}
          alt={alt}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          // Faded in rather than swapped in: the frame underneath is the permanent
          // background, so a slow fetch never shows a hole and a fast one never flashes.
          className={`absolute inset-0 size-full object-cover transition-opacity duration-300 ${
            loaded ? "opacity-100" : "opacity-0"
          }`}
        />
      )}
    </>
  );

  // `relative` is forced on rather than left to the caller: every layer above is absolutely
  // positioned, and a caller who forgot it would have the poster escape to the nearest
  // positioned ancestor -- which fails silently and looks like a CSS bug somewhere else.
  const frame = `relative ${className}`;

  if (link && title) {
    return (
      <Link
        to="/title/$tconst"
        params={{ tconst: title.tconst }}
        className={`${frame} block`}
        aria-label={alt || title.title}
      >
        {body}
      </Link>
    );
  }

  // `aria-hidden` only when there is genuinely nothing here: an empty frame is spacing, and
  // announcing it would put a meaningless stop in the reading order of every row that has
  // no artwork.
  return (
    <div className={frame} aria-hidden={!src || undefined}>
      {body}
    </div>
  );
}
