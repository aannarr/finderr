/**
 * One filming location -- a castle, a desert, a city -- and every title we hold that was
 * filmed there, most-voted first.
 *
 * The sixth view on the shared filtered grid: a header saying what the selection is,
 * `TitleGrid` under it, a loader that differs. Paged like a filmography rather than unpaged
 * like a term, because a place can be long -- Los Angeles is 1,374 titles (real build, 2026-09-14).
 *
 * Local SQLite the whole way down. `place` and `title_place` are built into the index from
 * Wikidata, so `/api/place/:id` asks nobody anything.
 *
 * The two links out are the only places a reader can go that are not ours: a MAP, because a
 * filming location is a point on the earth and that is the one thing this page cannot show,
 * and WIKIDATA, because every fact here came from it and it is where a wrong one is fixed.
 * Both are links rather than embeds -- no third-party tile or script loads on this page.
 */

import { Link, useParams } from "@tanstack/react-router";
import { useMemo, useSyncExternalStore } from "react";
import { useKeyAction } from "../components/Kbd";
import { PageHeading } from "../components/PageHeading";
import type { CardNote } from "../components/TitleCard";
import { TitleGrid } from "../components/TitleGrid";
import { type PlaceParts, subscribeTitleState, type Title, titleStateVersion } from "../lib/api";
import { countryCaption, partsLabel, placeMapUrl, placePrefix, placeWikidataUrl } from "../lib/place-links";
import { browserLocales } from "../lib/reader-locale";
import { usePlacePage } from "../lib/use-place-page";

const PAGE = 60;

/** "Spain", in the reader's own language. Made here and never stored, like a language name. */
function countryName(code: string | null): string | null {
  if (!code) return null;
  try {
    return new Intl.DisplayNames(browserLocales(), { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * "3 episodes" under a series that is here on the strength of some of its episodes.
 *
 * The note is what separates "Game of Thrones was shot in Dubrovnik" from "one episode was".
 * A title that made the statement of itself gets no note. Built once per `episodes` map and
 * memo'd by the caller, because `TitleGrid` is memo'd and `noteFor` must be a stable reference.
 */
function episodeNoteFor(parts: Record<string, PlaceParts>): (t: Title) => CardNote | null {
  return (t) => {
    const p = parts[t.tconst];
    const text = p ? partsLabel(p) : null;
    return text ? { text, full: `Filmed here in ${text}` } : null;
  };
}

export function PlaceRoute() {
  const { id } = useParams({ strict: false }) as { id: string };
  // The loading, paging and failure rules live in the hook, where a test can drive them.
  const { page, error, loading, moreFailed, canLoadMore, loadMore, retry } = usePlacePage(id, PAGE);

  useSyncExternalStore(subscribeTitleState, titleStateVersion);

  const loadMoreKey = useKeyAction("loadMore", () => void loadMore(), canLoadMore);
  const parts = page?.parts;
  const noteFor = useMemo(() => (parts ? episodeNoteFor(parts) : undefined), [parts]);

  if (error) {
    /*
      Two different answers, said differently. A 404 covers an id nobody filmed at in this
      index, a malformed id and an index built before the stage -- none of which is "a real
      place with nothing in it", which is what the first draft of this sentence claimed. Any
      other failure is transient, so it gets a retry instead of a raw `e.message`.
    */
    const unknown = error === "unknown place";
    return (
      <p className="py-16 text-center text-muted">
        {unknown ? "That is not a filming location in our index." : "This place did not load."}{" "}
        {!unknown && (
          <>
            <button type="button" onClick={retry} className="underline hover:text-ink">
              Try again
            </button>{" "}
            or{" "}
          </>
        )}
        <Link to="/" className="underline hover:text-ink">
          {unknown ? "Back to search" : "back to search"}
        </Link>
      </p>
    );
  }

  // No skeleton: one local query, so the page is either here or a frame away.
  if (!page) return null;

  const { place } = page;
  // Null when it would only repeat the heading -- a city-state is its own country.
  const country = countryCaption(place.label, countryName(place.country));
  const map = placeMapUrl(place);

  return (
    <>
      <div className="mb-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <PageHeading prefix={placePrefix(place)}>{place.label}</PageHeading>
          <span className="text-xs text-muted tabular-nums">
            {page.total.toLocaleString()} {page.total === 1 ? "title" : "titles"}
          </span>
        </div>

        {/*
          Where it is, then where to look it up. The country is plain text -- it is a caption
          for the pin, not a destination of its own -- and the links are the quiet underlined
          row the title page uses for its own links out.
        */}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          {place.studio && <span className="text-muted">Film studio</span>}
          {country && <span className="text-muted">{country}</span>}
          <ul aria-label="Links" className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {map && (
              <li>
                <a
                  href={map}
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted underline decoration-line underline-offset-4 transition-colors
                             hover:text-ink hover:decoration-muted"
                >
                  OpenStreetMap
                </a>
              </li>
            )}
            <li>
              <a
                href={placeWikidataUrl(place)}
                target="_blank"
                rel="noreferrer"
                className="text-muted underline decoration-line underline-offset-4 transition-colors
                           hover:text-ink hover:decoration-muted"
              >
                Wikidata
              </a>
            </li>
          </ul>
        </div>
      </div>

      <TitleGrid titles={page.titles} noteFor={noteFor} />

      {page.titles.length < page.total && (
        <div className="mt-6 flex justify-center">
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={!canLoadMore}
            {...loadMoreKey.props}
            className="rounded-lg border border-line px-4 py-2 text-sm text-muted hover:text-ink disabled:opacity-50"
          >
            {loading ? "Loading…" : `Show ${Math.min(PAGE, page.total - page.titles.length)} more`}
            {loadMoreKey.hint}
          </button>
        </div>
      )}
      {/* On the control that failed, not over the page -- DESIGN.md § Confirmation. */}
      {moreFailed && (
        <p role="status" className="mt-2 text-center text-xs text-muted">
          The next titles did not load. Press the button to try again.
        </p>
      )}
    </>
  );
}
