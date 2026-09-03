/**
 * `/awards/oscars`, `/awards/palme-dor` -- one award as a scrollable rail of editions.
 *
 * The shape the card asked for: a vertical rail, newest first, each edition anchored by its
 * headline winner with a poster, its record for that year, and what else it won. Every title
 * and every year is a destination.
 *
 * Nothing here knows which award it is drawing. The payload carries the award's name, what
 * its anchor prize is called and whether its editions are numbered or dated, so this file
 * holds no vocabulary of its own -- the alternative was a second copy of the registry in the
 * browser, drifting from the rows beside it.
 *
 * Local SQLite the whole way down -- `/api/awards/:award` reads imported rows, joins the
 * anchors against the index and counts ownership against the library mirror, and asks no
 * provider. So there is no polling here, no skeleton and no `work` to watch: the page is
 * either painted or one request away, exactly like the person page.
 */

import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { AwardSourceLine } from "../components/Awards";
import { Completion } from "../components/Completion";
import { Poster } from "../components/Poster";
import { RequestAction } from "../components/RequestAction";
import {
  type AwardIdentity,
  type AwardsTimeline,
  type CeremonySummary,
  cachedAwards,
  getAwards,
  subscribeTitleState,
  type Title,
  titleStateVersion,
} from "../lib/api";
import { useApp } from "../lib/app-context";
import { ceremonyYear, editionLabel, prettyCategory } from "../lib/awards-format";

export function AwardsRoute() {
  const { award } = useParams({ strict: false }) as { award: string };
  const { request } = useApp();
  const [page, setPage] = useState<AwardsTimeline | null>(() => cachedAwards(award) ?? null);
  const [error, setError] = useState<string | null>(null);

  // Library and request state change under this page like any other: requesting a winner
  // from the timeline must repaint its own row.
  useSyncExternalStore(subscribeTitleState, titleStateVersion);

  // Seeded during render for the same reason `CeremonyRoute` is: switching awards from the
  // nav must not draw the previous award's editions under the new one's heading for a frame.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (seededFor !== award) {
    setSeededFor(award);
    setPage(cachedAwards(award) ?? null);
    setError(null);
  }

  useEffect(() => {
    if (cachedAwards(award)) return;
    let stale = false;
    getAwards(award)
      .then((p) => {
        if (!stale) setPage(p);
      })
      .catch((e: Error) => {
        if (!stale) setError(e.message);
      });
    return () => {
      stale = true;
    };
  }, [award]);

  if (error) {
    return (
      <p className="py-16 text-center text-muted">
        {error === "unknown award" ? "We hold no award by that name." : error}{" "}
        <Link to="/lists" className="underline hover:text-ink">
          Back to the lists
        </Link>
      </p>
    );
  }

  // No skeleton, for the same reason the person page has none: one local query is either
  // here or a frame away, and a skeleton for that is a flash rather than a reassurance.
  if (!page) return null;

  /*
    The import is OPTIONAL, and a checkout that has never run it is not broken.

    It runs on its own daily timer and about twelve seconds after a cold boot, so an empty
    page here is a real and temporary state. Saying which command fills it is more use than
    an empty rail -- this is the same courtesy the index progress page extends.
  */
  if (page.ceremonies.length === 0) {
    return (
      <div className="py-16 text-center">
        <h2 className="text-lg font-semibold tracking-tight">{page.award.title}</h2>
        <p className="mt-2 text-sm text-muted">
          Nothing has been imported yet. It arrives on its own timer, or run{" "}
          <code className="rounded bg-surface-2 px-1.5 py-0.5 text-xs">
            bun run awards:import --award {page.award.id}
          </code>
          .
        </p>
      </div>
    );
  }

  const newest = ceremonyYear(page.ceremonies[0]?.year ?? "");
  const oldest = ceremonyYear(page.ceremonies[page.ceremonies.length - 1]?.year ?? "");

  return (
    <>
      <header className="mb-6">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="text-xl font-semibold tracking-tight">{page.award.title}</h2>
          <p className="text-xs text-muted tabular-nums">
            {page.totals.ceremonies} {page.award.editionMany}
            {newest !== null && oldest !== null && ` · ${oldest}–${newest}`}
          </p>
        </div>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <span className="tabular-nums">
            {page.totals.nominations.toLocaleString()} nominations · {page.totals.wins.toLocaleString()} wins
          </span>
          {page.anchor.total > 0 && (
            <>
              <span aria-hidden="true">·</span>
              {/*
                The completion count, and the one number a thin proxy over TMDB cannot
                answer at all: it needs the nominations and the library in the same file.
              */}
              <Completion owned={page.anchor.owned} total={page.anchor.total} noun={page.anchor.noun} />
            </>
          )}
        </p>
      </header>

      {/*
        The rail is a border on the list, not a column of drawn glyphs -- so it is one
        element rather than 98, and it cannot fall out of step with the rows beside it.
      */}
      <ol className="ml-1 border-l border-line">
        {page.ceremonies.map((c) => (
          <CeremonyRow
            key={c.ceremony}
            ceremony={c}
            award={page.award}
            titles={page.titles}
            onRequest={request}
          />
        ))}
      </ol>

      <AwardSourceLine source={page.source} className="mt-8" />
    </>
  );
}

/**
 * One edition: the year, its anchor title, and what that title did.
 *
 * The whole row is NOT a link. The edition heading goes to the year page and the poster
 * and title go to the film, which are two different destinations a reader genuinely wants
 * from here -- wrapping the lot in one link would make the more interesting of the two
 * unreachable.
 */
function CeremonyRow({
  ceremony: c,
  award,
  titles,
  onRequest,
}: {
  ceremony: CeremonySummary;
  award: AwardIdentity;
  titles: Record<string, Title>;
  onRequest: (t: Title) => void;
}) {
  const row = c.anchorTconst ? titles[c.anchorTconst] : undefined;

  return (
    <li className="relative -ml-px border-l border-transparent pb-8 pl-5">
      {/* The node on the rail. Absolute so it sits ON the border rather than beside it. */}
      <span
        aria-hidden="true"
        className="absolute top-1.5 -left-[4.5px] size-2 rounded-full bg-line ring-4 ring-bg"
      />

      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h3 className="text-sm font-medium">
          <Link
            to="/awards/$award/$ceremony"
            params={{ award: award.id, ceremony: String(c.ceremony) }}
            className="underline-offset-2 hover:text-accent hover:underline"
          >
            {editionLabel(award, c.ceremony, c.year)}
          </Link>
        </h3>
        <span className="text-xs text-muted tabular-nums">
          {c.nominations} nominations · {c.categories} categories
        </span>
        <Completion owned={c.filmsOwned} total={c.films} noun="titles" className="text-xs text-muted" />
      </div>

      <div className="mt-2 flex gap-3">
        <AnchorPoster row={row} title={c.anchorTitle} />

        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-medium">
              {row ? (
                <Link
                  to="/title/$tconst"
                  params={{ tconst: row.tconst }}
                  className="underline-offset-2 hover:text-accent hover:underline"
                >
                  {c.anchorTitle}
                </Link>
              ) : (
                // No row means we do not index it, so there is nowhere to send anybody.
                // Plain text is the correct answer, not a shortfall.
                c.anchorTitle
              )}
            </span>
            <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-accent">
              {award.anchorLabel}
            </span>
          </p>

          {/*
            A winner-only award gives every edition exactly one row, so "1 nomination, 1 win"
            under the headline would be the headline restated as arithmetic. The line is for
            an award where the anchor did more than win its own category.
          */}
          {c.anchorNominations > 1 && (
            <p className="mt-0.5 text-xs text-muted tabular-nums">
              {c.anchorNominations} nominations, {c.anchorWins} win{c.anchorWins === 1 ? "" : "s"}
            </p>
          )}

          {c.anchorAlsoWon.length > 0 && (
            <p className="mt-1 text-xs text-muted">
              <span className="text-muted/70">also won </span>
              {/*
                Titlecased for reading. The stored value is the source's shouted
                `WRITING (Adapted Screenplay)`, which is correct as a KEY and unreadable as
                a list of five.
              */}
              {c.anchorAlsoWon.map(prettyCategory).join(" · ")}
            </p>
          )}

          {row && (
            <p className="mt-2">
              <RequestAction title={row} onRequest={onRequest} tone="inline" />
            </p>
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * The anchor's poster, or the space it would have taken.
 *
 * The frame is drawn either way, so an edition whose winner we do not index does not reflow
 * the rows above and below it -- `Poster` guarantees that for every caller now, which is
 * most of why it exists. This wrapper survives only to name the timeline's own size.
 */
function AnchorPoster({ row, title }: { row: Title | undefined; title: string | null }) {
  return (
    <Poster
      title={row}
      size="w185"
      link
      alt={title ?? undefined}
      className="aspect-2/3 w-16 shrink-0 overflow-hidden rounded-md bg-surface-2 sm:w-20"
    />
  );
}
