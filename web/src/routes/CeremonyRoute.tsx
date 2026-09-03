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
import { AwardFilmLink, NominationRow, NomineeList } from "../components/Awards";
import { Completion } from "../components/Completion";
import { Poster } from "../components/Poster";
import { RequestAction } from "../components/RequestAction";
import { SynopsisBody } from "../components/TitlePanes";
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
import { isPersonLed, ordinal, prettyCategory } from "../lib/awards-format";
import { paneView } from "../lib/facet-panes";
import { useTitleDetail } from "../lib/use-title-detail";

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

  // The winner, only when we hold a row for it -- everything the hero draws (a poster, a
  // synopsis, a request button) is keyed on the index row, so without one there is no hero
  // to build and the header keeps its plain line instead.
  const bestPictureRow = page.bestPicture?.tconst ? page.titles[page.bestPicture.tconst] : undefined;

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
          {/*
            The Best Picture LINE survives even though the hero below says the same thing,
            and only when the hero cannot: `WinnerHero` needs an indexed row to draw a poster
            and fetch a synopsis, and about a tenth of nominations name a film we hold no row
            for. This is the honest fallback for those -- a name, in the header, where it has
            always been.
          */}
          {page.bestPicture && !bestPictureRow && (
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

      {bestPictureRow && <WinnerHero row={bestPictureRow} onRequest={request} />}

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
 * The Best Picture winner, celebrated at the top of its ceremony.
 *
 * > [!IMPORTANT] The synopsis is LAZY, and it has to be -- it is a facet, not an index column
 * > The ceremony payload is local SQLite only, like every render path here, and a synopsis
 * > comes from a provider. So the hero paints the instant the page does, from the row we
 * > already hold, and the paragraph arrives behind it. `useTitleDetail` is the owner of that
 * > policy -- it paints from the client cache, then polls only while the SERVER says a
 * > provider still owes an answer, and stops the moment nothing is outstanding. Reusing it
 * > rather than writing a fetch here is what keeps one copy of the stop condition.
 * >
 * > This costs the ceremony page ONE title request, for one film, after paint. It is the
 * > same request the title page would make if the reader clicked through -- and because the
 * > client cache is shared, clicking through afterwards is then free.
 *
 * Nothing here can push the poster around: the image has a reserved aspect box and the
 * synopsis sits beside it in its own column, so a late paragraph grows downward and the top
 * of the page never moves.
 */
function WinnerHero({ row, onRequest }: { row: Title; onRequest: (t: Title) => void }) {
  const { facets, working } = useTitleDetail(row.tconst);
  const synopsis = paneView(facets, "synopsis", working);

  return (
    <section className="mb-8 rounded-xl border border-line bg-surface p-4 sm:p-5">
      <div className="flex gap-4 sm:gap-5">
        <Poster
          title={row}
          link
          eager
          className="aspect-2/3 w-28 shrink-0 overflow-hidden rounded-lg bg-surface-2 sm:w-40"
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <p className="text-[0.65rem] font-semibold uppercase tracking-wider text-accent">Best Picture</p>
          <h3 className="mt-0.5 text-lg font-semibold tracking-tight sm:text-xl">
            <Link to="/title/$tconst" params={{ tconst: row.tconst }} className="hover:underline">
              {row.title}
            </Link>
            {row.year !== null && <span className="ml-2 text-sm font-normal text-muted">{row.year}</span>}
          </h3>

          {/*
            Three states, decided by `paneView` rather than re-invented here: content, a
            skeleton while a provider still owes us one, and nothing at all when the answer
            is not coming. Two muted bars rather than a spinner -- the shape of the thing
            that is arriving, which is what stops the card resizing when it lands.
          */}
          <div className="mt-2">
            {synopsis.state === "content" && synopsis.data && <SynopsisBody synopsis={synopsis.data} />}
            {synopsis.state === "skeleton" && (
              <div className="space-y-2" aria-hidden="true">
                <div className="h-3 w-full max-w-prose rounded bg-surface-2" />
                <div className="h-3 w-4/5 max-w-prose rounded bg-surface-2" />
              </div>
            )}
          </div>

          <div className="mt-auto pt-3">
            <RequestAction title={row} onRequest={onRequest} tone="inline" />
          </div>
        </div>
      </div>
    </section>
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

  // Decided from the CATEGORY's class, so every row in a block reads the same way. It was
  // `nominees.length === 1 && films.length === 1`, which made Best Picture draw eight rows
  // film-first and two person-first purely because two of the ten credited one producer.
  const personLed = isPersonLed(n.className);

  return (
    <NominationRow
      won={n.won}
      detail={n.detail}
      subject={personLed ? <NomineeList nominees={n.nominees} /> : films}
      credit={personLed ? films : n.nominees.length > 0 ? <NomineeList nominees={n.nominees} /> : undefined}
      /*
        The poster of the film this nomination is FOR -- including in the acting categories,
        where the row leads with the person. The film is what the poster can show; a
        headshot would need the `cast` facet for a title we may not have opened, which is a
        provider call per row on a page of 140 rows.

        `w92` because it renders at 32px: asking for `w342` here would pull roughly ten
        times the bytes for the same pixels, over a page that draws more posters than any
        other in the product. The frame is drawn even for a film we do not index, so the
        column of text stays straight rather than stepping in and out.
      */
      leading={
        <Poster
          title={row}
          size="w92"
          link
          className="aspect-2/3 w-8 shrink-0 overflow-hidden rounded bg-surface-2"
        />
      }
      trailing={row ? <RequestAction title={row} onRequest={onRequest} tone="inline" /> : undefined}
    />
  );
}
