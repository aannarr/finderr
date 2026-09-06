/**
 * `/awards/oscars/96`, `/awards/palme-dor/1994` -- one edition, every category, winner first.
 *
 * Routed on the EDITION KEY, which is the ceremony number where the source has one and the
 * year where it does not. The Academy's `Year` is `1927/28` for the first six, so it is a
 * label rather than a key there; Wikidata carries no ordinal at all, so the year is the only
 * key it can offer. `editionHeading` is the single owner of which of the two a page prints.
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
  type AwardIdentity,
  type CeremonyPage,
  cachedCeremony,
  getCeremony,
  type NominationView,
  subscribeTitleState,
  type Title,
  titleStateVersion,
} from "../lib/api";
import { useApp } from "../lib/app-context";
import { editionHeading, editionLabel, isPersonLed, prettyCategory } from "../lib/awards-format";
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
  const { award, ceremony } = useParams({ strict: false }) as { award: string; ceremony: string };
  const number = Number.parseInt(ceremony, 10);
  const { request } = useApp();

  const [page, setPage] = useState<CeremonyPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useSyncExternalStore(subscribeTitleState, titleStateVersion);

  // Seeded during render for the same reason `PersonRoute` is: stepping to the next
  // edition and back must not blank the page while a cached answer is already in hand.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const seed = `${award}/${ceremony}`;
  if (seededFor !== seed) {
    setSeededFor(seed);
    setPage(cachedCeremony(award, number) ?? null);
    setError(null);
    // Collapse on navigation: "show all" is a decision about the edition you were
    // reading, not a preference that should follow you to the next one.
    setExpanded(false);
  }

  useEffect(() => {
    if (!Number.isFinite(number)) {
      setError("unknown ceremony");
      return;
    }
    if (cachedCeremony(award, number)) return;
    let stale = false;
    getCeremony(award, number)
      .then((p) => {
        if (!stale) setPage(p);
      })
      .catch((e: Error) => {
        if (!stale) setError(e.message);
      });
    return () => {
      stale = true;
    };
  }, [award, number]);

  if (error) {
    return (
      <p className="py-16 text-center text-muted">
        {error === "unknown ceremony" ? "We hold nothing under that number." : error}{" "}
        <Link to="/awards/$award" params={{ award }} className="underline hover:text-ink">
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
  const anchorRow = page.anchorFilm?.tconst ? page.titles[page.anchorFilm.tconst] : undefined;

  return (
    <>
      <header className="mb-6">
        <p className="mb-1 text-xs text-muted">
          <Link
            to="/awards/$award"
            params={{ award: page.award.id }}
            className="underline-offset-2 hover:text-ink hover:underline"
          >
            ← {page.award.title}
          </Link>
        </p>

        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="text-xl font-semibold tracking-tight tabular-nums">
            {editionHeading(page.award, page.ceremony, page.year)}
          </h2>
          {/*
            Drawn only when there is more than one category to count. An edition of a
            one-prize award would otherwise read "1 categories · 1 nominations" beside a
            heading that already says which edition it is.
          */}
          {page.categories > 1 && (
            <p className="text-xs text-muted tabular-nums">
              {page.categories} categories · {page.nominations} nominations
            </p>
          )}
        </div>

        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          {/*
            The anchor LINE survives even though the hero below says the same thing, and only
            when the hero cannot: `WinnerHero` needs an indexed row to draw a poster and fetch
            a synopsis, and about a tenth of nominations name a film we hold no row for. This
            is the honest fallback for those -- a name, in the header, where it has always
            been.
          */}
          {page.anchorFilm && !anchorRow && (
            <>
              <span>
                <span className="text-muted/70">{page.award.anchorLabel} </span>
                <AwardFilmLink film={page.anchorFilm} titles={page.titles} className="text-ink" />
              </span>
              <span aria-hidden="true">·</span>
            </>
          )}
          {/* Same rule: "0 of 1 titles" is the hero below, counted. */}
          {page.films > 1 && <Completion owned={page.filmsOwned} total={page.films} noun="titles" />}
        </p>

        <CeremonySteps award={page.award} prev={page.prev} next={page.next} />
      </header>

      {anchorRow && <WinnerHero row={anchorRow} label={page.award.anchorLabel} onRequest={request} />}

      {page.groups.length === 0 ? (
        <p className="py-16 text-center text-muted">This edition has no recorded categories.</p>
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
 * The edition's winner, celebrated at the top of its page.
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
function WinnerHero({ row, label, onRequest }: { row: Title; label: string; onRequest: (t: Title) => void }) {
  const { facets, working } = useTitleDetail(row.tconst);
  const synopsis = paneView(facets, "synopsis", working);

  return (
    <section className="mb-8 rounded-xl border border-line bg-surface p-4 sm:p-5">
      <div className="flex gap-4 sm:gap-5">
        <Poster
          title={row}
          link
          eager
          // `self-start`: the frame is a direct child of a `flex` row whose other column is
          // a label, a heading and a synopsis of unbounded length, so without it the poster
          // stretches to that column's height and `aspect-2/3` loses. `Poster`'s `className`
          // doc carries the whole reason and why the class is not forced inside it.
          className="aspect-2/3 w-28 shrink-0 self-start overflow-hidden rounded-lg bg-surface-2 sm:w-40"
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <p className="text-[0.65rem] font-semibold uppercase tracking-wider text-accent">{label}</p>
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
function CeremonySteps({
  award,
  prev,
  next,
}: {
  award: AwardIdentity;
  prev: number | null;
  next: number | null;
}) {
  if (prev === null && next === null) return null;
  return (
    <nav className="mt-3 flex gap-4 text-xs text-muted">
      {prev !== null && (
        <Link
          to="/awards/$award/$ceremony"
          params={{ award: award.id, ceremony: String(prev) }}
          className="underline-offset-2 hover:text-ink hover:underline"
        >
          ← {editionLabel(award, prev)}
        </Link>
      )}
      {next !== null && (
        <Link
          to="/awards/$award/$ceremony"
          params={{ award: award.id, ceremony: String(next) }}
          className="underline-offset-2 hover:text-ink hover:underline"
        >
          {editionLabel(award, next)} →
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
        {/*
          "1 nominee" over a block whose only row is a WINNER is a false label, and every row
          of a Wikidata award is a winner. Counting what the block actually holds says the
          true thing for both shapes without either page knowing which award it is drawing.
        */}
        <span className="shrink-0 text-xs text-muted tabular-nums">
          {nominations.length} {nominations.every((n) => n.won) ? "winner" : "nominee"}
          {nominations.length === 1 ? "" : "s"}
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
