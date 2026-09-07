/**
 * The series pane: what we hold of this show, a season selector, and the chosen season's
 * episodes under it.
 *
 * TWO facets, not one. `seasons` draws the selector, `episodes` draws the table, and the
 * two resolve independently -- so the selector appears the moment seasons land and the
 * episode half carries its own skeleton until episodes do. Gating either on the other
 * would hide a selector we already hold.
 *
 * The three-state rule is not re-decided here. The pane frame is `FacetPane`, and the
 * episode half asks `paneView()` directly, which is the same owner minus the section
 * chrome: an episode table is the BODY of the seasons pane, not a second pane. The
 * series-only rule is not re-decided either -- `seasons` is declared `entities: ["series"]`
 * in `src/lib/facets.ts`, so a film simply has no such facet and this whole pane hides
 * itself. No kind check belongs here.
 *
 * Air dates are the reason this screen exists: they are the fact Seerr makes you wait
 * for, and everything else on a row is context around them.
 *
 * The season-gap line at the top is the same information as the dots on the rows, rolled
 * up -- "get me the rest of this show" is the request people actually make, and answering
 * it a dot at a time across nine seasons is not answering it. It lives HERE rather than in
 * a pane of its own because this pane already owns season state and a second owner of it
 * would be a second thing to keep in step. `../lib/season-gap` does the counting.
 */

import { type ReactNode, useState } from "react";
import { type EpisodeStanding, episodeStanding, todayUtc } from "../../../src/lib/episodes";
import type { EpisodeState } from "../lib/api";
import { bandFor, type EpisodeScore, scoreIndex } from "../lib/episode-scores";
import {
  adjacentSeasonNumber,
  defaultSeasonNumber,
  episodeLabel,
  episodeSkeletonRows,
  episodeStateIndex,
  episodesForSeason,
  formatCalendarDate,
  localImageUrl,
  orderSeasons,
  type PaneView,
  paneView,
  seasonAirRange,
  seasonLabel,
} from "../lib/facet-panes";
import type { Episode, FacetName, FacetProblem, ResolvedFacets, Season } from "../lib/facets";
import { type SeasonGap, seriesGap, summariseSeriesGap } from "../lib/season-gap";
import { ToggleChip } from "./Chip";
import {
  EpisodeCard,
  GridSkeleton,
  GridView,
  Legend,
  ScoreBadge,
  TimelineView,
  useHoverCard,
} from "./EpisodeScores";
import { FacetPane, type PaneVariant, ProblemNote, Skeleton, SkeletonRepeat } from "./FacetPane";
import { mergeKeyProps, useKeyAction } from "./Kbd";
import { useChipGroup } from "./RovingFocus";

export interface SeriesPaneProps {
  facets: ResolvedFacets | undefined;
  working: readonly FacetName[] | undefined;
  /** Who failed on this title. Passed to `paneView` for both halves; see `FacetPaneProps`. */
  problems?: readonly FacetProblem[];
  /** Layout's call, passed through to the pane chrome -- the title page mounts this as a panel. */
  variant?: PaneVariant;
  /**
   * Our own Sonarr's per-episode state. Absent or empty means Sonarr does not hold this
   * series, and every row then draws exactly as it did before this existed.
   */
  episodeState?: readonly EpisodeState[];
  /** Ask Sonarr for one episode. Absent means the control is not offered at all. */
  onRequestEpisode?: (season: number, episode: number) => void;
  /** Ask Sonarr for the rest of one season. Absent means the control is not offered at all. */
  onRequestSeason?: (season: number) => void;
  /**
   * What the world scored each episode, from our own index.
   *
   * Undefined or empty is ordinary and everything still draws: the Grid and Timeline tabs
   * render from the skeleton with no numbers, and the episode rows simply carry no badge.
   * That is the path an index built before the episode stage takes.
   */
  scores?: readonly EpisodeScore[];
  /**
   * Which tab opens first. Grid, unless a caller says otherwise.
   *
   * Seeded rather than forced: it sets the INITIAL value and the reader still owns the
   * choice from the first click. It exists because the tab a panel opens on is a product
   * decision that has already changed once, and because a server-rendered test has no way
   * to press a chip -- the season browser's own assertions live behind the Episodes tab.
   */
  initialTab?: TabName;
}

export function SeriesPane({
  facets,
  working,
  problems,
  variant,
  episodeState,
  onRequestEpisode,
  onRequestSeason,
  scores,
  initialTab,
}: SeriesPaneProps) {
  return (
    <FacetPane
      facets={facets}
      working={working}
      problems={problems}
      facet="seasons"
      heading="Seasons"
      variant={variant}
      skeleton={<SeasonBrowserSkeleton />}
      render={(seasons: Season[]) => (
        <SeasonBrowser
          seasons={seasons}
          facets={facets}
          working={working}
          problems={problems}
          episodeState={episodeState}
          onRequestEpisode={onRequestEpisode}
          onRequestSeason={onRequestSeason}
          scores={scores}
          initialTab={initialTab}
        />
      )}
    />
  );
}

/**
 * ONE panel, three tabs, and that is aannarr's call of 2026-09-05: "merge these..
 * seasons/scores .. tabs!.. not two panels!"
 *
 * The scores began as a second panel stacked under this one, which put two season
 * selectors and two episode lists on one page describing the same rows. They are one
 * subject -- the episodes of this series -- looked at three ways:
 *
 * - **Grid** (default): every season at once, colour-banded, for the SHAPE of the show.
 * - **Episodes**: one season in full, with air dates, overviews, what Sonarr holds and
 *   what may be asked for -- and now a score badge on each row.
 * - **Timeline**: the trend across the whole run.
 *
 * The Episodes tab is this pane's own list rather than a second one written beside it,
 * which is what the merge bought: a row already carrying a date, a standing mark and a
 * request button gains a number, instead of that number living in a parallel list that
 * knows none of those things.
 */
type TabName = "grid" | "episodes" | "timeline";

const TABS: readonly { name: TabName; label: string }[] = [
  { name: "grid", label: "Grid" },
  { name: "episodes", label: "Episodes" },
  { name: "timeline", label: "Timeline" },
];

// --- the selector and what it selects ---------------------------------------

/**
 * Which season is on screen, and the episodes for it.
 *
 * The chosen season is held here rather than in the URL: it is a view preference inside
 * one title, and putting it in the path would make the back button walk through every
 * season the reader glanced at. The state is validated against the seasons we actually
 * have on every render, so a selection cannot outlive the list it came from.
 */
function SeasonBrowser({
  seasons,
  facets,
  working,
  problems,
  episodeState,
  onRequestEpisode,
  onRequestSeason,
  scores,
  initialTab,
}: {
  seasons: Season[];
  facets: ResolvedFacets | undefined;
  working: readonly FacetName[] | undefined;
  problems: readonly FacetProblem[] | undefined;
  episodeState?: readonly EpisodeState[];
  onRequestEpisode?: (season: number, episode: number) => void;
  onRequestSeason?: (season: number) => void;
  scores?: readonly EpisodeScore[];
  initialTab?: TabName;
}) {
  const [tab, setTab] = useState<TabName>(initialTab ?? "grid");
  const card = useHoverCard();
  const ordered = orderSeasons(seasons);
  const [chosen, setChosen] = useState<number | null>(null);
  const selected = ordered.some((s) => s.number === chosen) ? chosen : defaultSeasonNumber(ordered);
  const season = ordered.find((s) => s.number === selected) ?? null;

  // Asked ONCE for the whole pane, then handed down. The summary above the chips and the
  // dots under them are the same fact at two grains, so they must not be free to disagree
  // -- either about which episodes exist, or about where "today" fell.
  const episodes = paneView(facets, "episodes", working, problems);
  const today = todayUtc();

  // Counted ONCE for the pane, for the same reason `episodes` is fetched once: the sentence
  // above the chips and the button on the season header are the same arithmetic, and two
  // calls would be two chances for the header to offer a number the line does not show.
  const gap = episodes.state === "content" ? seriesGap(ordered, episodes.data, episodeState, today) : [];

  // A single-season show has nothing to step between, so it gets no keys and no glyphs.
  const stepable = ordered.length > 1;
  const step = (direction: 1 | -1) => setChosen(adjacentSeasonNumber(ordered, selected, direction));
  const prevKey = useKeyAction("prevSeason", () => step(-1), stepable);
  const nextKey = useKeyAction("nextSeason", () => step(1), stepable);

  /*
    Nine seasons is nine tab stops, so the row is ONE and ← → move within it.

    `selectionFollowsFocus` because the arrows on this row have ALWAYS switched the season
    outright, through the global `prevSeason`/`nextSeason` bindings above -- so focus moving
    without the season following would be a regression dressed up as a standard. Exactly one
    season is chosen at a time, which is the shape the pattern is for. The group's handler
    runs first and stops the event, so a single → steps once rather than twice; the outcome
    is the one the global key would have produced, with focus where the reader is looking.
  */
  const chips = useChipGroup({ selectionFollowsFocus: true });

  /*
    EVERY STATE IS DRAWN, not only `content`, and that is a fix rather than a flourish.

    This was `episodes.state === "content" && (...)`, so while the skyhook facet was pending
    the legend, the grid and the timeline were absent from the document entirely -- no
    skeleton, no reserved space -- and then popped in under a tab row that had been on
    screen the whole time. `episodes` is `moving` (12h) for a running series, so a cold title
    spends a real second there. Reported by aannarr 2026-09-07 as "that chart does not always
    render", which is exactly what a pane with no pending state looks like.

    `hidden` still draws nothing: a film is served no `episodes` facet at all and must not
    reserve a grid's worth of height for a pane it will never have.
  */
  const scoreViews =
    episodes.state === "skeleton" ? (
      <GridSkeleton />
    ) : episodes.state === "problem" ? (
      <ProblemNote problems={episodes.problems} />
    ) : (
      episodes.state === "content" && (
        <>
          <Legend />
          {tab === "grid" && (
            <GridView seasons={ordered} episodes={episodes.data} scores={scores} card={card} />
          )}
          {tab === "timeline" && (
            <TimelineView seasons={ordered} episodes={episodes.data} scores={scores} card={card} />
          )}
        </>
      )
    );

  return (
    <>
      {/*
        The tab row comes FIRST, above the standing line and the season chips, because it
        chooses which of the two controls below it even applies: the chips belong to the
        Episodes tab and nothing else. Same `ToggleChip` as everywhere -- these narrow the
        view under them without navigating, which is exactly what that control is for.
      */}
      <div role="tablist" aria-label="Episode views" className="mb-3 flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <ToggleChip key={t.name} label={t.label} active={tab === t.name} onClick={() => setTab(t.name)} />
        ))}
      </div>

      {tab !== "episodes" && (
        <div className="flex flex-col gap-3">
          {scoreViews}
          <EpisodeCard state={card.state} />
        </div>
      )}

      {tab === "episodes" && (
        <>
          <SeasonStandingLine gap={gap} />

          {/*
        A named group, which this row did NOT have before the arrow keys.

        Each chip still carries its own name ("Season 1 · Winter is Coming") and its own
        `aria-pressed`, so the group is not there to name them. It is there because ← and →
        act on the SET rather than on any one chip, and `aria-keyshortcuts` has to hang off
        the thing the keys drive. Both arrows land on this one element, which is why they
        go through `mergeKeyProps` -- ARIA takes a space-separated list and two spreads
        would silently keep only the last.
      */}
          {/* biome-ignore lint/a11y/useSemanticElements: the rule's suggested <fieldset> is for form
          fields, and brings a `min-inline-size: min-content` that fights this row's horizontal
          overflow. These are toggle buttons, and `role="group"` is the ARIA that describes them. */}
          <div
            role="group"
            aria-label="Seasons"
            ref={chips.ref}
            onKeyDown={chips.onKeyDown}
            {...mergeKeyProps(prevKey, nextKey)}
            className="flex gap-1.5"
          >
            {/*
          The keys sit OUTSIDE the scrolling row, before it. Nine seasons overflow the
          width, so a hint at the end of the chips is off-screen until you have already
          scrolled to the last one -- visible exactly when it has nothing left to teach.
        */}
            {prevKey.hint && (
              <span className="flex shrink-0 items-center">
                {prevKey.hint}
                {nextKey.hint}
              </span>
            )}
            <div className="shelf-row flex min-w-0 flex-1 gap-1.5 overflow-x-auto pb-2">
              {ordered.map((s) => (
                <ToggleChip
                  key={s.number}
                  label={seasonLabel(s)}
                  count={s.episodeCount ?? undefined}
                  active={s.number === selected}
                  onClick={() => setChosen(s.number)}
                />
              ))}
            </div>
          </div>

          {season && (
            <SeasonHeader
              season={season}
              gap={gap.find((g) => g.season === season.number) ?? null}
              onRequestSeason={onRequestSeason}
            />
          )}
          {season && (
            <SeasonEpisodes
              season={season}
              episodes={episodes}
              episodeState={episodeState}
              today={today}
              onRequestEpisode={onRequestEpisode}
              scores={scores}
            />
          )}
        </>
      )}
    </>
  );
}

/**
 * "Downloaded: Seasons 1-2 complete, Season 3 missing 4 episodes", or nothing at all.
 *
 * ABOVE the chips, because it is about the series rather than about the season on screen,
 * and a reader deciding whether to ask for the rest of a show should not have to click
 * through nine seasons to find out where the hole is.
 *
 * It draws nothing for a series Sonarr does not hold, which is most of them -- `seriesGap`
 * returns an empty list without `episodeState` and the sentence is then null. Nothing is
 * also the right answer while the `episodes` facet is still landing: an empty gap is what
 * the browser hands down until then, so a summary can never appear saying one thing and
 * then correct itself.
 */
function SeasonStandingLine({ gap }: { gap: readonly SeasonGap[] }) {
  const sentence = summariseSeriesGap(gap);
  if (!sentence) return null;

  return <p className="mb-3 text-xs text-muted">{sentence}</p>;
}

/**
 * The chosen season, named and dated, above its episodes.
 *
 * The poster is drawn only when `localImageUrl` yields a same-origin path, which is never
 * today -- skyhook sends an `artworks.thetvdb.com` URL and the browser is never handed an
 * upstream one. There is no placeholder in its place on purpose: the header reads
 * perfectly without art, and an always-empty grey box would be a permanent apology for a
 * feature that is not here. It starts drawing itself when the facet image proxy lands.
 */
function SeasonHeader({
  season,
  gap,
  onRequestSeason,
}: {
  season: Season;
  gap: SeasonGap | null;
  onRequestSeason?: (season: number) => void;
}) {
  const poster = localImageUrl(season.image);
  const range = seasonAirRange(season);

  return (
    <div className="mt-4 flex items-center gap-3">
      {poster && (
        <img
          src={poster}
          alt=""
          loading="lazy"
          className="aspect-2/3 w-12 shrink-0 rounded border border-line object-cover"
        />
      )}
      <div className="min-w-0">
        <h4 className="text-sm font-medium text-ink">{seasonLabel(season)}</h4>
        {range && <p className="text-xs tabular-nums text-muted">{range}</p>}
      </div>
      <SeasonGapButton gap={gap} onRequest={onRequestSeason && (() => onRequestSeason(season.number))} />
    </div>
  );
}

/**
 * "Request the 4 missing episodes" -- the one click the standing line above has been
 * describing.
 *
 * Drawn ONLY where that line says there is a hole: `partial` is the single holding with
 * anything to fetch, and the count is `SeasonGap.missing` rather than a second tally, so the
 * button can never offer a number the sentence does not show.
 *
 * NOT quiet-until-hover like the per-row button. That one hides because it repeats down 73
 * rows and would be a wall of controls; there is exactly one of these on screen, and it is
 * the answer to the sentence a reader has just read.
 *
 * It re-searches the episodes Sonarr is already looking for, and the tooltip says so. The
 * alternative -- fetching only the unmonitored ones -- would mean a button reading "4" that
 * asks for two, and disagreeing with the summary is worse than one redundant indexer search.
 */
function SeasonGapButton({ gap, onRequest }: { gap: SeasonGap | null; onRequest?: () => void }) {
  if (!onRequest || gap?.holding !== "partial") return null;

  const label =
    gap.missing === 1 ? "Request the missing episode" : `Request the ${gap.missing} missing episodes`;

  return (
    <button
      type="button"
      onClick={onRequest}
      title="Sonarr will search for every aired episode of this season it has no file for, including any it is already looking for."
      className="ml-auto shrink-0 rounded border border-line px-2 py-1 text-xs text-muted transition hover:border-ink hover:text-ink"
    >
      {label}
    </button>
  );
}

/**
 * The chosen season's episodes, or placeholders for them.
 *
 * Both facets come out of one skyhook document, so in practice they resolve together and
 * this skeleton is near-unreachable. It is still here because the two facets are declared
 * independent and a later provider is free to serve only one of them -- and because a
 * selector sitting above nothing, with no explanation, reads as broken.
 *
 * The `episodes` view arrives as a prop rather than being asked for here: the summary line
 * above the chips reads the same facet, and two `paneView` calls would be two chances to
 * disagree about what this pane is drawing.
 */
function SeasonEpisodes({
  season,
  episodes: view,
  episodeState,
  today,
  onRequestEpisode,
  scores,
}: {
  season: Season;
  episodes: PaneView<"episodes">;
  episodeState?: readonly EpisodeState[];
  today: string;
  onRequestEpisode?: (season: number, episode: number) => void;
  scores?: readonly EpisodeScore[];
}) {
  if (view.state === "hidden") return null;

  // The seasons half answered and the episodes half did not. Saying so beats a selector
  // sitting above nothing -- the same reason the skeleton below exists, one state along.
  if (view.state === "problem") return <ProblemNote problems={view.problems} />;

  // Said out loud, because the pane's own `aria-busy` is already false by now: the
  // seasons half resolved, and only the episodes under it are still outstanding.
  if (view.state === "skeleton") {
    return (
      <EpisodeRows busy>
        <SkeletonRepeat count={episodeSkeletonRows(season)}>
          <EpisodeRowSkeleton />
        </SkeletonRepeat>
      </EpisodeRows>
    );
  }

  const episodes = episodesForSeason(view.data, season.number);
  if (episodes.length === 0) return null;

  // Built once for the season rather than looked up per row: the same reason `state` is.
  const byPair = scoreIndex(scores);

  // Built once per season rather than per row: `episodeState` is the whole series, and a
  // find() per row is quadratic on a show with 73 of them.
  const state = episodeStateIndex(episodeState);

  return (
    <EpisodeRows>
      {episodes.map((episode) => (
        <EpisodeRow
          key={episode.number}
          episode={episode}
          standing={episodeStanding(state.get(`${episode.season}:${episode.number}`), today)}
          onRequest={onRequestEpisode}
          score={byPair.get(`${episode.season}:${episode.number}`) ?? null}
        />
      ))}
    </EpisodeRows>
  );
}

/** The list frame, shared by the real rows and their placeholders so the two align. */
function EpisodeRows({ children, busy }: { children: ReactNode; busy?: boolean }) {
  return (
    <ol className="mt-3" aria-busy={busy}>
      {children}
    </ol>
  );
}

/** One row's frame, so a placeholder cannot be a different height from the real thing. */
// `group/episode` is NAMED rather than bare: the request button reveals on hover of ITS OWN
// row, and an unnamed group would be claimed by whichever ancestor is nearest -- on a 73-row
// season, hovering the list would light up every button in it.
const EPISODE_ROW_CLASS = "group/episode flex gap-3 border-t border-line py-2.5 first:border-t-0";
const EPISODE_NUMBER_CLASS = "w-7 shrink-0 text-right text-sm tabular-nums text-muted";

function EpisodeRow({
  episode,
  standing,
  onRequest,
  score,
}: {
  episode: Episode;
  standing: EpisodeStanding;
  onRequest?: (season: number, episode: number) => void;
  /** Null for an unrated or unaired episode, which draws no badge at all. */
  score?: { rating: number | null; votes: number } | null;
}) {
  return (
    <li className={EPISODE_ROW_CLASS}>
      <span className={EPISODE_NUMBER_CLASS}>{episode.number}</span>
      {/*
        The score sits between the number and the name, in the same colours the grid uses,
        so a reader who has just come from the Grid tab recognises it without a legend.
        An episode nobody has rated draws nothing rather than a placeholder -- a row is
        about the episode, and a missing number should not take a column's width.
      */}
      {score?.rating != null && (
        <ScoreBadge
          episode={{
            season: episode.season,
            number: episode.number,
            label: episodeLabel(episode),
            airDate: episode.airDate,
            rating: score.rating,
            votes: score.votes,
            band: bandFor(score.rating),
            image: episode.image,
            overview: episode.overview,
          }}
          className="h-fit shrink-0 px-1.5 py-0.5 text-xs"
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-medium text-ink">{episodeLabel(episode)}</span>
          {episode.airDate && (
            <time dateTime={episode.airDate} className="text-xs tabular-nums text-muted">
              {formatCalendarDate(episode.airDate)}
            </time>
          )}
        </div>
        {/*
          Two lines, not the whole synopsis: 73 episodes of full overview is a page nobody
          scrolls, and the row exists to carry the number, the name and the date.
        */}
        {episode.overview && (
          <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted">{episode.overview}</p>
        )}
      </div>
      <EpisodeStandingMark
        standing={standing}
        onRequest={onRequest && (() => onRequest(episode.season, episode.number))}
      />
    </li>
  );
}

/**
 * What one row says about whether we hold this episode.
 *
 * > [!IMPORTANT] SUBTLE, and it draws NOTHING for the two states that are not news
 * > aannarr asked for subtle, and the way to be subtle over 73 rows is to say less rather
 * > than to say it more quietly. `unknown` (Sonarr does not list it, or it has not aired)
 * > draws nothing at all, and the mark for `owned` is a small dot rather than a word --
 * > the column reads at a glance as a pattern of what you have, which is the question, and
 * > a row of the word "Downloaded" would be louder than the episode titles it sits beside.
 *
 * The only state with a control is `missing`, and the control is deliberately quiet until
 * the row is hovered or the button is focused. It is always in the accessibility tree and
 * always reachable by keyboard -- `opacity` hides it from the eye and from nothing else --
 * so it is not one of those buttons only a mouse can find.
 */
function EpisodeStandingMark({ standing, onRequest }: { standing: EpisodeStanding; onRequest?: () => void }) {
  if (standing === "unknown") return null;

  if (standing === "owned") {
    return (
      <span className="flex w-16 shrink-0 items-center justify-end pt-0.5" title="In your library">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-emerald-500/80" />
        <span className="sr-only">In your library</span>
      </span>
    );
  }

  if (standing === "wanted") {
    return (
      <span className="flex w-16 shrink-0 items-center justify-end pt-0.5" title="Sonarr is looking for this">
        <span aria-hidden="true" className="size-1.5 rounded-full border border-muted" />
        <span className="sr-only">Searching</span>
      </span>
    );
  }

  // `missing`, and no handler -- nothing to offer, so the column stays empty rather than
  // drawing a disabled control that explains nothing.
  if (!onRequest) return null;

  return (
    <span className="flex w-16 shrink-0 items-start justify-end">
      <button
        type="button"
        onClick={onRequest}
        className="rounded border border-line px-1.5 py-0.5 text-[11px] text-muted opacity-0 transition hover:border-ink hover:text-ink focus-visible:opacity-100 group-hover/episode:opacity-100"
      >
        Request
      </button>
    </span>
  );
}

function EpisodeRowSkeleton() {
  return (
    <li className={EPISODE_ROW_CLASS}>
      <Skeleton className={`${EPISODE_NUMBER_CLASS} h-4`} />
      <div className="min-w-0 flex-1">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="mt-1.5 h-3 w-full" />
        <Skeleton className="mt-1 h-3 w-5/6" />
      </div>
    </li>
  );
}

/**
 * The pane before anything has landed: a row of chips and the rows they would reveal.
 *
 * Sized to a typical season rather than to the one being loaded, because at this point we
 * do not yet know how many seasons there are, let alone how long one is.
 */
function SeasonBrowserSkeleton() {
  return (
    <>
      <div className="flex gap-1.5">
        <SkeletonRepeat count={5}>
          <Skeleton className="h-6 w-28 rounded-full" />
        </SkeletonRepeat>
      </div>
      <EpisodeRows>
        <SkeletonRepeat count={episodeSkeletonRows(null)}>
          <EpisodeRowSkeleton />
        </SkeletonRepeat>
      </EpisodeRows>
    </>
  );
}
