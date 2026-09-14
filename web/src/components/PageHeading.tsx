/**
 * The heading of a selection page: a muted word saying what it is a page OF, then its name.
 *
 * "Keyword Heist", "Streaming on Netflix", "Filmed in Almería" -- one idiom, owned here, used
 * by `TermRoute` and `PlaceRoute`.
 *
 * THE SPACE IS A REAL CHARACTER, not a margin. A margin separates the words for the eye and
 * not for text: the accessible name read "Filmed inAlmería" and "KeywordHeist" until
 * 2026-09-14. `mr-1` plus the space keeps the visual gap the old `mr-2` drew.
 */

import type { ReactNode } from "react";

export function PageHeading({ prefix, children }: { prefix: string; children: ReactNode }) {
  return (
    <h2 className="text-xl font-semibold tracking-tight">
      <span className="mr-1 text-sm font-normal text-muted">{prefix}</span> {children}
    </h2>
  );
}
