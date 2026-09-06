/**
 * `/watchlist` -- the titles you kept, newest first.
 *
 * It draws `TitleGrid` and nothing bespoke, which is the point: a saved title is an ordinary
 * card, so it carries the same poster, the same library badge and the same Request button as
 * it did on the page you saved it from. A row shape of its own here would have been a second
 * description of a title that could disagree with the first.
 *
 * **NOTHING ON THIS PAGE DOWNLOADS ANYTHING BY ITSELF.** The list is a note to yourself;
 * pressing Request on one of these cards is the same deliberate act it is anywhere else. That
 * separation is what makes this the half of the watchlist idea that was safe to build -- see
 * `src/lib/watchlist.ts`.
 *
 * The rows come from the shared session store rather than a loader, because the same data
 * feeds every save button in the product: a title removed here disappears from this grid and
 * un-fills its bookmark on the front page behind it, with no route knowing about the other.
 */

import { useEffect } from "react";
import { TitleGrid } from "../components/TitleGrid";
import { loadWatchlist, useWatchlist } from "../lib/watchlist";

export function WatchlistRoute() {
  const titles = useWatchlist();

  // `loadWatchlist` is deduped and answers instantly once the shell has loaded it, so this is
  // a no-op on every visit but the first -- and the first is the one where somebody deep-links
  // straight here before the shell's own call has returned.
  useEffect(() => {
    void loadWatchlist();
  }, []);

  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">Your watchlist</h1>

      {titles === null ? (
        <p className="mt-2 text-sm text-muted">Loading…</p>
      ) : titles.length === 0 ? (
        <p className="mt-2 max-w-prose text-sm text-muted">
          Nothing saved yet. The bookmark on any card or title page puts it here. Saving downloads nothing;
          Request is still the only thing that does.
        </p>
      ) : (
        <>
          <p className="mt-1 mb-4 text-sm text-muted">Yours alone, newest first. Saving downloads nothing.</p>
          <TitleGrid titles={titles} />
        </>
      )}
    </div>
  );
}
