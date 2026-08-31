/**
 * The series pane: a season selector, and the chosen season's episodes under it.
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
 */

import { type ReactNode, useState } from "react";
import {
  adjacentSeasonNumber,
  defaultSeasonNumber,
  episodeLabel,
  episodeSkeletonRows,
  episodesForSeason,
  formatCalendarDate,
  localImageUrl,
  orderSeasons,
  paneView,
  seasonAirRange,
  seasonLabel,
} from "../lib/facet-panes";
import type { Episode, FacetName, ResolvedFacets, Season } from "../lib/facets";
import { ToggleChip } from "./Chip";
import { FacetPane, type PaneVariant, Skeleton, SkeletonRepeat } from "./FacetPane";
import { mergeKeyProps, useKeyAction } from "./Kbd";

export interface SeriesPaneProps {
  facets: ResolvedFacets | undefined;
  working: readonly FacetName[] | undefined;
  /** Layout's call, passed through to the pane chrome -- the title page mounts this as a panel. */
  variant?: PaneVariant;
}

export function SeriesPane({ facets, working, variant }: SeriesPaneProps) {
  return (
    <FacetPane
      facets={facets}
      working={working}
      facet="seasons"
      heading="Seasons"
      variant={variant}
      skeleton={<SeasonBrowserSkeleton />}
      render={(seasons: Season[]) => <SeasonBrowser seasons={seasons} facets={facets} working={working} />}
    />
  );
}

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
}: {
  seasons: Season[];
  facets: ResolvedFacets | undefined;
  working: readonly FacetName[] | undefined;
}) {
  const ordered = orderSeasons(seasons);
  const [chosen, setChosen] = useState<number | null>(null);
  const selected = ordered.some((s) => s.number === chosen) ? chosen : defaultSeasonNumber(ordered);
  const season = ordered.find((s) => s.number === selected) ?? null;

  // A single-season show has nothing to step between, so it gets no keys and no glyphs.
  const stepable = ordered.length > 1;
  const step = (direction: 1 | -1) => setChosen(adjacentSeasonNumber(ordered, selected, direction));
  const prevKey = useKeyAction("prevSeason", () => step(-1), stepable);
  const nextKey = useKeyAction("nextSeason", () => step(1), stepable);

  return (
    <>
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
      <div role="group" aria-label="Seasons" {...mergeKeyProps(prevKey, nextKey)} className="flex gap-1.5">
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

      {season && <SeasonHeader season={season} />}
      {season && <SeasonEpisodes season={season} facets={facets} working={working} />}
    </>
  );
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
function SeasonHeader({ season }: { season: Season }) {
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
    </div>
  );
}

/**
 * The chosen season's episodes, or placeholders for them.
 *
 * Both facets come out of one skyhook document, so in practice they resolve together and
 * this skeleton is near-unreachable. It is still here because the two facets are declared
 * independent and a later provider is free to serve only one of them -- and because a
 * selector sitting above nothing, with no explanation, reads as broken.
 */
function SeasonEpisodes({
  season,
  facets,
  working,
}: {
  season: Season;
  facets: ResolvedFacets | undefined;
  working: readonly FacetName[] | undefined;
}) {
  const view = paneView(facets, "episodes", working);
  if (view.state === "hidden") return null;

  // Said out loud, because the pane's own `aria-busy` is already false by now: the
  // seasons half resolved, and only the episodes under it are still outstanding.
  if (view.data === undefined) {
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

  return (
    <EpisodeRows>
      {episodes.map((episode) => (
        <EpisodeRow key={episode.number} episode={episode} />
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
const EPISODE_ROW_CLASS = "flex gap-3 border-t border-line py-2.5 first:border-t-0";
const EPISODE_NUMBER_CLASS = "w-7 shrink-0 text-right text-sm tabular-nums text-muted";

function EpisodeRow({ episode }: { episode: Episode }) {
  return (
    <li className={EPISODE_ROW_CLASS}>
      <span className={EPISODE_NUMBER_CLASS}>{episode.number}</span>
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
    </li>
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
