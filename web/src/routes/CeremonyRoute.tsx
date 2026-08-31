/**
 * `/awards/oscars/96` -- one ceremony, every category, winner first.
 *
 * Routed on the CEREMONY NUMBER and never the year. `Year` is `1927/28` for the first six,
 * so it is a label rather than a key -- and even where it is four digits it is not unique
 * in the way a route needs. The year is displayed everywhere and parsed nowhere.
 *
 * Local SQLite the whole way down, like the timeline: the server grouped the rows and
 * resolved every film it could against the index, so this component renders and decides
 * nothing about freshness.
 */

import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { AwardFilmLink, Completion, NominationRow, NomineeList } from "../components/Awards";
import { RequestAction } from "../components/RequestAction";
import {
  type CeremonyPage,
  cachedCeremony,
  getCeremony,
  type NominationView,
  subscribeTitleState,
  type Title,
  titleStateVersion,
} from "../lib/api";
import { useApp } from "../lib/app-context";
import { ordinal, prettyCategory } from "../lib/awards-format";

/**
 * How many categories are drawn before the rest go behind a control.
 *
 * A ceremony runs to 28 canonical categories and the reader came for a handful of them.
 * The cut is at a number that keeps every acting category, directing and both screenplays
 * above the fold -- the ones a person actually scans for -- rather than at a round number.
 */
const VISIBLE_CATEGORIES = 8;

export function CeremonyRoute() {
  const { ceremony } = useParams({ strict: false }) as { ceremony: string };
  const number = Number.parseInt(ceremony, 10);
  const { request } = useApp();

  const [page, setPage] = useState<CeremonyPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useSyncExternalStore(subscribeTitleState, titleStateVersion);

  // Seeded during render for the same reason `PersonRoute` is: stepping to the next
  // ceremony and back must not blank the page while a cached answer is already in hand.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (seededFor !== ceremony) {
    setSeededFor(ceremony);
    setPage(cachedCeremony(number) ?? null);
    setError(null);
    // Collapse on navigation: "show all" is a decision about the ceremony you were
    // reading, not a preference that should follow you to the next one.
    setExpanded(false);
  }

  useEffect(() => {
    if (!Number.isFinite(number)) {
      setError("unknown ceremony");
      return;
    }
    if (cachedCeremony(number)) return;
    let stale = false;
    getCeremony(number)
      .then((p) => {
        if (!stale) setPage(p);
      })
      .catch((e: Error) => {
        if (!stale) setError(e.message);
      });
    return () => {
      stale = true;
    };
  }, [number]);

  if (error) {
    return (
      <p className="py-16 text-center text-muted">
        {error === "unknown ceremony" ? "We hold no ceremony by that number." : error}{" "}
        <Link to="/awards/oscars" className="underline hover:text-ink">
          Back to the timeline
        </Link>
      </p>
    );
  }

  if (!page) return null;

  const groups = expanded ? page.groups : page.groups.slice(0, VISIBLE_CATEGORIES);
  const hidden = page.groups.length - groups.length;

  return (
    <>
      <header className="mb-6">
        <p className="mb-1 text-xs text-muted">
          <Link to="/awards/oscars" className="underline-offset-2 hover:text-ink hover:underline">
            ← The Academy Awards
          </Link>
        </p>

        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="text-xl font-semibold tracking-tight">
            {ordinal(page.ceremony)} Academy Awards · <span className="tabular-nums">{page.year}</span>
          </h2>
          <p className="text-xs text-muted tabular-nums">
            {page.categories} categories · {page.nominations} nominations
          </p>
        </div>

        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          {page.bestPicture && (
            <>
              <span>
                <span className="text-muted/70">Best Picture </span>
                <AwardFilmLink film={page.bestPicture} titles={page.titles} className="text-ink" />
              </span>
              <span aria-hidden="true">·</span>
            </>
          )}
          <Completion owned={page.filmsOwned} total={page.films} noun="films" />
        </p>

        <CeremonySteps prev={page.prev} next={page.next} />
      </header>

      {page.groups.map((g) => g.category).length === 0 ? (
        <p className="py-16 text-center text-muted">This ceremony has no recorded categories.</p>
      ) : (
        <>
          {groups.map((g) => (
            <CategoryBlock
              key={g.category}
              category={g.category}
              nominations={g.nominations}
              titles={page.titles}
              onRequest={request}
            />
          ))}

          {hidden > 0 && (
            <div className="mt-6 flex justify-center">
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="rounded-lg border border-line px-4 py-2 text-sm text-muted hover:text-ink"
              >
                Show {hidden} more categor{hidden === 1 ? "y" : "ies"}
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}

/**
 * Older and newer, as links rather than arithmetic.
 *
 * The neighbours come from the server, which knows which ceremonies EXIST -- stepping by
 * ±1 in the browser would walk off both ends and invent a 99th.
 */
function CeremonySteps({ prev, next }: { prev: number | null; next: number | null }) {
  if (prev === null && next === null) return null;
  return (
    <nav className="mt-3 flex gap-4 text-xs text-muted">
      {prev !== null && (
        <Link
          to="/awards/oscars/$ceremony"
          params={{ ceremony: String(prev) }}
          className="underline-offset-2 hover:text-ink hover:underline"
        >
          ← {ordinal(prev)}
        </Link>
      )}
      {next !== null && (
        <Link
          to="/awards/oscars/$ceremony"
          params={{ ceremony: String(next) }}
          className="underline-offset-2 hover:text-ink hover:underline"
        >
          {ordinal(next)} →
        </Link>
      )}
    </nav>
  );
}

/**
 * One category, winner at the top.
 *
 * A nomination LEADS with the film and puts the people behind it, which is the opposite of
 * how the person page reads the same row -- the subject is what the reader is here for,
 * and on this page that is the film. `NominationRow` takes both as props precisely so
 * neither screen needs its own copy of the line.
 *
 * Acting categories are the one place that flips: there, the PERSON is the nomination and
 * the film is what it was for. That is a property of the row's data -- it names one person
 * and one film -- rather than a category-name check, so it is decided on the shape below.
 */
function CategoryBlock({
  category,
  nominations,
  titles,
  onRequest,
}: {
  category: string;
  nominations: NominationView[];
  titles: Record<string, Title>;
  onRequest: (t: Title) => void;
}) {
  return (
    <section className="mt-8">
      <div className="mb-1 flex items-baseline justify-between gap-3 border-b border-line pb-1">
        <h3 className="text-sm font-medium text-ink">{prettyCategory(category)}</h3>
        <span className="shrink-0 text-xs text-muted tabular-nums">
          {nominations.length} nominee{nominations.length === 1 ? "" : "s"}
        </span>
      </div>

      <ol>
        {nominations.map((n) => (
          <NominationLine key={n.seq} nomination={n} titles={titles} onRequest={onRequest} />
        ))}
      </ol>
    </section>
  );
}

/**
 * One nomination, with the request control for the film it names.
 *
 * The control is drawn only for a film we INDEX -- `titles` is the server's map of
 * decorated rows, so an entry missing from it is a title we cannot draw a card for, let
 * alone ask an arr about. A nomination naming several films draws the control for the
 * first we hold, because a row is one line and four buttons on it is a menu.
 */
function NominationLine({
  nomination: n,
  titles,
  onRequest,
}: {
  nomination: NominationView;
  titles: Record<string, Title>;
  onRequest: (t: Title) => void;
}) {
  const row = n.films.map((f) => (f.tconst ? titles[f.tconst] : undefined)).find(Boolean);

  const films = (
    <>
      {n.films.map((f, i) => (
        // Position keys for the same reason `NomineeList` uses them: a nomination can name
        // the same film twice and the list is the source's order, rendered once.
        // biome-ignore lint/suspicious/noArrayIndexKey: source order, never reordered
        <span key={`${f.tconst ?? f.title}-${i}`}>
          {i > 0 && " · "}
          <AwardFilmLink film={f} titles={titles} />
        </span>
      ))}
    </>
  );

  // A row that names exactly one person and one film reads best person-first -- that is
  // every acting category, and a handful of others, without naming any of them.
  const personLed = n.nominees.length === 1 && n.films.length === 1;

  return (
    <NominationRow
      won={n.won}
      detail={n.detail}
      subject={personLed ? <NomineeList nominees={n.nominees} /> : films}
      credit={personLed ? films : n.nominees.length > 0 ? <NomineeList nominees={n.nominees} /> : undefined}
      trailing={row ? <RequestAction title={row} onRequest={onRequest} tone="inline" /> : undefined}
    />
  );
}
