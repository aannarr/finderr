/**
 * The action for a title Plex already holds: play it.
 *
 * TWO LINKS, because they fail in opposite directions and neither is safe alone. The web app
 * works on any machine but lands the reader in a browser tab; `plex://` opens the real client
 * and does NOTHING AT ALL when no client is installed to claim the scheme -- no error, no
 * navigation, a dead button. So the web link is the one wearing the weight, and the app link
 * sits under it as an offer.
 *
 * `hasFile` is deliberately never consulted by any caller. Plex holding a scanned item IS the
 * stronger statement -- the arr's `hasFile` can be true for a file Plex has not seen yet, and
 * it can be false for something imported outside the arr entirely.
 *
 * SHARED because two screens answer "is it ready yet": the title page, where this takes the
 * primary slot the Request button occupies for everything else, and a `/requests` row, where
 * it is one line of an entry in a list. They disagree about SIZE and about nothing else,
 * which is why that is a prop rather than a second component -- see `VARIANT`.
 */

import type { PlexLinks } from "../lib/api";

/**
 * How big, and nothing else.
 *
 * A table rather than a ternary in the markup, so adding a third surface is a row here and
 * no edit to the component. Both entries render the SAME two links in the same order with
 * the same labels: a variant may change the weight of the offer, never what it says.
 */
const VARIANT = {
  /** The title page's primary action: full width, and the app link beneath it. */
  block: {
    wrapper: "space-y-1.5",
    web: `block w-full rounded-lg bg-accent px-3 py-2 text-center text-sm font-medium text-black
          transition-opacity hover:opacity-90 active:opacity-75`,
    app: "block text-center text-xs text-muted hover:text-ink",
  },
  /** A row in a list: both links on one baseline, at the size of the controls beside them. */
  inline: {
    wrapper: "mt-1 flex flex-wrap items-baseline gap-3",
    web: `rounded-md bg-accent px-2 py-0.5 text-xs font-medium text-black
          transition-opacity hover:opacity-90 active:opacity-75`,
    app: "text-xs text-muted hover:text-ink",
  },
} as const;

export type PlayOnPlexVariant = keyof typeof VARIANT;

export function PlayOnPlex({ plex, variant = "block" }: { plex: PlexLinks; variant?: PlayOnPlexVariant }) {
  const style = VARIANT[variant];
  return (
    <div className={style.wrapper}>
      <a href={plex.web} target="_blank" rel="noreferrer" className={style.web}>
        Play on Plex
      </a>
      {/*
        No `target`/`rel`: this never navigates the page, it hands the URL to whatever
        registered the `plex:` scheme. Opening it in a tab would leave an empty one behind
        on the machines where it works.
      */}
      <a href={plex.app} className={style.app}>
        Open in the Plex app
      </a>
    </div>
  );
}
