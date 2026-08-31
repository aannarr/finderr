/**
 * One collection, and every film in it we hold.
 *
 * The fourth view built on the shared filtered grid, and the destination that turns the
 * title page's collection heading from a label into a link. Same shape as the person
 * page: a header describing the selection, `TitleGrid` under it, a loader that differs.
 *
 * Deliberately UNPAGED. A franchise is a handful of films, not a filmography -- a "show
 * 60 more" button under four cards would be a control that can never do anything.
 *
 * Local SQLite the whole way down: `/api/collection/:id` reads the cached `collection`
 * facet from the other end and asks no provider, so this page is as fast as search.
 */

import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { TitleGrid } from "../components/TitleGrid";
import {
  type CollectionPage,
  cachedCollection,
  getCollection,
  subscribeTitleState,
  titleStateVersion,
} from "../lib/api";

/** "4 films", or "3 of 4 films" when we cannot render one of them. */
function countLine(page: CollectionPage): string {
  const held = page.titles.length;
  const total = held + page.missing;
  const noun = total === 1 ? "film" : "films";
  return page.missing === 0 ? `${held} ${noun}` : `${held} of ${total} ${noun}`;
}

export function CollectionRoute() {
  const { id } = useParams({ strict: false }) as { id: string };

  const [page, setPage] = useState<CollectionPage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useSyncExternalStore(subscribeTitleState, titleStateVersion);

  // Seeded during render for the same reason PersonRoute is: this route unmounts every
  // time you open a film from the collection, and a null initial state would blank the
  // page on the way back.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (seededFor !== id) {
    setSeededFor(id);
    setPage(cachedCollection(id) ?? null);
    setError(null);
  }

  /*
    REVALIDATE EVEN ON A HIT. The cache above paints instantly, which is the whole reason
    it exists -- but returning early here made the entry immortal for the session, and a
    collection is the one page whose contents GROW: a member becomes renderable the moment
    somebody opens it, which is exactly why the server caps its own answer at 60 seconds.
    Skipping the refetch handed that decision to a Map that never expires. The refetch is
    cheap and mostly free: `/api/collection/:id` is local SQLite, and the browser's own
    HTTP cache honours that `max-age=60` without a second copy of the number living here.
  */
  useEffect(() => {
    let stale = false;
    getCollection(id)
      .then((p) => {
        if (!stale) setPage(p);
      })
      .catch((e: Error) => {
        if (!stale) setError(e.message);
      });
    return () => {
      stale = true;
    };
  }, [id]);

  if (error) {
    return (
      <p className="py-16 text-center text-muted">
        {/*
          A collection nobody has viewed a member of has no page YET -- membership is a
          cached provider answer, not something the index holds. Saying so is the honest
          version of a 404 here, and resolving it on demand is the blocking call the
          render path forbids.
        */}
        {error === "unknown collection" ? "We hold nothing for that collection." : error}{" "}
        <Link to="/" className="underline hover:text-ink">
          Back to search
        </Link>
      </p>
    );
  }

  // No skeleton: one local query, so the page is either here or a frame away.
  if (!page) return null;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xl font-semibold tracking-tight">{page.collection.name}</h2>
        <span className="text-xs text-muted tabular-nums">{countLine(page)}</span>
      </div>

      <TitleGrid titles={page.titles} />

      {page.titles.length === 0 && (
        <p className="py-16 text-center text-muted">
          Nothing in this collection is in our index.
          <br />
          {/* No vote floor applies here, so there is no escape hatch to offer -- these
              films are genuinely absent rather than filtered out. */}
          <Link to="/" className="underline hover:text-ink">
            Back to search
          </Link>
        </p>
      )}
    </>
  );
}
