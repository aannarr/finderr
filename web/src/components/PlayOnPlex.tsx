/**
 * The action for a title Plex already holds, as one line of a `/requests` row: play it.
 *
 * TWO LINKS, because they fail in opposite directions and neither is safe alone. The web app
 * works on any machine but lands the reader in a browser tab; `plex://` opens the real client
 * and does NOTHING AT ALL when no client is installed to claim the scheme -- no error, no
 * navigation, a dead button. So the web link is the one wearing the weight, and the app link
 * sits beside it as an offer.
 *
 * `hasFile` is deliberately never consulted by any caller. Plex holding a scanned item IS the
 * stronger statement -- the arr's `hasFile` can be true for a file Plex has not seen yet, and
 * it can be false for something imported outside the arr entirely.
 *
 * The title page does not use this: it draws the same two links as the default half and one
 * item of `PlayMenu`, beside the other ways to play that only a title page offers.
 */

import type { PlexLinks } from "../lib/api";

export function PlayOnPlex({ plex }: { plex: PlexLinks }) {
  return (
    <div className="mt-1 flex flex-wrap items-baseline gap-3">
      <a
        href={plex.web}
        target="_blank"
        rel="noreferrer"
        className="rounded-md bg-accent px-2 py-0.5 text-xs font-medium text-black transition-opacity hover:opacity-90 active:opacity-75"
      >
        Play on Plex
      </a>
      {/*
        No `target`/`rel`: this never navigates the page, it hands the URL to whatever
        registered the `plex:` scheme. Opening it in a tab would leave an empty one behind
        on the machines where it works.
      */}
      <a href={plex.app} className="text-xs text-muted hover:text-ink">
        Open in the Plex app
      </a>
    </div>
  );
}
