/**
 * One title, at its own URL.
 *
 * THE PAGE NEVER WAITS. Everything already local -- poster, title, year, runtime,
 * genres, IMDb score, studio, library state -- comes out of `/api/title/:tconst` in a
 * few milliseconds and renders immediately. Everything a plugin has to fetch renders as
 * a skeleton beside it and fills in, or quietly disappears if nobody can answer. A slow
 * provider is slow once per title, never once per request: its answer is cached whether
 * or not this view waited for it.
 *
 * `useTitleDetail` owns that policy, including what happens to a facet that misses the
 * deadline; this file owns the layout.
 */

import { Link, useCanGoBack, useParams, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { isTermLinkable, termKey } from "../../../src/lib/terms";
import { BrowseChip } from "../components/BrowseChip";
import { useKeyAction } from "../components/Kbd";
import { Poster } from "../components/Poster";
import { RequestOptions } from "../components/RequestOptions";
import { RequestVerdictPanel } from "../components/RequestProgress";
import { SeasonRequestDialog } from "../components/SeasonRequestDialog";
import { findTerm } from "../components/TermChip";
import { TitleFactsCard, TitleLowerPanes, TitleMainPanes } from "../components/TitlePanes";
import {
  postEpisodeRequest,
  postSeasonRequest,
  type RequestOverrides,
  type Term,
  type Title,
} from "../lib/api";
import { useApp } from "../lib/app-context";
import { formatVotes } from "../lib/facet-panes";
import { decadeOf } from "../lib/search-params";
import { useToasts } from "../lib/toasts";
import { useTermLinks } from "../lib/use-term-links";
import { type TitleDetailView, useTitleDetail } from "../lib/use-title-detail";

const KIND_LABEL: Record<string, string> = {
  movie: "Film",
  tvSeries: "Series",
  tvMiniSeries: "Mini-series",
  tvMovie: "TV film",
};

function runtimeLabel(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  // "1h", not "1h 0m" -- a round hour is extremely common for a TV episode slot.
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function TitleRoute() {
  const { tconst } = useParams({ strict: false }) as { tconst: string };
  const { request, isAdmin } = useApp();
  const toasts = useToasts();
  const router = useRouter();
  const canGoBack = useCanGoBack();

  const {
    title,
    facets,
    people,
    collectionTitles,
    relatedTitles,
    panes,
    working,
    problems,
    arrLink,
    episodeState,
    awards,
    error,
  } = useTitleDetail(tconst);

  /*
    Which of this title's keywords, services and studio go anywhere.

    Fetched rather than read off the detail payload, because the answer depends on the
    reader's country and that payload is cached for everybody -- the hook states the whole
    argument. It is an ADDITION to chips that already render, so a failure leaves them as
    text rather than as an error.
  */
  const terms = useTermLinks(tconst, facets);
  const studioTerm = findTerm(terms, "studio", termKey("studio", title?.studio ?? ""));

  /*
    Both keys are bound before the early returns below, because hooks must be, and both
    are gated on the same condition that decides whether their button is drawn at all --
    that is what keeps the glyph honest. A title already in the library, or already
    requested, has no Request button and no `⌘⏎`.
  */
  const canRequest = Boolean(title && !title.inLibrary && !title.requestStatus);

  /*
    Whether a chooser is offered is decided by the FACET, never by `title.kind`. A film
    is not served the `seasons` facet at all (`entities: ["series"]` in facets.ts), so it
    can never reach the chooser -- the same rule that keeps a `title.kind` check out of
    every pane. It also means the button never WAITS on a facet: until `seasons` lands,
    or if it never does, the button queues the whole series exactly as it always has.
  */
  const seasonsFacet = facets?.seasons;
  const seasons = seasonsFacet?.status === "ready" ? seasonsFacet.data : null;
  const choosable = Boolean(seasons && seasons.length > 0);
  const [choosing, setChoosing] = useState(false);

  /*
    Arr settings for this one request, ADMIN ONLY.

    Held here rather than inside `RequestOptions` because the Request button is what sends
    them and the button is not inside the panel -- the panel sits under it. An empty object
    is the resting state and is what every non-admin sends, because `postRequest` omits an
    unset field entirely rather than sending null (see `requestBody`), and the server
    REFUSES a non-admin who sends any of the three.
  */
  const [overrides, setOverrides] = useState<RequestOverrides>({});

  const startRequest = () => {
    if (!title) return;
    if (choosable) setChoosing(true);
    else void request(title, null, overrides);
  };

  /*
    Asking for one episode, which is a different operation from asking for the title.

    It is only offered for a series Sonarr ALREADY holds -- `episodeState` is empty
    otherwise, so every row is `unknown` and no button is drawn. That is the boundary
    between this and the Request button above, which refuses a title already in the
    library. The two do not overlap and neither replaces the other.

    Optimism lives on the server: the mirror is marked monitored the moment Sonarr accepts,
    and the next poll of this page carries it. So there is no local copy of "I clicked
    this" here to disagree with what Sonarr actually did.
  */
  const requestEpisode = (season: number, episode: number) => {
    if (!title) return;
    const label = `S${season}E${episode}`;
    const id = toasts.push(`Requesting ${title.title} ${label}`);
    void postEpisodeRequest(title.tconst, season, episode)
      .then(() => toasts.resolve(id, "success", `Sonarr is looking for ${label}`))
      .catch((e: Error) => toasts.resolve(id, "error", e.message));
  };

  /*
    The same operation one grain up, and the same optimism rule: no local copy of what was
    clicked, because the mirror is the record.

    The COUNT in the success line is the server's, not the button's. The button was drawn
    from a summary of a mirror that may have moved since -- an episode can have landed
    between the render and the click -- and reporting what was actually queued is the only
    number that is true when it is read.
  */
  const requestSeason = (season: number) => {
    if (!title) return;
    const label = `Season ${season}`;
    const id = toasts.push(`Requesting ${title.title} ${label}`);
    void postSeasonRequest(title.tconst, season)
      .then(({ episodes }) =>
        toasts.resolve(
          id,
          "success",
          `Sonarr is looking for ${episodes} episode${episodes === 1 ? "" : "s"} of ${label}`,
        ),
      )
      .catch((e: Error) => toasts.resolve(id, "error", e.message));
  };

  const requestKey = useKeyAction("request", startRequest, canRequest);
  const backKey = useKeyAction("back", () => router.history.back(), canGoBack);

  if (error && !title) {
    return (
      <div className="rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-sm">
        {error}{" "}
        <Link to="/" search={{}} className="underline">
          Back to search
        </Link>
      </div>
    );
  }

  // No spinner: the local half is a SQLite round trip on the LAN and lands in a few
  // milliseconds, and arriving from search means we already hold the row. A spinner
  // would flash and be gone before it was read -- and a global one over a page that is
  // 80% ready is a lie about what we know.
  if (!title) return null;

  const genres = title.genres ? title.genres.split(",").filter(Boolean) : [];

  return (
    <>
      {/*
        history.back() rather than a link to "/": it returns to the exact results the
        user came from, facets and scroll position intact, which a fresh "/" cannot do.
        Deep-linked visitors have no history to pop, so they get a plain link instead
        of a button that would throw them out of the app.
      */}
      {canGoBack ? (
        <button
          type="button"
          onClick={() => router.history.back()}
          {...backKey.props}
          className="mb-4 text-sm text-muted hover:text-ink"
        >
          ← Back to results
          {backKey.hint}
        </button>
      ) : (
        <Link to="/" search={{}} className="mb-4 block text-sm text-muted hover:text-ink">
          ← Search
        </Link>
      )}

      {/*
        Two columns from `sm` up: a sticky rail (poster + the facts card) and the reading
        column. `items-start` is what lets the rail be sticky -- a stretched grid cell is
        as tall as the page and never has anywhere to stick.
      */}
      <article className="sm:grid sm:grid-cols-[16rem_minmax(0,1fr)] sm:items-start sm:gap-8">
        <aside className="hidden sm:sticky sm:top-4 sm:block">
          {/* `eager`: the largest thing above the fold, and the one poster in the product
              where deferring the fetch is visibly worse than paying for it. */}
          <Poster
            title={title}
            fallback="label"
            eager
            className="aspect-2/3 w-full overflow-hidden rounded-xl border border-line bg-surface"
          />
          <TitleFactsCard
            facets={facets}
            working={working}
            problems={problems}
            terms={terms}
            className="mt-4"
          />
        </aside>

        <div className="min-w-0">
          {/*
            On a phone the poster is a thumbnail BESIDE the title rather than a full-width
            image above it -- the old stack put a screenful of artwork between the reader
            and the name they tapped. The rail poster and this thumb are one component in
            two mounts; breakpoints show exactly one.
          */}
          <div className="flex gap-4">
            <div className="w-24 shrink-0 sm:hidden">
              <Poster
                title={title}
                fallback="label"
                className="aspect-2/3 w-full overflow-hidden rounded-xl border border-line bg-surface"
              />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                <span className="rounded bg-surface-2 px-1.5 py-0.5 uppercase tracking-wide">
                  {KIND_LABEL[title.kind] ?? title.kind}
                </span>
                {/*
              The year and its decade are exits, not captions: `/browse` has served
              both filters since v0 and nothing ever linked them, so the page had one
              way out (genre) where it could have three.
            */}
                {title.year && (
                  <>
                    <BrowseChip filters={{ year: title.year, kind: title.kind }} label={String(title.year)} />
                    <BrowseChip
                      filters={{ decade: decadeOf(title.year), kind: title.kind }}
                      label={`${decadeOf(title.year)}s`}
                    />
                  </>
                )}
                {title.runtime && <span>{runtimeLabel(title.runtime)}</span>}
                {/*
                  The studio badge has RENDERED since the logo import and has been inert
                  ever since -- a mark with nothing behind it. It is a link now, on the same
                  dead-end rule every other term follows: it goes somewhere once we hold
                  more than this one film from that studio, and stays a badge otherwise.
                */}
                <StudioBadge title={title} term={studioTerm} />
              </div>

              <h2 className="mt-2 text-2xl font-semibold tracking-tight">{title.title}</h2>

              {/* Often the name a non-English speaker actually searched for. */}
              {title.orig && title.orig !== title.title && (
                <p className="mt-1 text-sm text-muted italic">{title.orig}</p>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
                {title.rating > 0 && (
                  <span className="tabular-nums">
                    ★ {title.rating.toFixed(1)}
                    <span className="ml-1 text-muted">({formatVotes(title.votes)} votes)</span>
                  </span>
                )}
              </div>
            </div>
          </div>

          {genres.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {/* A real destination, not decoration. */}
              {genres.map((g) => (
                <BrowseChip key={g} filters={{ genre: g, kind: title.kind }} label={g} />
              ))}
            </div>
          )}

          <div className="mt-6 max-w-xs">
            {title.plex ? (
              <PlayOnPlex plex={title.plex} />
            ) : title.inLibrary ? (
              <span className="block rounded-lg border border-line px-3 py-2 text-center text-sm text-muted">
                {title.hasFile ? "Available in your library" : "Monitored, not downloaded"}
                {title.progress !== null && title.progress > 0 && title.progress < 1 && (
                  <span className="ml-1 tabular-nums">({Math.round(title.progress * 100)}%)</span>
                )}
              </span>
            ) : title.requestVerdict ? (
              /*
                The one screen with room for the whole answer: what state the request is in,
                how far along the download is, and one honest sentence about why it is
                taking as long as it is. The grid gets the short form of the same fact from
                `RequestAction`, off the same `VERDICT_COPY` table.
              */
              <RequestVerdictPanel state={title} error={title.requestError} />
            ) : (
              <button
                type="button"
                onClick={startRequest}
                {...requestKey.props}
                className="w-full rounded-lg bg-accent px-3 py-2 text-sm font-medium text-black
                         transition-opacity hover:opacity-90 active:opacity-75"
              >
                {/*
                  The label changes when the chooser becomes available, so the button
                  never promises to queue and then opens a dialog instead. It is a text
                  swap inside a fixed-width button: no reflow, which is what the header
                  rule is protecting.
                */}
                {choosable
                  ? "Choose seasons"
                  : `Request from ${title.service === "sonarr" ? "Sonarr" : "Radarr"}`}
                {requestKey.hint}
              </button>
            )}

            {/*
              Under the button and never inside the header block: it loads its lists on
              first open, so it is one more thing that arrives late, and the header rule
              exists precisely so nothing arriving late can shove the page.
            */}
            {canRequest && isAdmin && (
              <RequestOptions service={title.service} value={overrides} onChange={setOverrides} />
            )}

            {/*
              The one link on this page that leaves for a machine rather than for a reader.

              `isAdmin` gates whether it is DRAWN and is not the rule -- the server sends
              `arrLink: null` to every non-admin, so there is nothing here to hide. Same
              two-guard shape as `RequestOptions` above, and for the same reason: the cheap
              client check keeps the layout honest while the server check is the wall.

              It arrives with the detail response rather than at t=0, so it lives here
              UNDER the request block and never in the header -- nothing arriving late may
              push the header around, which is the rule this route states about itself.
            */}
            {isAdmin && arrLink && <ArrLinkRow link={arrLink} />}
          </div>

          {/*
            The "tt1375666 on IMDb" line used to sit here: one hard-coded destination,
            wearing an internal id as its label. It is the links row under the synopsis
            now -- IMDb beside every other place this title lives, each called by its name.
          */}

          {/*
            Below the header, never inside it: the header is the local half and is on
            screen at t=0, and nothing arriving late is allowed to push it around. The
            reading-flow panes share the main column; the wide rows follow the grid.
          */}
          <TitleMainPanes title={title} facets={facets} working={working} problems={problems} panes={panes} />
        </div>
      </article>

      {/*
        Rendered outside the header and outside the panes: a native dialog lives in the
        browser's top layer, so where it sits in the tree costs nothing, and keeping it
        out of the header keeps that block purely local.
      */}
      {seasons && (
        <SeasonRequestDialog
          open={choosing}
          seasons={seasons}
          title={title.title}
          onCancel={() => setChoosing(false)}
          onConfirm={(chosen) => {
            setChoosing(false);
            void request(title, chosen, overrides);
          }}
        />
      )}

      <TitleLowerPanes
        title={title}
        facets={facets}
        working={working}
        problems={problems}
        people={people}
        collectionTitles={collectionTitles}
        relatedTitles={relatedTitles}
        panes={panes}
        episodeState={episodeState}
        awards={awards}
        terms={terms}
        onRequestEpisode={requestEpisode}
        onRequestSeason={requestSeason}
      />
    </>
  );
}

/**
 * Who made it -- its mark where the logo importer has one, its name where it does not.
 *
 * The mark and the name are two renderings of ONE fact, so they share a wrapper rather than
 * living in two branches that each decide separately whether to be a link. Nothing at all
 * for a title we hold no studio for, which is most series and every unresolved film.
 */
function StudioBadge({ title, term }: { title: Title; term: Term | undefined }) {
  if (!title.studio) return null;

  const badge = title.studioLogo ? (
    <span className="flex items-center rounded bg-black/55 px-1.5 py-1">
      <img
        src={title.studioLogo}
        alt={title.studio}
        className="h-3.5 w-auto max-w-20 object-contain opacity-90"
      />
    </span>
  ) : (
    <span>{title.studio}</span>
  );

  if (!term || !isTermLinkable(term)) return <span title={title.studio}>{badge}</span>;
  return (
    <Link
      to="/term/$dimension/$value"
      params={{ dimension: "studio", value: term.key }}
      title={`${term.label} -- ${term.titles} titles we hold`}
      className="hover:text-ink"
    >
      {badge}
    </Link>
  );
}

/**
 * "Open in Radarr" / "Open in Sonarr", for an admin.
 *
 * Deliberately the quietest thing in the rail: it is a maintenance door, not part of
 * reading about a title, so it gets `LinksRow`'s treatment rather than a button's. A
 * reader who is also an admin is still, most of the time, reading.
 *
 * `target="_blank"` because the arr is a different application with its own navigation --
 * following it in place would cost the reader this page. `rel` carries `noreferrer` as
 * well as `noopener`: finderr's URL names a title somebody asked for, and the arr has no
 * business being told which page sent an admin to it.
 */
function ArrLinkRow({ link }: { link: NonNullable<TitleDetailView["arrLink"]> }) {
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block text-center text-xs text-muted underline decoration-line underline-offset-2 transition-colors hover:text-ink"
    >
      Open in {link.label}
    </a>
  );
}

/**
 * The poster, or an honest placeholder -- one component for its two mounts (desktop
 * rail, mobile thumbnail), so a restyle cannot drift them apart. The mount decides the
 * width; this only fills it.
 */
// The private `Poster` that used to live here is gone -- `../components/Poster` is the one
// owner now, and this page passes `fallback="label"` to keep the "No artwork" box it always
// had. It also passes `eager`: this is the largest thing above the fold on the page, and
// deferring it is the single case where lazy loading is visibly worse.

/**
 * The action for a title Plex already holds: play it.
 *
 * It takes the primary slot the Request button occupies for everything else, and it
 * OUTRANKS "Available in your library" -- that span was the end of the road for an owned
 * title, telling the reader they had it and then leaving them to go find it themselves.
 * This is the whole reason the Plex mirror exists.
 *
 * Legitimately in the header, and it is worth saying why, because the route's own rule is
 * that a facet-driven element may never go here: this is not facet-driven. `title.plex` is
 * built from the local Plex mirror and arrives with the row at t=0, exactly like
 * `inLibrary`, so it cannot pop in late and push the header around.
 *
 * TWO LINKS, because they fail in opposite directions and neither is safe alone. The web
 * app works on any machine but lands the reader in a browser tab; `plex://` opens the real
 * client and does NOTHING AT ALL when no client is installed to claim the scheme -- no
 * error, no navigation, a dead button. So the web link is the one wearing the weight, and
 * the app link sits under it as an offer.
 *
 * `hasFile` is deliberately not consulted. Plex holding a scanned item IS the stronger
 * statement -- the arr's `hasFile` can be true for a file Plex has not seen yet, and it can
 * be false for something imported outside the arr entirely.
 */
function PlayOnPlex({ plex }: { plex: NonNullable<Title["plex"]> }) {
  return (
    <div className="space-y-1.5">
      <a
        href={plex.web}
        target="_blank"
        rel="noreferrer"
        className="block w-full rounded-lg bg-accent px-3 py-2 text-center text-sm font-medium
                   text-black transition-opacity hover:opacity-90 active:opacity-75"
      >
        Play on Plex
      </a>
      {/*
        No `target`/`rel`: this never navigates the page, it hands the URL to whatever
        registered the `plex:` scheme. Opening it in a tab would leave an empty one behind
        on the machines where it works.
      */}
      <a href={plex.app} className="block text-center text-xs text-muted hover:text-ink">
        Open in the Plex app
      </a>
    </div>
  );
}
