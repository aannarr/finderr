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
import { hasMissingEpisodes, todayUtc } from "../../../src/lib/episodes";
import { isTermLinkable, termKey } from "../../../src/lib/terms";
import { BrowseChip } from "../components/BrowseChip";
import { type KeyAction, useKeyAction } from "../components/Kbd";
import { canPlayHere, PlayHere } from "../components/PlayHere";
import { PlayOnPlex } from "../components/PlayOnPlex";
import { Poster } from "../components/Poster";
import { RequestOptions } from "../components/RequestOptions";
import { RequestVerdictPanel } from "../components/RequestProgress";
import { SaveToWatchlist } from "../components/SaveToWatchlist";
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
import { seriesGap } from "../lib/season-gap";
import { seasonsFromNumbers, summariseSeasons } from "../lib/season-select";
import { useToasts } from "../lib/toasts";
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from "../lib/ui";
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
    episodeScores,
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
    THE SECOND THING THE CHOOSER IS FOR: a series we already hold, with holes in it.

    `canRequest` above is false for anything in the library, which was the end of the road
    for an owned series -- the only way to fill five missing seasons was to open the seasons
    pane and press its per-season button five times. The same dialog answers both questions,
    so this is one more mode on it rather than a second control.

    > [!IMPORTANT] The BUTTON is decided by the mirror; the NUMBERS come from the facet
    > `hasMissingEpisodes` reads `episodeState`, which is our own SQLite and arrives with the
    > local half -- so whether this control exists is settled at the same moment as the rest
    > of the header, and skyhook cannot move it. The gap's per-season counts DO need the
    > `episodes` facet, and they only ever fill in numbers inside a control that is already
    > on screen. That split is what keeps a facet from pushing the header around while still
    > letting the dialog say "85 episodes" rather than "some".
  */
  const episodesFacet = facets?.episodes;
  const seriesEpisodes = episodesFacet?.status === "ready" ? episodesFacet.data : null;
  const today = todayUtc();
  const holed = Boolean(title?.inLibrary && episodeState && hasMissingEpisodes(episodeState, today));
  /*
    Computed here as well as in `SeriesPane`, from the same pure function over the same
    inputs -- not copied. `seriesGap` is the single owner of the rule, and two calls to it
    cannot disagree the way two spellings of it would.
  */
  const gap =
    holed && seasons && seriesEpisodes ? seriesGap(seasons, seriesEpisodes, episodeState, today) : [];
  const chooserSeasons =
    seasons ?? (holed && episodeState ? seasonsFromNumbers(episodeState.map((e) => e.season)) : null);

  /*
    Arr settings for this one request, ADMIN ONLY.

    Held here rather than inside `RequestOptions` because the Request button is what sends
    them and the button is not inside the panel -- the panel sits under it. An empty object
    is the resting state and is what every non-admin sends, because `postRequest` omits an
    unset field entirely rather than sending null (see `requestBody`), and the server
    REFUSES a non-admin who sends any of the three.
  */
  const [overrides, setOverrides] = useState<RequestOverrides>({});

  /** True whenever the chooser is open over a series we already hold. */
  const filling = holed;

  const startRequest = () => {
    if (!title) return;
    if (choosable || filling) setChoosing(true);
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
  const requestSeasons = (chosen: readonly number[]) => {
    if (!title) return;
    const label = summariseSeasons(chosen);
    const id = toasts.push(`Requesting ${title.title} ${label}`);
    void postSeasonRequest(title.tconst, chosen)
      .then(({ episodes, seasons: filled }) =>
        toasts.resolve(
          id,
          "success",
          // BOTH numbers are the server's. The button was drawn from a mirror that may have
          // moved since, and the seasons that turned out to have a hole are not always the
          // ones asked for -- a reader who ticked a complete season should not be told it
          // was fetched.
          `Sonarr is looking for ${episodes} episode${episodes === 1 ? "" : "s"} of ${summariseSeasons(filled)}`,
        ),
      )
      .catch((e: Error) => toasts.resolve(id, "error", e.message));
  };

  /** The season header's own button, which is this operation with a list of one. */
  const requestSeason = (season: number) => requestSeasons([season]);

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
            <PrimaryAction
              title={title}
              isAdmin={isAdmin}
              choosable={choosable}
              onRequest={startRequest}
              requestKey={requestKey}
            />

            {/*
              Plex, DEMOTED -- and drawn here rather than inside `PrimaryAction` because at
              this point both offers are true at once: Plex plays it on the reader's TV with
              their history and their subtitles, "Play here" plays it in the tab that is
              already open. Only one of them can have the accent, and the reader who is
              already looking at a browser is the one this control is for.

              Nothing is lost when `PrimaryAction` took the Plex branch instead: this draws
              only when Play won the slot.
            */}
            {canPlayHere(title, isAdmin) && title.plex && <PlayOnPlex plex={title.plex} variant="quiet" />}

            {/*
              A series we hold with holes in it: the SAME chooser, under whichever control
              said we have it.

              It sits beside Play rather than replacing it, because both are true at once --
              you can watch season 1 tonight and ask for 3 to 7 at the same time. Whether it
              is drawn is decided by the episode mirror, which is local, so this cannot pop
              in behind a provider; see the note beside `holed` above.
            */}
            {filling && (
              <button type="button" onClick={startRequest} className={`mt-2 ${SECONDARY_BUTTON}`}>
                Request missing seasons
              </button>
            )}

            {/*
              KEEPING A NOTE OF IT, under whichever of the controls above was drawn.

              Offered for every title, including one already in the library and one already
              requested: "I want to watch this" and "we hold this" are different facts, and a
              list you keep is the only one of the two that is yours. It downloads nothing --
              see `SaveToWatchlist` -- which is exactly why it can sit under the request
              button without competing with it.
            */}
            <SaveToWatchlist title={title} tone="block" />

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
      {chooserSeasons && (
        <SeasonRequestDialog
          open={choosing}
          seasons={chooserSeasons}
          title={title.title}
          gap={filling ? gap : undefined}
          onCancel={() => setChoosing(false)}
          onConfirm={(chosen) => {
            setChoosing(false);
            if (filling) requestSeasons(chosen);
            else void request(title, chosen, overrides);
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
        episodeScores={episodeScores}
        awards={awards}
        terms={terms}
        onRequestEpisode={requestEpisode}
        onRequestSeason={requestSeason}
      />
    </>
  );
}

/**
 * The ONE thing to press for this title, in the header's one primary slot.
 *
 * A LADDER, read top to bottom, and the order is the whole of what this component knows.
 * Written as early returns rather than a chain of ternaries because a reader needs to be
 * able to answer "what does an owned film show?" by scanning six lines, and because the next
 * state to appear is a line here rather than another nesting level.
 *
 * Every input rides the local `/api/title/:tconst` row or the session, so this block is
 * settled at t=0 and nothing arriving later can change which branch won -- that is the
 * header rule this route states about itself, and it is why no facet may be consulted here.
 *
 * Exported for its test: it is the only part of this route that renders from props alone.
 */
export function PrimaryAction({
  title,
  isAdmin,
  choosable,
  onRequest,
  requestKey,
}: {
  title: Title;
  isAdmin: boolean;
  /** The seasons facet has landed, so Request opens a chooser instead of queueing. */
  choosable: boolean;
  onRequest: () => void;
  requestKey: KeyAction;
}) {
  /*
    PLAY IS THE DEFAULT for a title we hold and this reader may stream.

    A muted "Available in your library" span used to own this slot for an owned title: a
    fact, with no action, while the control that acted on it sat underneath in a border and
    grey text. The fact is implied by the button, so the span is gone rather than moved.

    `canPlayHere` rather than `title.hasFile` alone, because `PlayHere` draws nothing for a
    non-admin -- asking it here is what keeps the slot from silently collapsing to an empty
    box for everybody else. They fall through to the branches below.
  */
  if (canPlayHere(title, isAdmin)) return <PlayHere tconst={title.tconst} isAdmin={isAdmin} />;

  /*
    Plex, for the reader who cannot play it here: no file the arr will admit to, or no
    permission to stream one. It is the same offer that sits UNDER Play when both are
    available -- see the route -- and it is legitimately in the header for the reason the
    rule cares about: `title.plex` is built from the local Plex mirror and arrives with the
    row at t=0, exactly like `inLibrary`, so it cannot pop in late and push anything around.
  */
  if (title.plex) return <PlayOnPlex plex={title.plex} />;

  /*
    We hold it, and this reader cannot start it from here -- the honest end of the road. Not
    reachable for an admin, who got the Play button four lines up.
  */
  if (title.hasFile) {
    return (
      <span className="block rounded-lg border border-line px-3 py-2 text-center text-sm text-muted">
        Available in your library
      </span>
    );
  }

  /*
    The one screen with room for the whole answer: what state the request is in, how far
    along the download is, and one honest sentence about why it is taking as long as it is.
    The grid gets the short form of the same fact from `RequestAction`, off the same
    `VERDICT_COPY` table.

    It sits ABOVE the monitored span rather than below it, and `RequestAction` carries the
    argument: a bare library row means only that the arr is watching, so it must not shadow
    a verdict about an ask somebody actually made.
  */
  if (title.requestVerdict) return <RequestVerdictPanel state={title} error={title.requestError} />;

  /*
    Monitored, nobody asked here. Same amber as a working verdict, same reason as the card's
    chip -- and the percentage stays, because `progress` is the arr's own download figure off
    the library mirror rather than anything a request diagnostic supplies, so it is the only
    thing this branch can report.
  */
  if (title.inLibrary) {
    return (
      <span className="block rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-center text-sm text-ink">
        Monitored, not downloaded
        {title.progress !== null && title.progress > 0 && title.progress < 1 && (
          <span className="ml-1 tabular-nums">({Math.round(title.progress * 100)}%)</span>
        )}
      </span>
    );
  }

  return (
    <button type="button" onClick={onRequest} {...requestKey.props} className={PRIMARY_BUTTON}>
      {/*
        The label changes when the chooser becomes available, so the button never promises to
        queue and then opens a dialog instead. It is a text swap inside a fixed-width button:
        no reflow, which is what the header rule is protecting.
      */}
      {choosable ? "Choose seasons" : `Request from ${title.service === "sonarr" ? "Sonarr" : "Radarr"}`}
      {requestKey.hint}
    </button>
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
