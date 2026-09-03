/**
 * One term -- a keyword, a streaming service, a studio -- and the titles we hold for it.
 *
 * The fifth view built on the shared filtered grid, and the destination that turns three
 * rows of inert chips into links. Same shape as the collection page: a header describing
 * the selection, `TitleGrid` under it, a loader that differs.
 *
 * Deliberately UNPAGED, like the collection page and for the same reason: the membership is
 * whatever the facet cache holds, which is a grid rather than a filmography. A "show 60
 * more" button under it would be a control that can never do anything.
 *
 * Local SQLite the whole way down. `/api/term/:dimension/:value` reads the cached facets
 * from the term end and asks no provider, so this is as fast as search -- and the coverage
 * it draws on grows on its own as titles are viewed and pre-warmed. NO VOTE FLOOR applies:
 * this is an explicit membership list of what we have cached, not the broad grid
 * `browseVoteFloor` exists to curate.
 */

import { Link, useParams, useSearch } from "@tanstack/react-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { isTermDimension, type TermDimension } from "../../../src/lib/terms";
import { TitleGrid } from "../components/TitleGrid";
import { cachedTerm, getTerm, subscribeTitleState, type TermPage, titleStateVersion } from "../lib/api";

/** What each dimension is CALLED above the grid, so the page says what it is a page of. */
const DIMENSION_LABEL: Record<TermDimension, string> = {
  keyword: "Keyword",
  service: "Streaming on",
  studio: "Studio or network",
};

/** "12 titles", or "9 of 12 titles" when we cannot render one of them. */
function countLine(page: TermPage): string {
  const held = page.titles.length;
  const total = held + page.missing;
  const noun = total === 1 ? "title" : "titles";
  return page.missing === 0 ? `${held} ${noun}` : `${held} of ${total} ${noun}`;
}

export function TermRoute() {
  const { dimension, value } = useParams({ strict: false }) as { dimension: string; value: string };
  /*
    The country the chip was drawn for, carried in the URL rather than re-derived here.

    A service page is a different set of films in Bangkok and in Berlin, so the country is
    part of what this URL MEANS -- which is exactly what makes it shareable. Re-deriving it
    from `navigator.languages` would make one link resolve to two different pages depending
    on who opened it, and would disagree with the tile the reader clicked whenever the pane
    had fallen back to another country.
  */
  const { country } = useSearch({ strict: false }) as { country?: string };

  const [page, setPage] = useState<TermPage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useSyncExternalStore(subscribeTitleState, titleStateVersion);

  const known = isTermDimension(dimension) ? dimension : null;
  const requestKey = `${dimension}/${value}/${country ?? ""}`;

  // Seeded during render for the same reason `CollectionRoute` is: this route unmounts
  // every time you open a title from the grid, and a null initial state would blank the
  // page on the way back.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (seededFor !== requestKey) {
    setSeededFor(requestKey);
    setPage(known ? (cachedTerm(known, value, country) ?? null) : null);
    setError(null);
  }

  /*
    REVALIDATE EVEN ON A HIT, exactly as the collection page does. The cache above paints
    instantly, which is the whole reason it exists -- but a term's membership GROWS as more
    titles are viewed and pre-warmed, so skipping the refetch would pin one count for the
    session. The server's own `max-age=60` bounds how often this really reaches it.
  */
  useEffect(() => {
    if (!known) return;
    let stale = false;
    getTerm(known, value, country)
      .then((p) => {
        if (!stale) setPage(p);
      })
      .catch((e: Error) => {
        if (!stale) setError(e.message);
      });
    return () => {
      stale = true;
    };
  }, [known, value, country]);

  if (!known || error) {
    return (
      <p className="py-16 text-center text-muted">
        {/*
          A term nobody has cached two titles for has no page YET -- coverage is a set of
          cached provider answers, not something the index holds. Saying so is the honest
          version of a 404 here, and resolving it on demand is the blocking call the render
          path forbids.
        */}
        {!known || error === "unknown term" ? "We hold nothing for that yet." : error}{" "}
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
        <h2 className="text-xl font-semibold tracking-tight">
          <span className="mr-2 text-sm font-normal text-muted">{DIMENSION_LABEL[known]}</span>
          {page.term.label}
          {/*
            The country is part of what a service page is, so it is stated rather than
            implied -- a reader who shared this link needs to know the recipient may be
            looking at a different catalogue.
          */}
          {known === "service" && country && (
            <span className="ml-2 text-sm font-normal text-muted">in {country.toUpperCase()}</span>
          )}
        </h2>
        <span className="text-xs text-muted tabular-nums">{countLine(page)}</span>
      </div>

      <TitleGrid titles={page.titles} />

      {page.titles.length === 0 && (
        <p className="py-16 text-center text-muted">
          Nothing we hold for that is in our index.
          <br />
          {/* No vote floor applies here, so there is no escape hatch to offer -- these
              titles are genuinely absent rather than filtered out. */}
          <Link to="/" className="underline hover:text-ink">
            Back to search
          </Link>
        </p>
      )}
    </>
  );
}
