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
import { useEffect, useState, useSyncExternalStore } from "react";
import { type Place, placeMapUrl, placeWikidataUrl } from "../../../src/lib/filming-locations";
import { useKeyAction } from "../components/Kbd";
import { PageHeading } from "../components/PageHeading";
import { TitleGrid } from "../components/TitleGrid";
import { cachedPlaceRun, getPlace, type PlacePage, subscribeTitleState, titleStateVersion } from "../lib/api";
import { browserLocales } from "../lib/reader-locale";

const PAGE = 60;

/**
 * What the page is a page OF, in the muted prefix before the name -- the same slot a term
 * page uses for "Keyword" or "Streaming on". A studio says so, because "filmed at Pinewood"
 * means a sound stage rather than a location anybody could visit.
 */
function placePrefix(place: Place): string {
  if (place.studio) return "Filmed at the studio";
  return place.kind === "area" ? "Filmed in" : "Filmed at";
}

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
 * Fetch a place's first page into whichever setters the caller hands over.
 *
 * ONE body for the two callers -- the load effect, whose setters are guarded against a stale
 * navigation, and "Try again", which runs in a click on the page that is already mounted.
 */
function loadFirstPage(
  id: string,
  set: {
    setPage: (p: PlacePage) => void;
    setError: (e: string) => void;
    setLoading: (l: boolean) => void;
  },
): void {
  set.setLoading(true);
  getPlace(id, { limit: PAGE, offset: 0 })
    .then((p) => set.setPage(p))
    .catch((e: Error) => set.setError(e.message))
    .finally(() => set.setLoading(false));
}

export function PlaceRoute() {
  const { id } = useParams({ strict: false }) as { id: string };
  const [page, setPage] = useState<PlacePage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useSyncExternalStore(subscribeTitleState, titleStateVersion);

  // Seeded during render, for the reason every grid route is: opening a title unmounts this
  // one, and a null first state would blank the page on the way back.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (seededFor !== id) {
    setSeededFor(id);
    setError(null);
    setPage(cachedPlaceRun(id, PAGE) ?? null);
  }

  useEffect(() => {
    // The index only changes at a rebuild, so a page we already hold IS the answer. No
    // revalidation -- unlike a term page, whose membership grows as the facet cache warms.
    if (cachedPlaceRun(id, PAGE)) return;
    let stale = false;
    loadFirstPage(id, {
      setPage: (p) => !stale && setPage(p),
      setError: (e) => !stale && setError(e),
      setLoading: (l) => !stale && setLoading(l),
    });
    return () => {
      stale = true;
    };
  }, [id]);

  const canLoadMore = Boolean(page && !loading && page.titles.length < page.total);

  const loadMore = async () => {
    if (!page || !canLoadMore) return;
    setLoading(true);
    try {
      const next = await getPlace(id, { limit: PAGE, offset: page.titles.length });
      // Appended only onto the SAME place: a reader who navigated away mid-fetch must not get
      // this page's rows stitched under another place's header.
      setPage((prev) =>
        prev && prev.place.id === next.place.id
          ? { ...next, titles: [...prev.titles, ...next.titles] }
          : prev,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const loadMoreKey = useKeyAction("loadMore", () => void loadMore(), canLoadMore);

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
            <button
              type="button"
              onClick={() => {
                setError(null);
                loadFirstPage(id, { setPage, setError, setLoading });
              }}
              className="underline hover:text-ink"
            >
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
  const country = countryName(place.country);
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

      <TitleGrid titles={page.titles} />

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
    </>
  );
}
